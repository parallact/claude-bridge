import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { debugLog, hashString, newRequestId } from "./debug-logger.js";
import type { BridgeMcpHttpServer, McpTool } from "./mcp-http.js";
import type { PersistentSessionPool } from "./session-pool.js";
import type { ContentBlock } from "./translate.js";
import {
  linesOf,
  parseStream,
  type StreamEventHandlers,
  type StreamToolUse,
} from "./stream-parser.js";

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

// ─── Path D wiring ──────────────────────────────────────────────────────────

interface PathDConfig {
  enabled: boolean;
  mcpServer: BridgeMcpHttpServer;
  sessionPool: PersistentSessionPool;
}

let pathDConfig: PathDConfig | null = null;

export function configurePathD(config: PathDConfig): void {
  pathDConfig = config;
}

export function isPathDEnabled(): boolean {
  return !!(pathDConfig && pathDConfig.enabled);
}

/** Request shape for Path D. Distinct from CLIRequest because the persistent
 *  path handles continuations (tool_result injection) differently. */
export interface PersistentCLIRequest {
  sessionKey: string;
  model: string;
  systemPrompt: string | undefined;
  tools: McpTool[];
  /** Content blocks for the latest user message (text, images, etc).
   *  Empty array when this is a pure continuation. */
  lastUserContent: ContentBlock[];
  /** If present, deliver this tool_result via the bridge MCP before reading
   *  the next checkpoint. Content is content-blocks (preserves structure). */
  pendingToolResult:
    | { toolUseId: string; content: ContentBlock[] }
    | null;
}

function fingerprint(spec: {
  model: string;
  tools: McpTool[];
  systemPrompt: string | undefined;
}): string {
  const hash = createHash("sha256");
  hash.update(spec.model);
  hash.update("\0");
  hash.update(spec.systemPrompt ?? "");
  hash.update("\0");
  const sortedTools = [...spec.tools].sort((a, b) => a.name.localeCompare(b.name));
  for (const t of sortedTools) {
    hash.update(t.name);
    hash.update("\0");
    hash.update(JSON.stringify(t.inputSchema));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Path D entry point. Either sends a fresh user message on a reused
 *  session, or delivers a tool_result to a previously-captured tool_use
 *  and continues reading events. Returns once the CLI emits tool_use
 *  (partial turn — caller must execute the tool and retry) or `result`
 *  (final turn). */
export async function enqueuePersistent(
  request: PersistentCLIRequest,
  handlers?: StreamEventHandlers,
): Promise<CLIResult> {
  if (!pathDConfig || !pathDConfig.enabled) {
    throw new Error("Path D is not enabled");
  }
  const { mcpServer, sessionPool } = pathDConfig;

  // Per-session serialization is still required: two concurrent requests
  // for the same sessionKey would race on the CLI's stream.
  return serializeOnSession(request.sessionKey, async () => {
    await acquireSlot();
    log("info", "PathD queue", { active: inFlight, waiting: waiters.length });
    const requestId = newRequestId();
    debugLog({
      requestId,
      phase: "request",
      path: "pathD",
      sessionKey: request.sessionKey,
      model: request.model,
      systemPromptLen: request.systemPrompt?.length ?? 0,
      systemPromptHash: hashString(request.systemPrompt ?? ""),
      tools: request.tools.map((t) => ({
        name: t.name,
        schemaHash: hashString(JSON.stringify(t.inputSchema)),
      })),
      lastUserContent: request.lastUserContent,
      pendingToolResult: request.pendingToolResult,
    });
    metrics.totalRequests++;
    const startedAt = Date.now();
    try {
      const spec_fp = fingerprint(request);
      const session = sessionPool.acquire(request.sessionKey, {
        model: request.model,
        tools: request.tools,
        systemPrompt: request.systemPrompt,
        spec_fp,
      });

      if (request.pendingToolResult) {
        // Continuation: resolve the parked MCP tools/call, then read events
        // until the next significant checkpoint.
        mcpServer.resolveToolCall(
          request.sessionKey,
          request.pendingToolResult.toolUseId,
          request.pendingToolResult.content,
        );
      } else {
        // Initial: feed the user message to stdin.
        session.sendUserMessage(request.lastUserContent);
      }

      const cp = await session.nextCheckpoint(handlers, poolConfig.timeoutMs);

      // If the stream gave us a tool_use, block briefly until the MCP
      // HTTP POST for it lands in the bridge's pending map. The two
      // signals (stream-json event vs MCP POST) are independent channels
      // and the stream usually wins by a few ms; without this gate, a
      // fast caller round-trips with a tool_result before pending exists
      // and resolveToolCall throws "no pending tool call".
      if (cp.toolUse) {
        await mcpServer.waitForPending(request.sessionKey, cp.toolUse.toolUseId);
      }

      const toolCalls: CLIToolCall[] = cp.toolUse
        ? [
            {
              id: cp.toolUse.toolUseId,
              name: cp.toolUse.name.startsWith("mcp__openclaw__")
                ? cp.toolUse.name.slice("mcp__openclaw__".length)
                : cp.toolUse.name,
              input: cp.toolUse.args,
            },
          ]
        : [];

      const stopReason =
        toolCalls.length > 0 ? "tool_use" : cp.result?.stopReason ?? "end_turn";
      if (cp.result?.isError && toolCalls.length === 0 && !cp.text) {
        throw new Error(`CLI error: ${cp.result.errorMessage ?? "unknown"}`);
      }

      metrics.successes++;
      metrics.latencyMsSum += Date.now() - startedAt;
      metrics.latencyMsCount++;
      debugLog({
        requestId,
        phase: "response",
        path: "pathD",
        stopReason,
        hasToolCalls: toolCalls.length > 0,
        toolCallNames: toolCalls.map((t) => t.name),
        textLen: cp.text.length,
        textPreview: cp.text.slice(0, 500),
        inputTokens: cp.result?.inputTokens ?? 0,
        outputTokens: cp.result?.outputTokens ?? 0,
      });
      return {
        text: cp.text,
        toolCalls,
        inputTokens: cp.result?.inputTokens ?? 0,
        outputTokens: cp.result?.outputTokens ?? 0,
        stopReason,
        sessionId: session.sessionId,
        rateLimitStatus: cp.result?.rateLimitStatus,
      };
    } catch (err) {
      metrics.failures++;
      throw err;
    } finally {
      releaseSlot();
    }
  });
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
// Track every live `claude` child process so graceful shutdown can drain
// in-flight work and kill whatever remains past the drain deadline. Using a
// Set (not a count) because we need actual process refs to kill on timeout.
const activeProcs = new Set<ChildProcess>();

// Per-session serialization. Two concurrent requests on the same sessionKey
// would both spawn `claude --resume <id>` against the same on-disk session,
// and whichever finishes last clobbers the other's work. Chain them instead:
// each request on a session awaits the previous one before proceeding.
// Keyed by sessionKey; the stored Promise resolves when the current holder
// finishes (success or failure). We clean up when the tail matches so the
// map doesn't grow forever.
const sessionTail = new Map<string, Promise<unknown>>();

function serializeOnSession<T>(
  sessionKey: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!sessionKey) return fn();
  const prior = sessionTail.get(sessionKey) ?? Promise.resolve();
  const run = prior.then(
    () => fn(),
    () => fn(), // prior failure shouldn't block us
  );
  sessionTail.set(sessionKey, run);
  const cleanup = () => {
    if (sessionTail.get(sessionKey) === run) sessionTail.delete(sessionKey);
  };
  run.then(cleanup, cleanup);
  return run;
}

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

// ─── Transient-error retry ──────────────────────────────────────────────────

// Conservative: only retry errors we can be confident come from transport
// flakiness (CLI timeout, network reset, 5xx upstream). Logical errors
// (wrong model name, invalid arg) must surface immediately so the caller
// fixes the request instead of hammering the same bad input 3 times.
const TRANSIENT_PATTERNS = [
  /CLI timeout after/i,
  /ECONNRESET/,
  /ETIMEDOUT/,
  /EAI_AGAIN/,
  /socket hang up/i,
  /network\s+error/i,
  /\b5\d{2}\b/, // 500-599 upstream
  /rate.?limit/i,
  /overloaded/i,
];

function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

async function runCLIWithRetry(
  request: CLIRequest,
  handlers?: StreamEventHandlers,
): Promise<CLIResult> {
  const maxAttempts = 3;
  const backoffMs = [500, 1500]; // wait before attempt 2, 3
  let lastErr: unknown;
  // If we've already streamed any bytes to the caller, a retry would emit a
  // second leading assistant turn into the same SSE stream — confusing for
  // the client and arguably worse than just failing. Track a "committed"
  // flag: once any text/tool has hit the handler, retries are off.
  let committed = false;
  const trackedHandlers: StreamEventHandlers | undefined = handlers
    ? {
        onTextDelta: (d) => {
          committed = true;
          handlers.onTextDelta?.(d);
        },
        onToolUse: (t) => {
          committed = true;
          handlers.onToolUse?.(t);
        },
      }
    : undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await runCLI(request, trackedHandlers);
    } catch (err) {
      lastErr = err;
      const canRetry =
        attempt < maxAttempts && !committed && isTransient(err);
      if (!canRetry) throw err;
      metrics.retries++;
      const wait = backoffMs[attempt - 1] ?? 1500;
      log("warn", "CLI transient error, retrying", {
        attempt,
        wait,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr; // unreachable, keeps TS happy
}

export async function enqueueRequest(
  request: CLIRequest,
  handlers?: StreamEventHandlers,
): Promise<CLIResult> {
  // Per-session serialization first, then global concurrency. Order matters:
  // if two requests on session X arrive while a third on session Y runs, Y
  // goes parallel to the first X; the second X waits for the first X to
  // finish before consuming a concurrency slot.
  return serializeOnSession(request.sessionKey, async () => {
    await acquireSlot();
    log("info", "Queue", { active: inFlight, waiting: waiters.length });
    metrics.totalRequests++;
    const startedAt = Date.now();
    try {
      const result = await runCLIWithRetry(request, handlers);
      metrics.successes++;
      metrics.latencyMsSum += Date.now() - startedAt;
      metrics.latencyMsCount++;
      return result;
    } catch (err) {
      metrics.failures++;
      throw err;
    } finally {
      releaseSlot();
    }
  });
}

async function runCLI(
  request: CLIRequest,
  handlers?: StreamEventHandlers,
): Promise<CLIResult> {
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

  const requestId = newRequestId();
  debugLog({
    requestId,
    phase: "request",
    path: "legacy",
    sessionKey: request.sessionKey,
    model: request.model,
    systemPromptLen: request.systemPrompt?.length ?? 0,
    systemPromptHash: hashString(request.systemPrompt ?? ""),
    tools: request.tools.map((t) => ({
      name: t.name,
      schemaHash: hashString(JSON.stringify(t.inputSchema)),
    })),
    prompt: promptToSend,
    isNew,
  });

  const proc = spawn("claude", args, {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  activeProcs.add(proc);
  proc.once("close", () => activeProcs.delete(proc));

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
      parseStream(linesOf(proc.stdout!), handlers),
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

    debugLog({
      requestId,
      phase: "response",
      path: "legacy",
      stopReason,
      hasToolCalls: toolCalls.length > 0,
      toolCallNames: toolCalls.map((t) => t.name),
      textLen: parsed.text.length,
      textPreview: parsed.text.slice(0, 500),
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    });
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

// ─── Metrics ────────────────────────────────────────────────────────────────

const metrics = {
  totalRequests: 0,
  successes: 0,
  failures: 0,
  retries: 0,
  // Latency running sum + count (in ms). Simpler than a histogram and good
  // enough for p50-ish reporting. If we ever care about tail latency we'd
  // plug in a real HDR histogram.
  latencyMsSum: 0,
  latencyMsCount: 0,
  // Start time so /metrics can report uptime.
  startedAtMs: Date.now(),
};

export interface BridgeMetrics {
  uptimeSec: number;
  totalRequests: number;
  successes: number;
  failures: number;
  retries: number;
  avgLatencyMs: number | null;
  inFlight: number;
  waiting: number;
  activeProcesses: number;
  sessions: number;
  sessionTails: number;
}

export function getMetrics(): BridgeMetrics {
  return {
    uptimeSec: Math.round((Date.now() - metrics.startedAtMs) / 1000),
    totalRequests: metrics.totalRequests,
    successes: metrics.successes,
    failures: metrics.failures,
    retries: metrics.retries,
    avgLatencyMs:
      metrics.latencyMsCount === 0
        ? null
        : Math.round(metrics.latencyMsSum / metrics.latencyMsCount),
    inFlight,
    waiting: waiters.length,
    activeProcesses: activeProcs.size,
    sessions: sessions.size,
    sessionTails: sessionTail.size,
  };
}

// ─── Shutdown / Cleanup ─────────────────────────────────────────────────────

/**
 * Drain in-flight CLI requests, then SIGKILL anything still running.
 * Returns once all child processes have exited (or been killed).
 */
export async function drainAndShutdown(timeoutMs = 10_000): Promise<void> {
  if (activeProcs.size === 0) return;
  log("info", "Drain start", { active: activeProcs.size });
  const deadline = Date.now() + timeoutMs;
  while (activeProcs.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (activeProcs.size > 0) {
    log("warn", "Drain timeout — killing remaining", { remaining: activeProcs.size });
    for (const proc of activeProcs) {
      try {
        proc.kill("SIGKILL");
      } catch {}
    }
  } else {
    log("info", "Drain complete");
  }
}

/**
 * Remove stale `bridge-*.json` and `bridge-mcp-*.json` files in os.tmpdir().
 * Normal operation cleans these per-request via mcpCleanup; this handles the
 * crash path where the process exited before cleanup ran.
 */
export function cleanupStaleTempFiles(): void {
  try {
    const tmp = os.tmpdir();
    const entries = fs.readdirSync(tmp);
    let removed = 0;
    for (const name of entries) {
      if (!name.startsWith("bridge-") || !name.endsWith(".json")) continue;
      try {
        fs.unlinkSync(path.join(tmp, name));
        removed++;
      } catch {}
    }
    if (removed > 0) log("info", "Startup tmp cleanup", { removed });
  } catch (err) {
    log("warn", "tmp cleanup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function log(
  level: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
