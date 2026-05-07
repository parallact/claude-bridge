/** Pool config slice that decideSessionAction needs. Keeping this type
 *  local so the file has zero imports — keeps the test runner happy
 *  under --experimental-strip-types (no .js cascade). */
export interface DecisionConfig {
  maxLifetimeMs: number;
}

export type SessionAction =
  | { action: "spawn" }
  | { action: "reuse" }
  | { action: "respawn" };

/** Pure decision function: should we reuse, respawn, or spawn fresh?
 *  Extracted from acquire() for testability and to remove a fragile
 *  `createdAt === lastUsed` heuristic. */
export function decideSessionAction(args: {
  existing: { dead: boolean; specFp: string; createdAt: number } | undefined;
  specFp: string;
  config: DecisionConfig;
  now: number;
}): SessionAction {
  const { existing, specFp, config, now } = args;
  if (!existing) return { action: "spawn" };
  if (existing.dead) return { action: "respawn" };
  if (existing.specFp !== specFp) return { action: "respawn" };
  if (now - existing.createdAt > config.maxLifetimeMs) return { action: "respawn" };
  return { action: "reuse" };
}
