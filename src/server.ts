import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { listModels, resolveModel } from "./models.js";
import {
  enqueueRequest,
  type CLIStreamEvent,
} from "./cli-worker.js";
import type { OAIChatRequest } from "./translate.js";
import { extractText, buildPrompt, translateToolChoice } from "./translate.js";

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
  const prompt = buildPrompt(oaiReq);
  const startTime = Date.now();

  log("info", "Request", {
    model: model.id,
    cliModel: model.cliAlias,
    stream: !!oaiReq.stream,
    messages: oaiReq.messages.length,
    tools: oaiReq.tools?.length ?? 0,
  });

  try {
    if (oaiReq.stream) {
      const generator = await enqueueRequest(
        { prompt, model: model.cliAlias },
        true,
      );
      await handleStreaming(res, generator, model.id, startTime);
    } else {
      const result = await enqueueRequest(
        { prompt, model: model.cliAlias },
        false,
      );
      const duration = Date.now() - startTime;
      log("info", "Response", {
        model: model.id,
        duration,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });

      sendJson(res, 200, {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: result.text },
            finish_reason: result.stopReason === "end_turn" ? "stop" : result.stopReason,
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

// ─── Streaming Handler ──────────────────────────────────────────────────────

async function handleStreaming(
  res: ServerResponse,
  generator: AsyncGenerator<CLIStreamEvent>,
  requestModel: string,
  startTime: number,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const msgId = `chatcmpl-${Date.now()}`;
  const ts = Math.floor(Date.now() / 1000);
  let toolCallIndex = -1;
  let clientDisconnected = false;

  res.on("close", () => {
    clientDisconnected = true;
  });

  // Initial role chunk
  writeSSE(res, {
    id: msgId,
    object: "chat.completion.chunk",
    created: ts,
    model: requestModel,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });

  try {
    for await (const event of generator) {
      if (clientDisconnected) break;

      switch (event.type) {
        case "text":
          writeSSE(res, {
            id: msgId,
            object: "chat.completion.chunk",
            created: ts,
            model: requestModel,
            choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
          });
          break;

        case "tool_call_start":
          toolCallIndex++;
          writeSSE(res, {
            id: msgId,
            object: "chat.completion.chunk",
            created: ts,
            model: requestModel,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: toolCallIndex,
                  id: event.toolCall!.id,
                  type: "function",
                  function: { name: event.toolCall!.name, arguments: "" },
                }],
              },
              finish_reason: null,
            }],
          });
          break;

        case "tool_call_delta":
          writeSSE(res, {
            id: msgId,
            object: "chat.completion.chunk",
            created: ts,
            model: requestModel,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{
                  index: event.toolCallIndex ?? toolCallIndex,
                  function: { arguments: event.text },
                }],
              },
              finish_reason: null,
            }],
          });
          break;

        case "stop": {
          const finishReason =
            event.stopReason === "tool_use"
              ? "tool_calls"
              : event.stopReason === "max_tokens"
                ? "length"
                : "stop";
          writeSSE(res, {
            id: msgId,
            object: "chat.completion.chunk",
            created: ts,
            model: requestModel,
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          });

          const duration = Date.now() - startTime;
          log("info", "Stream complete", {
            model: requestModel,
            duration,
            ...event.usage,
          });
          break;
        }

        case "error":
          log("error", "Stream error", { error: event.error });
          break;
      }
    }
  } finally {
    if (!clientDisconnected) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

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
