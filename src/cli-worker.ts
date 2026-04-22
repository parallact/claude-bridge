import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { linesOf, parseStream, type StreamToolUse } from "./stream-parser.js";

const MCP_SERVER_NAME = "openclaw";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_SCRIPT = path.resolve(__dirname, "./mcp-server.js");

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CLIRequest {
  prompt: string;
  lastMessage: string;
  model: string;
  systemPrompt?: string;
  tools: ToolDefinition[];
  sessionKey?: string;
}

export interface CLIToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface CLIResult {
  text: string;
  toolCalls: CLIToolCall[];
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  sessionId: string;
  rateLimitStatus: string | undefined;
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface WorkerPoolConfig {
  timeoutMs: number;
  maxConcurrent: number;
  maxSessions: number;
}

let poolConfig: WorkerPoolConfig = {
  timeoutMs: 300_000,
  maxConcurrent: 8,
  maxSessions: 200,
};

export function configurePool(config: WorkerPoolConfig): void {
  poolConfig = config;
}

// ─── Session Management ─────────────────────────────────────────────────────
// Maps OpenClaw session keys to CLI session UUIDs. LRU-evicted by insertion
// order: touching a key re-inserts it so the Map's iteration order becomes
// least-recently-used first.

const sessions = new Map<string, string>();

function touchSession(sessionKey: string, sessionId: string): void {
  sessions.delete(sessionKey);
  sessions.set(sessionKey, sessionId);
  while (sessions.size > poolConfig.maxSessions) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
}

function getOrCreateSessionId(sessionKey: string | undefined): {
  sessionId: string;
  isNew: boolean;
} {
  if (!sessionKey) {
    return { sessionId: randomUUID(), isNew: true };
  }
  const existing = sessions.get(sessionKey);
  if (existing) {
    touchSession(sessionKey, existing);
    return { sessionId: existing, isNew: false };
  }
  const sessionId = randomUUID();
  touchSession(sessionKey, sessionId);
  return { sessionId, isNew: true };
}

// ─── Concurrency Limiter ────────────────────────────────────────────────────

let inFlight = 0;
const waiters: Array<() => void> = [];

async function acquireSlot(): Promise<void> {
  while (inFlight >= poolConfig.maxConcurrent) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  inFlight++;
}

function releaseSlot(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

// ─── MCP Config ─────────────────────────────────────────────────────────────

interface McpConfigFiles {
  configPath: string;
  cleanup: () => void;
}

function writeMcpConfig(tools: ToolDefinition[]): McpConfigFiles {
  const id = randomUUID();
  const toolsPath = path.join(os.tmpdir(), `bridge-tools-${id}.json`);
  const configPath = path.join(os.tmpdir(), `bridge-mcp-${id}.json`);
  fs.writeFileSync(toolsPath, JSON.stringify(tools));
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          type: "stdio",
          command: "node",
          args: [MCP_SERVER_SCRIPT, toolsPath],
        },
      },
    }),
  );
  return {
    configPath,
    cleanup: () => {
      try {
        fs.unlinkSync(toolsPath);
      } catch {}
      try {
        fs.unlinkSync(configPath);
      } catch {}
    },
  };
}

const MCP_PREFIX = `mcp__${MCP_SERVER_NAME}__`;

function stripMcpPrefix(tu: StreamToolUse): CLIToolCall {
  const name = tu.name.startsWith(MCP_PREFIX)
    ? tu.name.slice(MCP_PREFIX.length)
    : tu.name;
  return { id: tu.id, name, input: tu.input };
}

// ─── Request Execution ──────────────────────────────────────────────────────

export async function enqueueRequest(request: CLIRequest): Promise<CLIResult> {
  await acquireSlot();
  log("info", "Queue", { active: inFlight, waiting: waiters.length });
  try {
    return await runCLI(request);
  } finally {
    releaseSlot();
  }
}

async function runCLI(request: CLIRequest): Promise<CLIResult> {
  const { sessionId, isNew } = getOrCreateSessionId(request.sessionKey);
  const hasTools = request.tools.length > 0;

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    request.model,
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
  ];

  let mcpCleanup: (() => void) | undefined;
  if (hasTools) {
    const mcp = writeMcpConfig(request.tools);
    args.push("--mcp-config", mcp.configPath);
    mcpCleanup = mcp.cleanup;
  } else {
    args.push("--mcp-config", JSON.stringify({ mcpServers: {} }));
  }

  if (isNew) {
    args.push("--session-id", sessionId);
    if (request.systemPrompt) {
      args.push("--system-prompt", request.systemPrompt);
    }
  } else {
    args.push("--resume", sessionId);
  }

  const promptToSend = isNew ? request.prompt : request.lastMessage;

  log("info", "CLI spawn", {
    sessionId: sessionId.slice(0, 8),
    isNew,
    model: request.model,
    toolCount: request.tools.length,
    promptLen: promptToSend.length,
  });

  const proc = spawn("claude", args, {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdin?.write(promptToSend);
  proc.stdin?.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGKILL");
    if (request.sessionKey) sessions.delete(request.sessionKey);
  }, poolConfig.timeoutMs);

  try {
    const [parsed, exitCode, stderrText] = await Promise.all([
      parseStream(linesOf(proc.stdout!)),
      new Promise<number | null>((resolve) =>
        proc.on("close", (code) => resolve(code)),
      ),
      collectStream(proc.stderr!),
    ]);

    if (timedOut) {
      throw new Error(`CLI timeout after ${poolConfig.timeoutMs}ms`);
    }

    const toolCalls = parsed.toolUses.map(stripMcpPrefix);
    const stopReason =
      toolCalls.length > 0 ? "tool_use" : parsed.stopReason;

    if (parsed.isError && toolCalls.length === 0 && !parsed.text) {
      const hint = parsed.errorMessage ?? `exit ${exitCode}`;
      const stderrHint = stderrText.slice(0, 300);
      if (request.sessionKey) sessions.delete(request.sessionKey);
      throw new Error(`CLI error: ${hint}${stderrHint ? ` | stderr: ${stderrHint}` : ""}`);
    }

    if (exitCode !== 0 && toolCalls.length === 0 && !parsed.text) {
      if (request.sessionKey) sessions.delete(request.sessionKey);
      throw new Error(
        `CLI exited ${exitCode}: ${stderrText.slice(0, 500)}`,
      );
    }

    return {
      text: parsed.text,
      toolCalls,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      stopReason,
      sessionId,
      rateLimitStatus: parsed.rateLimitStatus,
    };
  } finally {
    clearTimeout(timer);
    mcpCleanup?.();
  }
}

async function collectStream(
  readable: NodeJS.ReadableStream,
): Promise<string> {
  let data = "";
  for await (const chunk of readable) {
    data += (chunk as Buffer).toString("utf-8");
  }
  return data;
}

function log(
  level: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
