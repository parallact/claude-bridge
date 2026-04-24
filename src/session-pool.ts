/**
 * Persistent Claude CLI sessions for Path D.
 *
 * One `claude` child per sessionKey. Spawned with --input-format stream-json
 * and --output-format stream-json so we can feed user messages over time and
 * consume structured events live. Paired with the bridge's in-process MCP
 * HTTP server: the CLI's --mcp-config URL points at a per-session endpoint
 * on that server, so tool_use blocks that the model emits get PARKED (the
 * MCP tools/call HTTP response held open) until the external caller
 * delivers the real tool_result.
 *
 * Lifecycle:
 *   acquire(key, spec) — returns existing session if compatible; otherwise
 *   tears down the stale one and spawns fresh. `spec` includes tools
 *   fingerprint + system prompt fingerprint + model; any mismatch means
 *   the in-memory CLI conversation assumes a world that no longer matches
 *   the caller's context, so we respawn.
 *
 *   Idle eviction runs in the background: sessions unused for
 *   IDLE_EVICT_MS are torn down to free claude processes.
 *
 *   On crash (stream closed unexpectedly), the session is marked dead and
 *   in-flight waiters fail. The next acquire() respawns cleanly.
 *
 * Sequencing:
 *   A session handles ONE turn at a time. The bridge's per-session
 *   serialization lock (from Sprint 1) ensures only one OpenAI request per
 *   session is in flight, so we never race sendUserMessage calls.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BridgeMcpHttpServer, CapturedToolUse, McpTool } from "./mcp-http.js";
import { linesOf, parseStream, type StreamEventHandlers } from "./stream-parser.js";

export interface SessionSpec {
  model: string;
  tools: McpTool[];
  systemPrompt: string | undefined;
  /** Fingerprint used to decide whether an existing session is reusable.
   *  Caller builds this — typically sha256(sortedTools + systemPrompt). */
  spec_fp: string;
}

export interface TurnCheckpoint {
  /** Text accumulated since the last checkpoint. May be empty string. */
  text: string;
  /** If the model emitted a tool_use that's now parked in the MCP server,
   *  waiting for a real result. Exactly one tool_use per checkpoint — the
   *  CLI blocks on MCP before emitting more. */
  toolUse: CapturedToolUse | null;
  /** Present when the turn completed (model emitted `result` event). */
  result: {
    stopReason: string;
    inputTokens: number;
    outputTokens: number;
    rateLimitStatus: string | undefined;
    isError: boolean;
    errorMessage: string | undefined;
  } | null;
}

export interface PoolConfig {
  /** Kill idle sessions after this many ms with no activity. */
  idleEvictMs: number;
  /** Max wall-clock lifetime per session; killed + respawned beyond this. */
  maxLifetimeMs: number;
  /** Hard cap on how many persistent sessions can exist simultaneously. */
  maxSessions: number;
  /** How long a waiter on nextCheckpoint is willing to block. */
  nextCheckpointTimeoutMs: number;
}

const DEFAULT_CONFIG: PoolConfig = {
  idleEvictMs: 10 * 60_000,
  maxLifetimeMs: 60 * 60_000,
  maxSessions: 32,
  nextCheckpointTimeoutMs: 300_000,
};

// ─── PersistentSession ──────────────────────────────────────────────────────

class PersistentSession {
  readonly sessionKey: string;
  readonly sessionId: string;
  readonly spec_fp: string;
  readonly model: string;
  private proc: ChildProcess;
  private mcpUrl: string;

  readonly createdAt: number;
  lastUsed: number;

  /** True once `close` fires on the child process. New operations must
   *  check and acquire(). */
  private _dead = false;
  /** Queue of significant events accumulated from the stream-json output.
   *  `null` marker = result/close event, tells consumers the turn ended. */
  private eventBuffer: TurnEvent[] = [];
  /** Pending consumer waiting for the next significant event. */
  private pendingRead: ((evt: TurnEvent | null) => void) | null = null;
  /** Accumulated assistant text since the last checkpoint was read. */
  private pendingText = "";
  /** Reader promise; rejects on stream error. */
  private readerDone: Promise<void>;

  constructor(args: {
    sessionKey: string;
    sessionId: string;
    spec_fp: string;
    model: string;
    proc: ChildProcess;
    mcpUrl: string;
  }) {
    this.sessionKey = args.sessionKey;
    this.sessionId = args.sessionId;
    this.spec_fp = args.spec_fp;
    this.model = args.model;
    this.proc = args.proc;
    this.mcpUrl = args.mcpUrl;
    this.createdAt = Date.now();
    this.lastUsed = this.createdAt;

    this.proc.once("close", () => {
      this._dead = true;
      // Unblock any pending read so consumers don't hang.
      if (this.pendingRead) {
        const cb = this.pendingRead;
        this.pendingRead = null;
        cb(null);
      }
    });

    this.readerDone = this.consumeStream();
    // Avoid unhandled rejection warnings; the session surfaces errors via
    // checkpoint `.result.isError` or by throwing on dead-session calls.
    this.readerDone.catch(() => {});
  }

  get dead(): boolean {
    return this._dead;
  }

  /** Writes a user message to the CLI over stdin. */
  sendUserMessage(text: string): void {
    if (this._dead) throw new Error("session is dead");
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    });
    this.proc.stdin?.write(`${line}\n`);
    this.lastUsed = Date.now();
  }

  /** Reads events from the stream until the next tool_use or result.
   *  Accumulated text deltas are rolled up into the returned checkpoint's
   *  `text` field so the caller sees a coherent assistant turn. */
  async nextCheckpoint(
    handlers?: StreamEventHandlers,
    timeoutMs = DEFAULT_CONFIG.nextCheckpointTimeoutMs,
  ): Promise<TurnCheckpoint> {
    if (this._dead) throw new Error("session is dead");
    this.lastUsed = Date.now();
    const deadline = Date.now() + timeoutMs;
    let text = this.pendingText;
    this.pendingText = "";
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`nextCheckpoint timeout after ${timeoutMs}ms`);
      const evt = await this.readOne(remaining);
      if (!evt) {
        // Stream closed without a result event — treat as error.
        return {
          text,
          toolUse: null,
          result: {
            stopReason: "error",
            inputTokens: 0,
            outputTokens: 0,
            rateLimitStatus: undefined,
            isError: true,
            errorMessage: "CLI stream closed unexpectedly",
          },
        };
      }
      if (evt.type === "text") {
        text += evt.delta;
        handlers?.onTextDelta?.(evt.delta);
        continue;
      }
      if (evt.type === "tool_use") {
        handlers?.onToolUse?.({ id: evt.tu.toolUseId, name: evt.tu.name, input: evt.tu.args });
        return { text, toolUse: evt.tu, result: null };
      }
      // evt.type === "result"
      return { text, toolUse: null, result: evt.result };
    }
  }

  /** Tear down the CLI child. Idempotent. */
  destroy(): void {
    if (this._dead) return;
    this._dead = true;
    if (this.pendingRead) {
      const cb = this.pendingRead;
      this.pendingRead = null;
      cb(null);
    }
    try {
      this.proc.stdin?.end();
    } catch {}
    try {
      this.proc.kill("SIGTERM");
    } catch {}
    // SIGKILL fallback if still alive after 2s
    setTimeout(() => {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
    }, 2000).unref();
  }

  get mcpEndpoint(): string {
    return this.mcpUrl;
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private readOne(timeoutMs: number): Promise<TurnEvent | null> {
    if (this.eventBuffer.length > 0) {
      return Promise.resolve(this.eventBuffer.shift()!);
    }
    if (this._dead) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingRead === cb) this.pendingRead = null;
        resolve(null);
      }, timeoutMs);
      timer.unref();
      const cb = (evt: TurnEvent | null) => {
        clearTimeout(timer);
        resolve(evt);
      };
      this.pendingRead = cb;
    });
  }

  private emit(evt: TurnEvent): void {
    if (this.pendingRead) {
      const cb = this.pendingRead;
      this.pendingRead = null;
      cb(evt);
    } else {
      this.eventBuffer.push(evt);
    }
  }

  private async consumeStream(): Promise<void> {
    if (!this.proc.stdout) return;
    // Feed parseStream via handlers so we don't rewrite event parsing.
    // parseStream treats the input as a single "turn"; for persistent
    // multi-turn we need to reset it each time a `result` comes. So we
    // implement the loop here directly, reusing the line iterator.
    const lines = linesOf(this.proc.stdout);
    let outputTokens = 0;
    let inputTokens = 0;
    let rateLimitStatus: string | undefined;
    let sawUserInjection = false;
    for await (const line of lines) {
      if (!line.trim()) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = evt.type;
      if (type === "rate_limit_event") {
        const info = evt.rate_limit_info as { status?: string } | undefined;
        rateLimitStatus = info?.status;
        continue;
      }
      if (type === "assistant" && !sawUserInjection) {
        const message = evt.message as
          | { content?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number } }
          | undefined;
        for (const block of message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            this.emit({ type: "text", delta: block.text as string });
          } else if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            this.emit({
              type: "tool_use",
              tu: {
                toolUseId: block.id as string,
                name: block.name as string,
                args: (block.input ?? {}) as Record<string, unknown>,
              },
            });
          }
        }
        const usage = message?.usage;
        if (usage) {
          if (typeof usage.input_tokens === "number") inputTokens = usage.input_tokens;
          if (typeof usage.output_tokens === "number") outputTokens = usage.output_tokens;
        }
        continue;
      }
      if (type === "user") {
        // CLI injected a synthetic user message (the tool_result coming back
        // from MCP resolution). We absorbed it and the model will react in
        // the next assistant event — no need to surface it.
        sawUserInjection = true;
        continue;
      }
      if (type === "result") {
        const stopReason = typeof evt.stop_reason === "string" ? (evt.stop_reason as string) : "end_turn";
        const isError = evt.is_error === true;
        const errs = evt.errors as string[] | undefined;
        const errorMessage = isError ? (errs?.[0] ?? (typeof evt.result === "string" ? (evt.result as string) : undefined)) : undefined;
        this.emit({
          type: "result",
          result: {
            stopReason,
            inputTokens,
            outputTokens,
            rateLimitStatus,
            isError,
            errorMessage,
          },
        });
        // Reset per-turn state for the next user message.
        sawUserInjection = false;
        outputTokens = 0;
        inputTokens = 0;
        rateLimitStatus = undefined;
      }
    }
  }
}

type TurnEvent =
  | { type: "text"; delta: string }
  | { type: "tool_use"; tu: CapturedToolUse }
  | { type: "result"; result: TurnCheckpoint["result"] };

// ─── PersistentSessionPool ──────────────────────────────────────────────────

export interface SpawnContext {
  mcpServer: BridgeMcpHttpServer;
  config: PoolConfig;
}

export class PersistentSessionPool {
  private readonly mcpServer: BridgeMcpHttpServer;
  private readonly config: PoolConfig;
  private readonly sessions = new Map<string, PersistentSession>();
  private evictTimer: NodeJS.Timeout | null = null;

  constructor(ctx: SpawnContext) {
    this.mcpServer = ctx.mcpServer;
    this.config = ctx.config;
    this.evictTimer = setInterval(() => this.evictIdle(), 60_000);
    this.evictTimer.unref();
  }

  /** Get an existing session for this key if compatible, else respawn. */
  acquire(sessionKey: string, spec: SessionSpec): PersistentSession {
    const existing = this.sessions.get(sessionKey);
    if (existing && !existing.dead && existing.spec_fp === spec.spec_fp) {
      if (Date.now() - existing.createdAt > this.config.maxLifetimeMs) {
        this.teardown(sessionKey);
      } else {
        existing.lastUsed = Date.now();
        return existing;
      }
    } else if (existing) {
      this.teardown(sessionKey);
    }

    if (this.sessions.size >= this.config.maxSessions) {
      // Evict the least-recently-used session to make room.
      let oldestKey: string | null = null;
      let oldestTs = Infinity;
      for (const [k, s] of this.sessions) {
        if (s.lastUsed < oldestTs) {
          oldestTs = s.lastUsed;
          oldestKey = k;
        }
      }
      if (oldestKey) this.teardown(oldestKey);
    }

    return this.spawnNew(sessionKey, spec);
  }

  /** Explicit teardown. */
  teardown(sessionKey: string): void {
    const s = this.sessions.get(sessionKey);
    if (!s) return;
    s.destroy();
    this.mcpServer.unregisterSession(sessionKey);
    this.sessions.delete(sessionKey);
  }

  size(): number {
    return this.sessions.size;
  }

  stats(): { total: number; oldestAgeMs: number | null; idleAgeMs: number | null } {
    if (this.sessions.size === 0) return { total: 0, oldestAgeMs: null, idleAgeMs: null };
    const now = Date.now();
    let oldest = 0;
    let idle = 0;
    for (const s of this.sessions.values()) {
      oldest = Math.max(oldest, now - s.createdAt);
      idle = Math.max(idle, now - s.lastUsed);
    }
    return { total: this.sessions.size, oldestAgeMs: oldest, idleAgeMs: idle };
  }

  async shutdown(): Promise<void> {
    if (this.evictTimer) {
      clearInterval(this.evictTimer);
      this.evictTimer = null;
    }
    for (const key of [...this.sessions.keys()]) this.teardown(key);
  }

  // ─── Internals ────────────────────────────────────────────────────────

  private spawnNew(sessionKey: string, spec: SessionSpec): PersistentSession {
    const sessionId = randomUUID();
    this.mcpServer.registerSession(sessionKey, spec.tools);
    const mcpUrl = this.mcpServer.urlFor(sessionKey);

    const mcpConfig = JSON.stringify({
      mcpServers: {
        openclaw: { type: "http", url: mcpUrl },
      },
    });
    const allowedTools = spec.tools.length > 0
      ? spec.tools.map((t) => `mcp__openclaw__${t.name}`).join(",")
      : "";

    const args = [
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      spec.model,
      // Conservative cap per message: the persistent-CLI flow is one
      // user message → one tool_use round (blocks on MCP) → continuation →
      // final text. If the model chains multiple tools within a single turn
      // we bump this, but the bridge normally returns each tool_use to the
      // external caller so the caller drives the chain.
      "--max-turns",
      "8",
      "--tools",
      "",
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--session-id",
      sessionId,
    ];
    if (spec.systemPrompt) args.push("--system-prompt", spec.systemPrompt);
    if (allowedTools) args.push("--allowedTools", allowedTools);

    const proc = spawn("claude", args, {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const session = new PersistentSession({
      sessionKey,
      sessionId,
      spec_fp: spec.spec_fp,
      model: spec.model,
      proc,
      mcpUrl,
    });
    this.sessions.set(sessionKey, session);
    return session;
  }

  private evictIdle(): void {
    const now = Date.now();
    for (const [key, s] of this.sessions) {
      const idleFor = now - s.lastUsed;
      const ageFor = now - s.createdAt;
      if (s.dead || idleFor > this.config.idleEvictMs || ageFor > this.config.maxLifetimeMs) {
        this.teardown(key);
      }
    }
  }
}
