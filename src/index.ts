import { startServer } from "./server.js";

const config = {
  port: parseInt(process.env.CLAUDE_BRIDGE_PORT ?? "3456", 10),
  host: process.env.CLAUDE_BRIDGE_HOST ?? "0.0.0.0",
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_TOKEN ?? "",
  timeoutMs: parseInt(process.env.CLAUDE_BRIDGE_TIMEOUT_MS ?? "300000", 10),
};

if (!config.apiKey) {
  process.stderr.write(
    "ERROR: ANTHROPIC_API_KEY or CLAUDE_OAUTH_TOKEN must be set.\n" +
      "This should be your Claude Max OAuth token (sk-ant-oat01-...).\n" +
      "Extract from macOS keychain:\n" +
      '  security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w | python3 -c "import sys,json; print(json.loads(sys.stdin.read())[\'claudeAiOauth\'][\'accessToken\'])"\n',
  );
  process.exit(1);
}

console.log("╔══════════════════════════════════════════╗");
console.log("║        Claude Bridge v1.0.0              ║");
console.log("║  OpenAI-compatible → Anthropic API       ║");
console.log("╚══════════════════════════════════════════╝");
console.log("");
console.log(`  Token: ${config.apiKey.slice(0, 15)}...${config.apiKey.slice(-6)}`);
console.log(`  Bind:  ${config.host}:${config.port}`);
console.log(`  API:   http://${config.host}:${config.port}/v1/chat/completions`);
console.log("");

startServer(config);
