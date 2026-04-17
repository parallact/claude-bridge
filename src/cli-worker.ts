import { spawn, type ChildProcess } from "node:child_process";

export interface CLIRequest {
  prompt: string;
  model: string;
  systemPrompt?: string;
}

export interface CLIResult {
  text: string;
  toolCalls: Array<{ name: string; arguments: string; id: string }>;
  inputTokens: number;
  outputTokens: number;
  stopReason: string;
}

export interface CLIStreamEvent {
  type: "text" | "tool_call_start" | "tool_call_delta" | "stop" | "error";
  text?: string;
  toolCall?: { id: string; name: string; arguments: string };
  toolCallIndex?: number;
  stopReason?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

// ─── Worker Pool ────────────────────────────────────────────────────────────

export interface WorkerPoolConfig {
  maxWorkers: number;
  timeoutMs: number;
}

interface QueueItem {
  request: CLIRequest;
  streaming: boolean;
  resolve: (value: CLIResult | AsyncGenerator<CLIStreamEvent>) => void;
  reject: (error: Error) => void;
}

let activeWorkers = 0;
const queue: QueueItem[] = [];
let poolConfig: WorkerPoolConfig = { maxWorkers: 5, timeoutMs: 300_000 };

export function configurePool(config: WorkerPoolConfig): void {
  poolConfig = config;
}

function tryProcessQueue(): void {
  while (queue.length > 0 && activeWorkers < poolConfig.maxWorkers) {
    const item = queue.shift()!;
    activeWorkers++;

    const work = item.streaming
      ? runCLIStream(item.request)
      : runCLI(item.request);

    work
      .then(item.resolve)
      .catch(item.reject)
      .finally(() => {
        activeWorkers--;
        tryProcessQueue();
      });
  }
}

export function enqueueRequest(
  request: CLIRequest,
  streaming: false,
): Promise<CLIResult>;
export function enqueueRequest(
  request: CLIRequest,
  streaming: true,
): Promise<AsyncGenerator<CLIStreamEvent>>;
export function enqueueRequest(
  request: CLIRequest,
  streaming: boolean,
): Promise<CLIResult | AsyncGenerator<CLIStreamEvent>> {
  return new Promise((resolve, reject) => {
    queue.push({ request, streaming, resolve, reject });
    log("info", "Queue", {
      queued: queue.length,
      active: activeWorkers,
      max: poolConfig.maxWorkers,
    });
    tryProcessQueue();
  });
}

// ─── Non-Streaming CLI Execution ────────────────────────────────────────────

async function runCLI(request: CLIRequest): Promise<CLIResult> {
  const args = buildArgs(request, "json");

  return new Promise((resolve, reject) => {
    const proc = spawnCLI(args, request.prompt);
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
        const parsed = JSON.parse(stdout);
        resolve({
          text: parsed.result ?? "",
          toolCalls: [],
          inputTokens: parsed.input_tokens ?? 0,
          outputTokens: parsed.output_tokens ?? 0,
          stopReason: parsed.stop_reason ?? "end_turn",
        });
      } catch {
        // JSON mode failed, use text
        resolve({
          text: stdout.trim(),
          toolCalls: [],
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

// ─── Streaming CLI Execution ────────────────────────────────────────────────

async function runCLIStream(
  request: CLIRequest,
): Promise<AsyncGenerator<CLIStreamEvent>> {
  const args = buildArgs(request, "stream-json");
  const proc = spawnCLI(args, request.prompt);

  async function* generate(): AsyncGenerator<CLIStreamEvent> {
    let buffer = "";
    let lastUsage = { inputTokens: 0, outputTokens: 0 };

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, poolConfig.timeoutMs);

    try {
      for await (const chunk of proc.stdout as AsyncIterable<Buffer>) {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          const event = parseStreamLine(line);
          if (event) {
            if (event.usage) lastUsage = event.usage;
            yield event;
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        const event = parseStreamLine(buffer);
        if (event) yield event;
      }

      yield {
        type: "stop",
        stopReason: "end_turn",
        usage: lastUsage,
      };
    } finally {
      clearTimeout(timer);
      if (!proc.killed) proc.kill();
    }
  }

  return generate();
}

function parseStreamLine(line: string): CLIStreamEvent | null {
  try {
    const data = JSON.parse(line);

    // Claude CLI stream-json emits assistant messages with full content
    if (data.type === "assistant" && data.message?.content) {
      const content = data.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && block.text) {
            return { type: "text", text: block.text };
          }
        }
      }
      return null;
    }

    if (data.type === "content_block_delta") {
      const delta = data.delta;
      if (delta?.type === "text_delta") {
        return { type: "text", text: delta.text };
      }
      if (delta?.type === "input_json_delta") {
        return {
          type: "tool_call_delta",
          toolCallIndex: data.index ?? 0,
          text: delta.partial_json,
        };
      }
    }

    if (data.type === "content_block_start") {
      const block = data.content_block;
      if (block?.type === "tool_use") {
        return {
          type: "tool_call_start",
          toolCall: {
            id: block.id,
            name: block.name,
            arguments: "",
          },
          toolCallIndex: data.index ?? 0,
        };
      }
    }

    if (data.type === "message_delta") {
      return {
        type: "stop",
        stopReason: data.delta?.stop_reason ?? "end_turn",
        usage: {
          inputTokens: data.usage?.input_tokens ?? 0,
          outputTokens: data.usage?.output_tokens ?? 0,
        },
      };
    }

    // content_delta events from --include-partial-messages
    if (data.type === "content_delta") {
      const text = data.event?.delta?.text;
      if (text) return { type: "text", text };
    }

    // result event (final)
    if (data.type === "result") {
      return {
        type: "stop",
        stopReason: data.stop_reason ?? "end_turn",
        usage: {
          inputTokens: data.input_tokens ?? 0,
          outputTokens: data.output_tokens ?? 0,
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ─── CLI Process Spawning ───────────────────────────────────────────────────

function buildArgs(
  request: CLIRequest,
  outputFormat: "json" | "stream-json",
): string[] {
  const args = [
    "--print",
    "--output-format",
    outputFormat,
    "--model",
    request.model,
    "--no-session-persistence",
    "--max-turns",
    "1",
    "--tools",
    "",
  ];

  if (outputFormat === "stream-json") {
    args.push("--verbose");
  }

  if (request.systemPrompt) {
    args.push("--system-prompt", request.systemPrompt);
  }

  return args;
}

function spawnCLI(args: string[], prompt: string): ChildProcess {
  // Pass prompt via stdin to avoid OS arg length limits
  const proc = spawn("claude", args, {
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdin?.write(prompt);
  proc.stdin?.end();

  return proc;
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
