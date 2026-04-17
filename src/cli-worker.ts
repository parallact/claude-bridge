import { spawn } from "node:child_process";

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

// ─── Configuration ──────────────────────────────────────────────────────────

export interface WorkerPoolConfig {
  timeoutMs: number;
}

let poolConfig: WorkerPoolConfig = { timeoutMs: 300_000 };

export function configurePool(config: WorkerPoolConfig): void {
  poolConfig = config;
}

// ─── Request Queue ──────────────────────────────────────────────────────────

let activeRequests = 0;

export function enqueueRequest(request: CLIRequest): Promise<CLIResult> {
  activeRequests++;
  log("info", "Queue", { active: activeRequests });

  return runCLI(request).finally(() => {
    activeRequests--;
  });
}

// ─── CLI Execution ──────────────────────────────────────────────────────────

function runCLI(request: CLIRequest): Promise<CLIResult> {
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
        // Sanitize control characters in CLI JSON output
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
