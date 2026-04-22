import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface CLIRequest {
  prompt: string;       // Full conversation (for new sessions)
  lastMessage: string;  // Just the latest user message (for resumed sessions)
  model: string;
  systemPrompt?: string;
  hasTools: boolean;
  sessionKey?: string;  // OpenClaw session identifier (from "user" field)
}

export interface CLIResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
  sessionId: string;
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

function runCLI(request: CLIRequest): Promise<CLIResult> {
  const { sessionId, isNew } = getOrCreateSessionId(request.sessionKey);

  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    request.model,
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
    '{"mcpServers":{}}',
  ];

  if (isNew) {
    // New session: pass session ID, system prompt, full context
    args.push("--session-id", sessionId);
    if (request.systemPrompt) {
      args.push("--system-prompt", request.systemPrompt);
    }
  } else {
    // Resume existing session: only send the new message
    args.push("--resume", sessionId);
  }

  // New sessions get the full prompt, resumed sessions only get the last message
  const promptToSend = isNew ? request.prompt : request.lastMessage;

  log("info", "CLI spawn", {
    sessionId: sessionId.slice(0, 8),
    isNew,
    model: request.model,
    promptLen: promptToSend.length,
  });

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin?.write(promptToSend);
    proc.stdin?.end();

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      // If session timed out, remove it so next request creates fresh
      if (request.sessionKey) sessions.delete(request.sessionKey);
      reject(new Error(`CLI timeout after ${poolConfig.timeoutMs}ms`));
    }, poolConfig.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // If CLI failed, remove session so next request starts fresh
        if (request.sessionKey) sessions.delete(request.sessionKey);
        return reject(
          new Error(`CLI exited ${code}: ${stderr.slice(0, 500)}`),
        );
      }
      try {
        const sanitized = stdout.replace(
          /[\x00-\x1f\x7f]/g,
          (ch) =>
            ch === "\n" || ch === "\r" || ch === "\t"
              ? ch
              : `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
        );
        const parsed = JSON.parse(sanitized);
        resolve({
          text: parsed.result ?? "",
          inputTokens: parsed.input_tokens ?? parsed.usage?.input_tokens ?? 0,
          outputTokens:
            parsed.output_tokens ?? parsed.usage?.output_tokens ?? 0,
          stopReason: parsed.stop_reason ?? "end_turn",
          sessionId,
        });
      } catch {
        resolve({
          text: stdout.trim(),
          inputTokens: 0,
          outputTokens: 0,
          stopReason: "end_turn",
          sessionId,
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (request.sessionKey) sessions.delete(request.sessionKey);
      reject(err);
    });
  });
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function log(
  level: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
