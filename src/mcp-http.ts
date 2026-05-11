/**
 * In-bridge HTTP MCP server for Path D (persistent CLI).
 *
 * This is Path D's coordination layer: each persistent CLI is launched with
 * an `--mcp-config` pointing to a per-session URL on this server. When the
 * model emits a `tool_use` block, the CLI makes an MCP `tools/call` HTTP
 * request here. Instead of running the tool locally, this server PARKS the
 * request (holds the HTTP response open) until the bridge's OpenAI-side
 * handler gets a real tool_result from the external caller (OpenClaw
 * runtime) and resolves it via `resolveToolCall`. The CLI then unblocks,
 * the model sees the real result, and the conversation continues — with a
 * clean session transcript, no permission-denied artifacts.
 *
 * Why per-session URLs (not one shared endpoint with headers): Claude CLI
 * doesn't attach arbitrary correlation data to outbound MCP calls, but the
 * --mcp-config URL is fixed at CLI spawn time. Encoding sessionKey in the
 * URL gives us unambiguous routing without protocol gymnastics.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CapturedToolUse {
  /** Bridge-internal correlation id, matches the tool_use block id in the
   *  CLI's stream-json output (_meta.claudecode/toolUseId on the MCP side). */
  toolUseId: string;
  /** Tool name as seen by the model — already stripped of any mcp__ prefix. */
  name: string;
  /** Tool arguments, parsed from JSON-RPC params.arguments. */
  args: Record<string, unknown>;
}

interface PendingCall {
  toolUseId: string;
  rpcId: number | string;
  res: ServerResponse;
  resolved: boolean;
  receivedAt: number;
}

interface ToolCallWaiter {
  resolve: (call: CapturedToolUse) => void;
  reject: (err: Error) => void;
}

interface SessionContext {
  sessionKey: string;
  tools: McpTool[];
  pending: Map<string, PendingCall>;
  /** When the bridge's main flow is waiting for the NEXT tool_use the model
   *  emits. If a tools/call arrives and a waiter exists, the waiter resolves
   *  synchronously and the pending entry is still stored so a later
   *  resolveToolCall can respond to the CLI. */
  waiters: ToolCallWaiter[];
}

const JSON_RPC_INVALID = -32600;
const JSON_RPC_METHOD_NOT_FOUND = -32601;

export class BridgeMcpHttpServer {
  private server: Server | null = null;
  private actualPort = 0;
  private sessions = new Map<string, SessionContext>();

  async start(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    const addr = this.server!.address();
    this.actualPort = typeof addr === "object" && addr ? addr.port : port;
    return this.actualPort;
  }

  async stop(): Promise<void> {
    // Fail all waiters + in-flight pending responses so no consumer hangs.
    for (const ctx of this.sessions.values()) {
      for (const w of ctx.waiters) w.reject(new Error("mcp server stopping"));
      ctx.waiters.length = 0;
      for (const p of ctx.pending.values()) {
        if (!p.resolved) this.finishResponse(p, { error: { code: -32000, message: "server stopping" } });
      }
      ctx.pending.clear();
    }
    this.sessions.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  get port(): number {
    return this.actualPort;
  }

  /** URL the CLI's --mcp-config should point at for this session. */
  urlFor(sessionKey: string): string {
    return `http://127.0.0.1:${this.actualPort}/${encodeURIComponent(sessionKey)}`;
  }

  registerSession(sessionKey: string, tools: McpTool[]): void {
    let ctx = this.sessions.get(sessionKey);
    if (!ctx) {
      ctx = { sessionKey, tools, pending: new Map(), waiters: [] };
      this.sessions.set(sessionKey, ctx);
    } else {
      ctx.tools = tools;
    }
  }

  unregisterSession(sessionKey: string): void {
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) return;
    for (const w of ctx.waiters) w.reject(new Error("session unregistered"));
    for (const p of ctx.pending.values()) {
      if (!p.resolved) {
        this.finishResponse(p, {
          error: { code: -32000, message: "session unregistered" },
        });
      }
    }
    this.sessions.delete(sessionKey);
  }

  /** Wait for the CLI to emit the next tool_use for this session. Resolves
   *  with the captured call. The HTTP response to the CLI stays parked
   *  until resolveToolCall is invoked. */
  awaitNextToolCall(sessionKey: string, timeoutMs = 300_000): Promise<CapturedToolUse> {
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) return Promise.reject(new Error(`session not registered: ${sessionKey}`));
    return new Promise<CapturedToolUse>((resolve, reject) => {
      const waiter: ToolCallWaiter = { resolve, reject };
      ctx.waiters.push(waiter);
      const timer = setTimeout(() => {
        const idx = ctx.waiters.indexOf(waiter);
        if (idx !== -1) ctx.waiters.splice(idx, 1);
        reject(new Error(`awaitNextToolCall timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref();
    });
  }

  /** Block briefly until the MCP POST for this tool_use_id lands in the
   *  pending map. The stream-json event that the bridge reads from the CLI
   *  can fire slightly before the MCP tools/call HTTP request arrives here,
   *  so the bridge needs to wait for this gate before returning the
   *  tool_use to the OAI caller — otherwise a fast caller round-trips with
   *  a tool_result before pending exists and resolveToolCall throws. */
  async waitForPending(sessionKey: string, toolUseId: string, timeoutMs = 10_000): Promise<void> {
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) throw new Error(`session not registered: ${sessionKey}`);
    if (ctx.pending.has(toolUseId)) return;
    const deadline = Date.now() + timeoutMs;
    // Tight polling is fine here: the MCP POST usually lands within a few
    // event-loop ticks, and the only alternative (wiring per-id events)
    // bloats the pending-call data structure for a race that's ~ms wide.
    while (Date.now() < deadline) {
      if (ctx.pending.has(toolUseId)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`waitForPending timeout: ${toolUseId} did not arrive within ${timeoutMs}ms`);
  }

  /** Deliver a real tool_result to a previously-captured tool_use. Causes
   *  the parked HTTP response to flush, unblocking the CLI. */
  resolveToolCall(sessionKey: string, toolUseId: string, content: unknown): void {
    if (!this.tryResolveToolCall(sessionKey, toolUseId, content)) {
      throw new Error(`no pending tool call: ${toolUseId}`);
    }
  }

  /** Try to deliver a tool_result. Returns true on success, false if the
   *  pending entry is missing (e.g. bridge restarted, CLI died, or session
   *  was respawned between turns). Callers use this to detect orphan
   *  tool_result deliveries and recover (typically by respawning the
   *  session and re-priming with the full conversation history). */
  tryResolveToolCall(
    sessionKey: string,
    toolUseId: string,
    content: unknown,
  ): boolean {
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) return false;
    const pending = ctx.pending.get(toolUseId);
    if (!pending) return false;
    if (pending.resolved) {
      ctx.pending.delete(toolUseId);
      return true;
    }
    this.finishResponse(pending, {
      result: {
        content: this.normalizeContent(content),
        isError: false,
      },
    });
    ctx.pending.delete(toolUseId);
    return true;
  }

  /** Deliver an error result so the CLI sees the tool failed. */
  rejectToolCall(sessionKey: string, toolUseId: string, message: string): void {
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) throw new Error(`session not registered: ${sessionKey}`);
    const pending = ctx.pending.get(toolUseId);
    if (!pending || pending.resolved) return;
    this.finishResponse(pending, {
      result: {
        content: [{ type: "text", text: message }],
        isError: true,
      },
    });
    ctx.pending.delete(toolUseId);
  }

  // ─── HTTP handling ──────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CLI does a GET for SSE on the same URL as part of MCP HTTP transport
    // discovery; we don't need streaming, so reply with 405.
    if (req.method === "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "SSE transport not supported; use POST JSON-RPC" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    const sessionKey = this.sessionKeyFromUrl(req.url ?? "");
    if (!sessionKey) {
      this.writeJson(res, 400, { error: "missing session key in URL" });
      return;
    }
    const ctx = this.sessions.get(sessionKey);
    if (!ctx) {
      this.writeJson(res, 404, { error: `session not registered: ${sessionKey}` });
      return;
    }

    const body = await this.readBody(req);
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(body) as Record<string, unknown>;
    } catch {
      this.writeJson(res, 400, { error: "invalid JSON" });
      return;
    }

    const method = typeof msg.method === "string" ? msg.method : "";
    const rpcId = msg.id as number | string | undefined;

    if (method === "initialize") {
      this.writeJsonRpc(res, rpcId, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-bridge-mcp", version: "path-d" },
      });
      return;
    }

    if (method === "tools/list") {
      this.writeJsonRpc(res, rpcId, { tools: ctx.tools });
      return;
    }

    if (method === "tools/call") {
      await this.handleToolsCall(ctx, msg, res);
      return;
    }

    if (method.startsWith("notifications/")) {
      res.writeHead(202);
      res.end();
      return;
    }

    this.writeJsonRpcError(res, rpcId, JSON_RPC_METHOD_NOT_FOUND, `method not found: ${method}`);
  }

  private async handleToolsCall(
    ctx: SessionContext,
    msg: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    const rpcId = msg.id as number | string | undefined;
    const params = (msg.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const meta = (params._meta ?? {}) as Record<string, unknown>;
    // Claude CLI stamps this on every outbound tool call — matches the
    // `id` on the tool_use block in stream-json, which is how the bridge
    // correlates "this captured call" to "that tool_use event".
    const toolUseId = typeof meta["claudecode/toolUseId"] === "string"
      ? (meta["claudecode/toolUseId"] as string)
      : `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    if (rpcId === undefined) {
      this.writeJsonRpcError(res, null, JSON_RPC_INVALID, "tools/call requires an id");
      return;
    }

    const pending: PendingCall = {
      toolUseId,
      rpcId,
      res,
      resolved: false,
      receivedAt: Date.now(),
    };
    ctx.pending.set(toolUseId, pending);

    // If the client socket dies, drop the pending entry so we don't leak.
    res.once("close", () => {
      if (!pending.resolved) {
        pending.resolved = true;
        ctx.pending.delete(toolUseId);
      }
    });

    const captured: CapturedToolUse = { toolUseId, name, args };
    const waiter = ctx.waiters.shift();
    if (waiter) {
      waiter.resolve(captured);
    }
    // No waiter yet: the bridge's flow hasn't reached `awaitNextToolCall`
    // yet. The pending entry stays until it's claimed + resolved. This is
    // safe because --max-turns enforces one tool_use at a time per turn.
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private sessionKeyFromUrl(url: string): string | null {
    // URL arrives as `/<sessionKey>` or `/<sessionKey>?...`
    const path = url.split("?")[0].replace(/^\/+/, "").replace(/\/+$/, "");
    if (!path) return null;
    try {
      return decodeURIComponent(path);
    } catch {
      return null;
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      req.on("error", reject);
    });
  }

  private writeJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  private writeJsonRpc(res: ServerResponse, id: number | string | undefined, result: unknown): void {
    this.writeJson(res, 200, { jsonrpc: "2.0", id: id ?? null, result });
  }

  private writeJsonRpcError(
    res: ServerResponse,
    id: number | string | null | undefined,
    code: number,
    message: string,
  ): void {
    this.writeJson(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
  }

  private finishResponse(pending: PendingCall, body: Record<string, unknown>): void {
    pending.resolved = true;
    try {
      this.writeJson(pending.res, 200, { jsonrpc: "2.0", id: pending.rpcId, ...body });
    } catch {
      // Socket already closed — nothing to do, pending is already flagged.
    }
  }

  private normalizeContent(content: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(content)) return content as Array<Record<string, unknown>>;
    if (typeof content === "string") return [{ type: "text", text: content }];
    if (content && typeof content === "object") {
      return [content as Record<string, unknown>];
    }
    return [{ type: "text", text: String(content) }];
  }
}
