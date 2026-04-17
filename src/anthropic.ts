import type { AnthropicRequest, AnthropicResponse } from "./translate.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_RETRIES = 2;
const BASE_DELAY_MS = 1000;

export interface AnthropicClientConfig {
  apiKey: string;
  timeoutMs: number;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    "content-type": "application/json",
  };
}

// ─── Non-Streaming ──────────────────────────────────────────────────────────

export async function callAnthropic(
  config: AnthropicClientConfig,
  request: AnthropicRequest,
): Promise<AnthropicResponse> {
  const body = JSON.stringify({ ...request, stream: false });
  const headers = buildHeaders(config.apiKey);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      const resp = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });

      if (resp.ok) {
        return (await resp.json()) as AnthropicResponse;
      }

      const status = resp.status;
      const errorBody = await resp.text().catch(() => "");

      // Retryable errors
      if (isRetryable(status) && attempt < MAX_RETRIES) {
        const delay = getRetryDelay(resp, attempt);
        log("warn", `Anthropic ${status}, retrying in ${delay}ms`, {
          attempt,
          status,
        });
        await sleep(delay);
        continue;
      }

      // Non-retryable error
      throw new AnthropicError(status, errorBody);
    } catch (err) {
      if (err instanceof AnthropicError) throw err;

      if (
        err instanceof DOMException &&
        err.name === "AbortError" &&
        attempt < MAX_RETRIES
      ) {
        log("warn", `Request timeout, retrying`, { attempt });
        continue;
      }

      throw new AnthropicError(
        0,
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  throw new AnthropicError(0, "Max retries exceeded");
}

// ─── Streaming ──────────────────────────────────────────────────────────────

export async function callAnthropicStream(
  config: AnthropicClientConfig,
  request: AnthropicRequest,
): Promise<Response> {
  const body = JSON.stringify({ ...request, stream: true });
  const headers = buildHeaders(config.apiKey);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    if (!resp.ok) {
      clearTimeout(timer);
      const errorBody = await resp.text().catch(() => "");
      throw new AnthropicError(resp.status, errorBody);
    }

    // Clear the abort timer — streaming responses manage their own lifecycle.
    // The caller is responsible for consuming the stream within a reasonable time.
    clearTimeout(timer);
    return resp;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof AnthropicError) throw err;
    throw new AnthropicError(
      0,
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Parse Anthropic SSE stream into individual events
export async function* parseSSEStream(
  response: Response,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = response.body?.getReader();
  if (!reader) throw new AnthropicError(0, "No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "message";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          yield { event: currentEvent, data };
          currentEvent = "message";
        }
        // Ignore empty lines and comments
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      if (buffer.startsWith("data: ")) {
        yield { event: currentEvent, data: buffer.slice(6) };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Error Types ────────────────────────────────────────────────────────────

export class AnthropicError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`Anthropic API error ${status}: ${body.slice(0, 200)}`);
    this.name = "AnthropicError";
  }

  toOpenAIError(): {
    error: { message: string; type: string; code: string | null };
  } {
    let type = "api_error";
    let code: string | null = null;

    switch (this.status) {
      case 400:
        type = "invalid_request_error";
        break;
      case 401:
        type = "authentication_error";
        code = "invalid_api_key";
        break;
      case 402:
        type = "billing_error";
        code = "billing_hard_limit_reached";
        break;
      case 403:
        type = "permission_error";
        break;
      case 404:
        type = "not_found_error";
        code = "model_not_found";
        break;
      case 429:
        type = "rate_limit_error";
        code = "rate_limit_exceeded";
        break;
      case 529:
        type = "overloaded_error";
        code = "overloaded";
        break;
    }

    // Try to extract Anthropic's error message
    let message = this.body;
    try {
      const parsed = JSON.parse(this.body);
      message = parsed?.error?.message ?? this.body;
    } catch {
      // use raw body
    }

    return { error: { message, type, code } };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRetryable(status: number): boolean {
  // Do NOT retry 429 — subscription rate limits have rolling windows,
  // and retrying makes them worse. Let the caller (OpenClaw) handle backoff.
  return status === 529 || (status >= 500 && status < 600);
}

function getRetryDelay(resp: Response, attempt: number): number {
  const retryAfter = resp.headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }
  // Exponential backoff with jitter
  return BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level: string, msg: string, extra?: Record<string, unknown>): void {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...extra,
  };
  if (level === "error") {
    process.stderr.write(JSON.stringify(entry) + "\n");
  } else {
    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}
