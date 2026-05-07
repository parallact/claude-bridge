import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";

interface DebugConfig {
  enabled: boolean;
  filePath: string;
}

let config: DebugConfig = { enabled: false, filePath: "" };

export function configureDebugLogger(opts: {
  enabled: boolean;
  filePath?: string;
}): void {
  if (!opts.enabled) {
    config = { enabled: false, filePath: "" };
    return;
  }
  const date = new Date().toISOString().slice(0, 10);
  const filePath = opts.filePath ?? `/tmp/claude-bridge-debug-${date}.jsonl`;
  config = { enabled: true, filePath };
}

/**
 * Append one JSON record to the debug log. No-op when disabled. Never
 * throws — debug logging must never crash the bridge. Unserializable
 * payloads (cycles, BigInts) are dropped silently.
 */
export function debugLog(record: Record<string, unknown>): void {
  if (!config.enabled) return;
  let line: string;
  try {
    line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
  } catch {
    // Cyclic or otherwise unserializable. Drop.
    return;
  }
  try {
    fs.appendFileSync(config.filePath, line);
  } catch {
    // Filesystem error — disk full, perms, etc. Drop.
  }
}

export function newRequestId(): string {
  return randomUUID();
}

/** sha256 truncated to first 16 hex chars. Useful for fingerprinting
 *  long values (system prompts, tool schemas) without logging them. */
export function hashString(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
