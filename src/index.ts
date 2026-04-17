import { startServer } from "./server.js";
import { configurePool, initPool } from "./cli-worker.js";

const port = parseInt(process.env.CLAUDE_BRIDGE_PORT ?? "3456", 10);
const host = process.env.CLAUDE_BRIDGE_HOST ?? "0.0.0.0";
const poolSize = parseInt(process.env.CLAUDE_BRIDGE_POOL_SIZE ?? "10", 10);
const timeoutMs = parseInt(process.env.CLAUDE_BRIDGE_TIMEOUT_MS ?? "300000", 10);

configurePool({ poolSize, timeoutMs });

console.log("╔══════════════════════════════════════════╗");
console.log("║        Claude Bridge v3.0.0              ║");
console.log("║  OpenAI-compatible → Agent SDK pool      ║");
console.log("╚══════════════════════════════════════════╝");
console.log("");
console.log(`  Pool:    ${poolSize} pre-warmed workers`);
console.log(`  Timeout: ${timeoutMs}ms`);
console.log(`  Bind:    ${host}:${port}`);
console.log(`  API:     http://${host}:${port}/v1/chat/completions`);
console.log("");

// Pre-warm workers, then start server
initPool()
  .then(() => startServer({ port, host }))
  .catch((err) => {
    console.error("Failed to initialize:", err);
    process.exit(1);
  });
