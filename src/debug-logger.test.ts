import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configureDebugLogger,
  debugLog,
  newRequestId,
  hashString,
} from "./debug-logger.ts";

test("debugLog: off by default — no file written", () => {
  // Reset to default state (no configure call)
  configureDebugLogger({ enabled: false });
  // Call debugLog with a record; we don't have a path so nothing should
  // happen. Verify no exception thrown and no /tmp file matching today's
  // date created from this single call (best-effort — there might be one
  // from prior runs, so we use a unique path instead via env override).
  const tmpFile = path.join(os.tmpdir(), `cb-debug-test-${Date.now()}.jsonl`);
  configureDebugLogger({ enabled: false, filePath: tmpFile });
  debugLog({ requestId: "x", path: "legacy", model: "y" });
  assert.equal(fs.existsSync(tmpFile), false, "should not create file when disabled");
});

test("debugLog: enabled — appends JSON line with timestamp", () => {
  const tmpFile = path.join(os.tmpdir(), `cb-debug-test-${Date.now()}.jsonl`);
  configureDebugLogger({ enabled: true, filePath: tmpFile });
  debugLog({ requestId: "abc", path: "legacy", model: "claude-sonnet-4" });
  const content = fs.readFileSync(tmpFile, "utf-8");
  assert.ok(content.endsWith("\n"), "line must end with newline");
  const parsed = JSON.parse(content.trim());
  assert.equal(parsed.requestId, "abc");
  assert.equal(parsed.path, "legacy");
  assert.equal(parsed.model, "claude-sonnet-4");
  assert.match(parsed.ts, /^\d{4}-\d{2}-\d{2}T/, "ts must be ISO-8601");
  fs.unlinkSync(tmpFile);
});

test("debugLog: handles unserializable values without throwing", () => {
  const tmpFile = path.join(os.tmpdir(), `cb-debug-test-${Date.now()}.jsonl`);
  configureDebugLogger({ enabled: true, filePath: tmpFile });
  const cyclic: Record<string, unknown> = { a: 1 };
  cyclic.self = cyclic;
  // Should not throw; record is dropped silently
  assert.doesNotThrow(() => debugLog({ requestId: "x", payload: cyclic }));
  // Cleanup if file was created
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
});

test("hashString: deterministic, returns 16-char hex", () => {
  const a = hashString("hello world");
  const b = hashString("hello world");
  const c = hashString("hello worlD");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("newRequestId: returns valid UUID", () => {
  const id = newRequestId();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
