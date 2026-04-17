import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { listModels, resolveModel } from "./models.js";
import { enqueueRequest } from "./cli-worker.js";
import type { OAIChatRequest } from "./translate.js";
import { buildPrompt, parseToolCallsFromText } from "./translate.js";

export interface ServerConfig {
  port: number;
  host: string;
}

// ─── Server ─────────────────────────────────────────────────────────────────

export function startServer(config: ServerConfig): void {
  const server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
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

  const shutdown = () => {
    log("info", "Shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  server.listen(config.port, config.host, () => {
    log(
      "info",
      `Claude Bridge listening on http://${config.host}:${config.port}`,
    );
    log("info", `Models: ${listModels().map((m) => m.id).join(", ")}`);
  });
}

// ─── Router ─────────────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
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
    return sendJson(res, 200, { status: "ok", version: "2.0.0" });
  }

  if (url === "/v1/models" && req.method === "GET") {
    return handleModels(res);
  }

  if (url === "/v1/chat/completions" && req.method === "POST") {
    return handleChatCompletions(req, res);
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
  }));
  sendJson(res, 200, { object: "list", data: models });
}

// ─── POST /v1/chat/completions ──────────────────────────────────────────────

async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
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
  const built = buildPrompt(oaiReq);
  const startTime = Date.now();

  log("info", "Request", {
    model: model.id,
    cliModel: model.cliAlias,
    stream: !!oaiReq.stream,
    messages: oaiReq.messages.length,
    tools: oaiReq.tools?.length ?? 0,
    hasSystemPrompt: !!built.systemPrompt,
  });

  const hasTools = (oaiReq.tools?.length ?? 0) > 0;
  const cliReq = {
    prompt: built.prompt,
    model: model.cliAlias,
    systemPrompt: built.systemPrompt,
    hasTools,
  };

  try {
    if (oaiReq.stream) {
      // All streaming is buffered — SDK/CLI return complete responses
      const result = await enqueueRequest(cliReq, false,
      );
      const parsed = parseToolCallsFromText(result.text);
      await emitBufferedAsSSE(res, parsed, model.id, result, startTime);
    } else {
      const result = await enqueueRequest(cliReq, false);
      const duration = Date.now() - startTime;
      log("info", "Response", {
        model: model.id,
        duration,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });

      const parsed = parseToolCallsFromText(result.text);
      const hasToolCalls = parsed.toolCalls.length > 0;

      const message: Record<string, unknown> = {
        role: "assistant",
        content: parsed.text || null,
      };
      if (hasToolCalls) {
        message.tool_calls = parsed.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.arguments },
        }));
      }

      sendJson(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [
          {
            index: 0,
            message,
            finish_reason: hasToolCalls ? "tool_calls" : "stop",
          },
        ],
        usage: {
          prompt_tokens: result.inputTokens,
          completion_tokens: result.outputTokens,
          total_tokens: result.inputTokens + result.outputTokens,
        },
      });
    }
  } catch (err) {
    const duration = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    log("error", "Request failed", { model: model.id, duration, error: message });

    if (!res.headersSent) {
      const isTimeout = message.includes("timeout");
      sendJson(res, isTimeout ? 504 : 500, {
        error: { message, type: "api_error", code: null },
      });
    }
  }
}

// ─── Buffered SSE (for tool-calling requests) ───────────────────────────────

async function emitBufferedAsSSE(
  res: ServerResponse,
  parsed: import("./translate.js").ParsedResponse,
  requestModel: string,
  result: import("./cli-worker.js").CLIResult,
  startTime: number,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const msgId = `chatcmpl-${Date.now()}`;
  const ts = Math.floor(Date.now() / 1000);
  const hasToolCalls = parsed.toolCalls.length > 0;

  // Role chunk
  writeSSE(res, {
    id: msgId, object: "chat.completion.chunk", created: ts, model: requestModel,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });

  // Text content
  if (parsed.text) {
    writeSSE(res, {
      id: msgId, object: "chat.completion.chunk", created: ts, model: requestModel,
      choices: [{ index: 0, delta: { content: parsed.text }, finish_reason: null }],
    });
  }

  // Tool calls
  for (let i = 0; i < parsed.toolCalls.length; i++) {
    const tc = parsed.toolCalls[i];
    writeSSE(res, {
      id: msgId, object: "chat.completion.chunk", created: ts, model: requestModel,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: i, id: tc.id, type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          }],
        },
        finish_reason: null,
      }],
    });
  }

  // Finish
  writeSSE(res, {
    id: msgId, object: "chat.completion.chunk", created: ts, model: requestModel,
    choices: [{ index: 0, delta: {}, finish_reason: hasToolCalls ? "tool_calls" : "stop" }],
  });

  res.write("data: [DONE]\n\n");
  res.end();

  log("info", "Buffered stream complete", {
    model: requestModel, duration: Date.now() - startTime,
    toolCalls: parsed.toolCalls.length,
  });
}

// ─── Old streaming handler removed — all responses are buffered now ─────────
// SDK and CLI both return complete responses. Streaming to client is simulated
// via emitBufferedAsSSE() which parses tool calls and emits SSE chunks.

// ─── Helpers ────────────────────────────────────────────────────────────────

function writeSSE(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8") || null));
    req.on("error", () => resolve(null));
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
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
