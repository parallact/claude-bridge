import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { listModels, resolveModel } from "./models.js";
import {
  drainAndShutdown,
  enqueueRequest,
  getMetrics,
  type CLIResult,
  type CLIToolCall,
} from "./cli-worker.js";
import type { OAIChatRequest } from "./translate.js";
import { buildPrompt, toolsFromRequest } from "./translate.js";

const BRIDGE_VERSION = "3.3.0";

// Flipped to true on SIGTERM/SIGINT so new chat-completion requests get
// rejected with 503 while we drain. Health + models stay up for LB checks.
let isShuttingDown = false;

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

  // Graceful shutdown:
  //   1. Stop accepting new /v1/chat/completions (503)
  //   2. Close the HTTP server so Node's keep-alive connections drain
  //   3. drainAndShutdown() waits up to 10s for in-flight CLI to finish,
  //      then SIGKILLs stragglers
  //   4. Hard-stop timer (15s total) as last-resort safety net
  let shuttingDownPromise: Promise<void> | null = null;
  const shutdown = (signal: string) => {
    if (shuttingDownPromise) return shuttingDownPromise;
    log("info", "Shutting down", { signal });
    isShuttingDown = true;
    const hardStop = setTimeout(() => {
      log("error", "Hard-stop timer fired — forcing exit");
      process.exit(1);
    }, 15_000);
    hardStop.unref();
    shuttingDownPromise = new Promise<void>((resolve) => {
      server.close(() => resolve());
    }).then(() => drainAndShutdown(10_000)).then(() => {
      log("info", "Shutdown complete");
      process.exit(0);
    });
    return shuttingDownPromise;
  };
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

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
    return sendJson(res, 200, { status: "ok", version: BRIDGE_VERSION });
  }

  // Introspection for ops: current queue depth, lifetime counts, avg latency.
  // Loopback-only exposure (bridge binds 127.0.0.1 by default) so leaking this
  // isn't a concern, but the payload deliberately contains no request content
  // — counts and numbers only.
  if (url === "/metrics") {
    return sendJson(res, 200, { version: BRIDGE_VERSION, ...getMetrics() });
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
  if (isShuttingDown) {
    return sendJson(res, 503, {
      error: {
        message: "Bridge is shutting down; retry on the next instance",
        type: "server_shutting_down",
        code: null,
      },
    });
  }
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
  const tools = toolsFromRequest(oaiReq);
  const startTime = Date.now();

  log("info", "Request", {
    model: model.id,
    cliModel: model.cliAlias,
    stream: !!oaiReq.stream,
    messages: oaiReq.messages.length,
    tools: tools.length,
    hasSystemPrompt: !!built.systemPrompt,
  });

  const lastUserMsg = oaiReq.messages.filter((m) => m.role === "user").pop();
  const lastUserText = lastUserMsg
    ? (typeof lastUserMsg.content === "string"
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg.content)
          ? lastUserMsg.content
              .filter((p) => p.type === "text")
              .map((p) => p.text ?? "")
              .join("")
          : String(lastUserMsg.content ?? ""))
    : built.prompt;

  const cliReq = {
    prompt: built.prompt,
    lastMessage: lastUserText,
    model: model.cliAlias,
    systemPrompt: built.systemPrompt,
    tools,
    sessionKey: oaiReq.user,
  };

  try {
    const result = await enqueueRequest(cliReq);
    const duration = Date.now() - startTime;
    log("info", "Response", {
      model: model.id,
      duration,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      toolCalls: result.toolCalls.length,
      rateLimitStatus: result.rateLimitStatus,
    });

    if (oaiReq.stream) {
      await emitBufferedAsSSE(res, result, model.id, duration);
    } else {
      sendJson(res, 200, buildCompletionResponse(result, model.id));
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

// ─── Response Formatting ────────────────────────────────────────────────────

function buildCompletionResponse(
  result: CLIResult,
  modelId: string,
): Record<string, unknown> {
  const hasToolCalls = result.toolCalls.length > 0;
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text || null,
  };
  if (hasToolCalls) {
    message.tool_calls = result.toolCalls.map(toOAIToolCall);
  }
  return {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
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
  };
}

function toOAIToolCall(tc: CLIToolCall): Record<string, unknown> {
  return {
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.input ?? {}),
    },
  };
}

async function emitBufferedAsSSE(
  res: ServerResponse,
  result: CLIResult,
  requestModel: string,
  duration: number,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const msgId = `chatcmpl-${Date.now()}`;
  const ts = Math.floor(Date.now() / 1000);
  const hasToolCalls = result.toolCalls.length > 0;

  writeSSE(res, {
    id: msgId,
    object: "chat.completion.chunk",
    created: ts,
    model: requestModel,
    choices: [
      { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null },
    ],
  });

  if (result.text) {
    writeSSE(res, {
      id: msgId,
      object: "chat.completion.chunk",
      created: ts,
      model: requestModel,
      choices: [
        { index: 0, delta: { content: result.text }, finish_reason: null },
      ],
    });
  }

  for (let i = 0; i < result.toolCalls.length; i++) {
    const tc = result.toolCalls[i];
    writeSSE(res, {
      id: msgId,
      object: "chat.completion.chunk",
      created: ts,
      model: requestModel,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: i,
                id: tc.id,
                type: "function",
                function: {
                  name: tc.name,
                  arguments: JSON.stringify(tc.input ?? {}),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }

  writeSSE(res, {
    id: msgId,
    object: "chat.completion.chunk",
    created: ts,
    model: requestModel,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: hasToolCalls ? "tool_calls" : "stop",
      },
    ],
  });

  res.write("data: [DONE]\n\n");
  res.end();

  log("info", "Buffered stream complete", {
    model: requestModel,
    duration,
    toolCalls: result.toolCalls.length,
  });
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
  out.write(`${JSON.stringify(entry)}\n`);
}
