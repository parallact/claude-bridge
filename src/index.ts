import { startServer } from "./server.js";
import { configurePool } from "./cli-worker.js";

const port = parseInt(process.env.CLAUDE_BRIDGE_PORT ?? "3456", 10);
const host = process.env.CLAUDE_BRIDGE_HOST ?? "0.0.0.0";
const timeoutMs = parseInt(process.env.CLAUDE_BRIDGE_TIMEOUT_MS ?? "300000", 10);

configurePool({ timeoutMs });

console.log("╔══════════════════════════════════════════╗");
console.log("║        Claude Bridge v3.1.0              ║");
console.log("║  OpenAI-compatible → Claude CLI          ║");
console.log("╚══════════════════════════════════════════╝");
console.log("");
console.log(`  Timeout: ${timeoutMs}ms`);
console.log(`  Bind:    ${host}:${port}`);
console.log(`  API:     http://${host}:${port}/v1/chat/completions`);
console.log("");

startServer({ port, host });
