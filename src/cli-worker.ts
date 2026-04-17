import { spawn, type ChildProcess } from "node:child_process";
import { query, startup, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";

export interface CLIRequest {
  prompt: string;
  model: string;
  systemPrompt?: string;
  hasTools: boolean;
}

export interface CLIResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export interface CLIStreamEvent {
  type: "text" | "stop" | "error";
  text?: string;
  stopReason?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

// ─── Hybrid Worker Pool ─────────────────────────────────────────────────────
// SDK pre-warmed workers for simple requests (fast, no tool support)
// CLI spawn for tool-calling requests (supports --system-prompt)

export interface WorkerPoolConfig {
  poolSize: number;
  timeoutMs: number;
}

let poolConfig: WorkerPoolConfig = { poolSize: 10, timeoutMs: 300_000 };
const warmPool: WarmQuery[] = [];
let warming = false;

export function configurePool(config: WorkerPoolConfig): void {
  poolConfig = config;
}

async function fillPool(): Promise<void> {
  if (warming) return;
  warming = true;
  try {
    while (warmPool.length < poolConfig.poolSize) {
      try {
        const warm = await startup({
          options: {
            model: "sonnet",
            permissionMode: "bypassPermissions" as "default",
            allowDangerouslySkipPermissions: true,
          },
          initializeTimeoutMs: 30_000,
        });
        warmPool.push(warm);
        log("debug", "SDK worker pre-warmed", { poolSize: warmPool.length });
      } catch (err) {
        log("warn", "Failed to pre-warm SDK worker", {
          error: err instanceof Error ? err.message : String(err),
        });
        break;
      }
    }
  } finally {
    warming = false;
  }
}

export async function initPool(): Promise<void> {
  log("info", "Pre-warming SDK worker pool", { target: poolConfig.poolSize });
  await fillPool();
  log("info", "Worker pool ready", { size: warmPool.length });
}

// ─── Request Queue ──────────────────────────────────────────────────────────

let activeRequests = 0;

interface QueueItem {
  request: CLIRequest;
  streaming: boolean;
  resolve: (value: CLIResult) => void;
  reject: (error: Error) => void;
}

const queue: QueueItem[] = [];

function tryProcessQueue(): void {
  while (queue.length > 0) {
    const item = queue.shift()!;
    activeRequests++;

    const work = item.request.hasTools
      ? runCLI(item.request)  // CLI spawn for tool-calling (supports --system-prompt)
      : runSDK(item.request); // SDK for simple requests (pre-warmed, fast)

    (work as Promise<CLIResult>)
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeRequests--;
        tryProcessQueue();
      });
  }
}

export function enqueueRequest(
  request: CLIRequest,
  _streaming: boolean,
): Promise<CLIResult> {
  return new Promise((resolve, reject) => {
    queue.push({ request, streaming: false, resolve, reject });
    log("info", "Queue", {
      queued: queue.length,
      active: activeRequests,
      warmPool: warmPool.length,
      method: request.hasTools ? "cli" : "sdk",
    });
    tryProcessQueue();
  });
}

// ─── SDK Execution (simple requests, pre-warmed, fast) ──────────────────────

async function runSDK(request: CLIRequest): Promise<CLIResult> {
  const warmWorker = warmPool.shift();
  // Refill in background
  fillPool().catch(() => {});

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason = "end_turn";

  const source = warmWorker
    ? warmWorker.query(request.prompt)
    : query({
        prompt: request.prompt,
        options: {
          model: request.model,
          maxTurns: 1,
          tools: [],
          permissionMode: "bypassPermissions" as "default",
          allowDangerouslySkipPermissions: true,
        },
      });

  for await (const msg of source) {
    if (msg.type === "assistant" && msg.message?.content) {
      for (const block of msg.message.content) {
        if (
          typeof block === "object" &&
          "type" in block &&
          block.type === "text" &&
          "text" in block
        ) {
          text += (block as { text: string }).text;
        }
      }
    }
    if (msg.type === "result" && msg.subtype === "success") {
      text = msg.result ?? text;
      inputTokens = msg.usage?.input_tokens ?? 0;
      outputTokens = msg.usage?.output_tokens ?? 0;
      stopReason = msg.stop_reason ?? "end_turn";
    }
    if (msg.type === "result" && msg.subtype !== "success") {
      throw new Error(`SDK error: ${JSON.stringify(msg).slice(0, 300)}`);
    }
  }

  return { text, inputTokens, outputTokens, stopReason };
}

// ─── CLI Execution (tool-calling requests, supports --system-prompt) ────────

async function runCLI(request: CLIRequest): Promise<CLIResult> {
  const args = [
    "--print",
    "--output-format",
    "json",
    "--model",
    request.model,
    "--no-session-persistence",
    "--max-turns",
    "1",
    "--tools",
    "",
    "--strict-mcp-config",
    '{"mcpServers":{}}',
  ];

  if (request.systemPrompt) {
    args.push("--system-prompt", request.systemPrompt);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    proc.stdin?.write(request.prompt);
    proc.stdin?.end();

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
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
        });
      } catch {
        resolve({
          text: stdout.trim(),
          inputTokens: 0,
          outputTokens: 0,
          stopReason: "end_turn",
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
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
