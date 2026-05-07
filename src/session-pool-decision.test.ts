import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSessionAction } from "./session-pool-decision.ts";

test("decideSessionAction: no existing → spawn fresh", () => {
  const result = decideSessionAction({
    existing: undefined,
    specFp: "abc",
    config: { maxLifetimeMs: 3_600_000 },
    now: 1_000_000,
  });
  assert.deepEqual(result, { action: "spawn" });
});

test("decideSessionAction: existing alive + matching fp + within lifetime → reuse", () => {
  const result = decideSessionAction({
    existing: { dead: false, specFp: "abc", createdAt: 999_500 },
    specFp: "abc",
    config: { maxLifetimeMs: 3_600_000 },
    now: 1_000_000,
  });
  assert.deepEqual(result, { action: "reuse" });
});

test("decideSessionAction: existing dead → respawn", () => {
  const result = decideSessionAction({
    existing: { dead: true, specFp: "abc", createdAt: 999_500 },
    specFp: "abc",
    config: { maxLifetimeMs: 3_600_000 },
    now: 1_000_000,
  });
  assert.deepEqual(result, { action: "respawn" });
});

test("decideSessionAction: spec_fp mismatch → respawn", () => {
  const result = decideSessionAction({
    existing: { dead: false, specFp: "abc", createdAt: 999_500 },
    specFp: "xyz",
    config: { maxLifetimeMs: 3_600_000 },
    now: 1_000_000,
  });
  assert.deepEqual(result, { action: "respawn" });
});

test("decideSessionAction: lifetime exceeded → respawn", () => {
  const result = decideSessionAction({
    existing: { dead: false, specFp: "abc", createdAt: 0 },
    specFp: "abc",
    config: { maxLifetimeMs: 3_600_000 },
    now: 4_000_000,
  });
  assert.deepEqual(result, { action: "respawn" });
});
