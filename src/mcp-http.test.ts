import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { BridgeMcpHttpServer } from "./mcp-http.ts";

/** Build a tiny ServerResponse-like stub. We only care about writeHead/end
 *  not throwing — the bridge writes a JSON-RPC payload then closes. */
function makeStubRes(): ServerResponse {
  const headers: Record<string, unknown> = {};
  let writtenStatus = 0;
  let writtenBody = "";
  return {
    writeHead(status: number, hdrs?: Record<string, unknown>) {
      writtenStatus = status;
      if (hdrs) Object.assign(headers, hdrs);
      return this;
    },
    end(body?: string) {
      writtenBody = body ?? "";
      return this;
    },
    once() {
      return this;
    },
    on() {
      return this;
    },
    get statusCode() {
      return writtenStatus;
    },
    get body() {
      return writtenBody;
    },
  } as unknown as ServerResponse;
}

test("tryResolveToolCall: returns false when session not registered", () => {
  const server = new BridgeMcpHttpServer();
  const ok = server.tryResolveToolCall("missing-session", "toolu_x", "result");
  assert.equal(ok, false);
});

test("tryResolveToolCall: returns false when pending entry missing", () => {
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  const ok = server.tryResolveToolCall("s1", "toolu_x", "result");
  assert.equal(ok, false);
});

test("resolveToolCall: still throws when pending missing (backward compat)", () => {
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  assert.throws(
    () => server.resolveToolCall("s1", "toolu_x", "result"),
    /no pending tool call: toolu_x/,
  );
});

test("tryResolveToolCall: returns true on successful resolve, deletes pending", () => {
  const server = new BridgeMcpHttpServer();
  server.registerSession("s1", []);
  // Inject a pending entry directly via the internal map. We can't easily
  // simulate the full HTTP roundtrip in a unit test, but we can verify the
  // resolve path works on whatever the bridge has tracked.
  const sessions = (server as unknown as { sessions: Map<string, { pending: Map<string, unknown> }> })
    .sessions;
  const ctx = sessions.get("s1");
  assert.ok(ctx);
  const stub = makeStubRes();
  ctx.pending.set("toolu_x", {
    toolUseId: "toolu_x",
    rpcId: 1,
    res: stub,
    resolved: false,
    receivedAt: Date.now(),
  });
  const ok = server.tryResolveToolCall("s1", "toolu_x", "the result");
  assert.equal(ok, true);
  // After resolve, the entry should be removed.
  assert.equal(ctx.pending.has("toolu_x"), false);
});
