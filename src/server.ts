import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  callAnthropic,
  callAnthropicStream,
  parseSSEStream,
  AnthropicError,
} from "./anthropic.js";
import { resolveModel, listModels } from "./models.js";
import {
  translateRequest,
  translateResponse,
  translateStreamEvent,
  createStreamState,
  type OAIChatRequest,
} from "./translate.js";

export interface ServerConfig {
  port: number;
  host: string;
  apiKey: string;
  timeoutMs: number;
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function startServer(config: ServerConfig): void {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res, config);
    } catch (err) {
      log("error", "Unhandled error", {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            message: "Internal server error",
            type: "api_error",
            code: null,
          },
        });
      }
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    log("info", "Shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(config.port, config.host, () => {
    log("info", `Claude Bridge listening on http://${config.host}:${config.port}`);
    log("info", `Models: ${listModels().map((m) => m.id).join(", ")}`);
    log("info", `Timeout: ${config.timeoutMs}ms`);
  });
}

// ─── Request Router ─────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): Promise<void> {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url ?? "/";

  if (url === "/health" || url === "/healthz") {
    return sendJson(res, 200, { status: "ok", version: "1.0.0" });
  }

  if (url === "/v1/models" && req.method === "GET") {
    return handleModels(res);
  }

  if (url === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res, config);
  }

  sendJson(res, 404, {
    error: { message: `Not found: ${url}`, type: "not_found", code: null },
  });
}

// ─── GET /v1/models ─────────────────────────────────────────────────────────

function handleModels(res: ServerResponse): void {
  const models = listModels().map((m) => ({
    id: m.id,
    object: "model",
    created: 1700000000,
    owned_by: "anthropic",
    permission: [],
    root: m.anthropicId,
    parent: null,
  }));
  sendJson(res, 200, { object: "list", data: models });
}

// ─── POST /v1/chat/completions ──────────────────────────────────────────────

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  config: ServerConfig,
): Promise<void> {
  const body = await readBody(req);
  if (!body) {
    return sendJson(res, 400, {
      error: { message: "Empty request body", type: "invalid_request_error", code: null },
    });
  }

  let oaiReq: OAIChatRequest;
  try {
    oaiReq = JSON.parse(body);
  } catch {
    return sendJson(res, 400, {
      error: { message: "Invalid JSON", type: "invalid_request_error", code: null },
    });
  }

  if (!oaiReq.messages?.length) {
    return sendJson(res, 400, {
      error: { message: "messages is required", type: "invalid_request_error", code: null },
    });
  }

  const model = resolveModel(oaiReq.model ?? "claude-sonnet-4");
  const anthropicReq = translateRequest(oaiReq, model.anthropicId);
  const clientConfig = { apiKey: config.apiKey, timeoutMs: config.timeoutMs };

  const startTime = Date.now();
  log("info", "Request", {
    model: model.id,
    anthropicModel: model.anthropicId,
    stream: !!oaiReq.stream,
    messages: oaiReq.messages.length,
    tools: oaiReq.tools?.length ?? 0,
  });

  try {
    if (oaiReq.stream) {
      await handleStreaming(res, clientConfig, anthropicReq, model.id, startTime);
    } else {
      await handleNonStreaming(res, clientConfig, anthropicReq, model.id, startTime);
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    if (err instanceof AnthropicError) {
      log("error", "Anthropic error", {
        status: err.status,
        duration,
        model: model.id,
      });
      if (!res.headersSent) {
        sendJson(res, err.status || 500, err.toOpenAIError());
      }
    } else {
      log("error", "Request failed", {
        error: err instanceof Error ? err.message : String(err),
        duration,
        model: model.id,
      });
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: {
            message: err instanceof Error ? err.message : "Unknown error",
            type: "api_error",
            code: null,
          },
        });
      }
    }
  }
}

// ─── Non-Streaming Handler ──────────────────────────────────────────────────

async function handleNonStreaming(
  res: ServerResponse,
  config: { apiKey: string; timeoutMs: number },
  anthropicReq: import("./translate.js").AnthropicRequest,
  requestModel: string,
  startTime: number,
): Promise<void> {
  const anthropicResp = await callAnthropic(config, anthropicReq);
  const oaiResp = translateResponse(anthropicResp, requestModel);
  const duration = Date.now() - startTime;

  log("info", "Response", {
    model: requestModel,
    duration,
    inputTokens: anthropicResp.usage.input_tokens,
    outputTokens: anthropicResp.usage.output_tokens,
    finishReason: anthropicResp.stop_reason,
  });

  sendJson(res, 200, oaiResp);
}

// ─── Streaming Handler ──────────────────────────────────────────────────────

async function handleStreaming(
  res: ServerResponse,
  config: { apiKey: string; timeoutMs: number },
  anthropicReq: import("./translate.js").AnthropicRequest,
  requestModel: string,
  startTime: number,
): Promise<void> {
  const rawResp = await callAnthropicStream(config, anthropicReq);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const state = createStreamState(requestModel);
  let lastUsage: Record<string, unknown> | null = null;

  // Detect client disconnect
  let clientDisconnected = false;
  res.on("close", () => {
    clientDisconnected = true;
  });

  try {
    for await (const sse of parseSSEStream(rawResp)) {
      if (clientDisconnected) break;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(sse.data);
      } catch {
        continue;
      }

      // Capture usage from message_start and message_delta
      if (sse.event === "message_start") {
        const msg = parsed.message as Record<string, unknown> | undefined;
        lastUsage = (msg?.usage as Record<string, unknown>) ?? null;
      }
      if (sse.event === "message_delta") {
        const deltaUsage = parsed.usage as Record<string, unknown> | undefined;
        if (deltaUsage) lastUsage = { ...lastUsage, ...deltaUsage };
      }

      const chunk = translateStreamEvent(sse.event, parsed, state);
      if (chunk) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    }
  } finally {
    if (!clientDisconnected) {
      res.write("data: [DONE]\n\n");
      res.end();
    }

    const duration = Date.now() - startTime;
    log("info", "Stream complete", {
      model: requestModel,
      duration,
      ...(lastUsage ?? {}),
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      resolve(body || null);
    });
    req.on("error", () => resolve(null));
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: unknown,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function log(
  level: string,
  msg: string,
  extra?: Record<string, unknown>,
): void {
  const entry = { ts: new Date().toISOString(), level, msg, ...extra };
  const out = level === "error" ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + "\n");
}
