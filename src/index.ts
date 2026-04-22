import { startServer } from "./server.js";
import { configurePool } from "./cli-worker.js";

const port = parseInt(process.env.CLAUDE_BRIDGE_PORT ?? "3456", 10);
const host = process.env.CLAUDE_BRIDGE_HOST ?? "127.0.0.1";
const timeoutMs = parseInt(process.env.CLAUDE_BRIDGE_TIMEOUT_MS ?? "300000", 10);
const maxConcurrent = parseInt(
  process.env.CLAUDE_BRIDGE_MAX_CONCURRENT ?? "8",
  10,
);
const maxSessions = parseInt(
  process.env.CLAUDE_BRIDGE_MAX_SESSIONS ?? "200",
  10,
);

configurePool({ timeoutMs, maxConcurrent, maxSessions });

console.log("╔══════════════════════════════════════════╗");
console.log("║        Claude Bridge v3.2.0              ║");
console.log("║  OpenAI-compatible → Claude CLI          ║");
console.log("╚══════════════════════════════════════════╝");
console.log("");
console.log(`  Timeout:        ${timeoutMs}ms`);
console.log(`  Max concurrent: ${maxConcurrent}`);
console.log(`  Max sessions:   ${maxSessions}`);
console.log(`  Bind:           ${host}:${port}`);
console.log(`  API:            http://${host}:${port}/v1/chat/completions`);
console.log("");

startServer({ port, host });
