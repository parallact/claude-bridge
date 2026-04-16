# Claude Bridge

High-performance OpenAI-compatible proxy for Anthropic Claude API using OAuth tokens from Claude Max subscriptions.

**Zero CLI dependencies.** Unlike other proxies that spawn Claude Code CLI subprocesses (slow, sequential, fragile), this bridge makes direct API calls to Anthropic with native format translation. Full concurrency, real streaming, native tool calling.

## Architecture

```
OpenClaw/Client → Claude Bridge (port 3456) → api.anthropic.com
                       ↕
              OAuth token from env
              OpenAI ↔ Anthropic translation
```

## Features

- **Direct API calls** — no CLI subprocess overhead, handles concurrent requests
- **Native tool calling** — uses Anthropic's native tool API, not XML injection
- **Real streaming** — incremental SSE tokens including tool call streaming
- **Auto-retry** — exponential backoff on 429/529/5xx with retry-after support
- **Model mapping** — friendly aliases (`claude-sonnet-4`) to full Anthropic IDs
- **Vision support** — translates base64 image content between formats
- **Docker-ready** — multi-stage Dockerfile, health check, graceful shutdown
- **Zero runtime deps** — pure Node.js, no npm dependencies in production

## Quick Start

### Docker (recommended)

```bash
docker build -t claude-bridge .
docker run -p 3456:3456 -e ANTHROPIC_API_KEY=sk-ant-oat01-... claude-bridge
```

### Docker Compose (with OpenClaw)

Add to your `docker-compose.yml`:

```yaml
claude-bridge:
  build: /path/to/claude-bridge
  environment:
    ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
  ports:
    - "3456:3456"
  restart: unless-stopped
```

Then in `openclaw.json`, set the bridge provider's `baseUrl` to `http://claude-bridge:3456/v1`.

### Local

```bash
npm install && npm run build
ANTHROPIC_API_KEY=sk-ant-oat01-... npm start
```

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | OAuth token (`sk-ant-oat01-...`) or API key |
| `CLAUDE_BRIDGE_PORT` | `3456` | Listen port |
| `CLAUDE_BRIDGE_HOST` | `0.0.0.0` | Bind address |
| `CLAUDE_BRIDGE_TIMEOUT_MS` | `300000` | Request timeout (ms) |
| `CLAUDE_BRIDGE_MODEL_MAP` | `{}` | JSON override for model mappings |

## Available Models

| Bridge ID | Anthropic Model | Context |
|---|---|---|
| `claude-opus-4` | `claude-opus-4-20250514` | 200K |
| `claude-sonnet-4` | `claude-sonnet-4-5-20250514` | 200K |
| `claude-haiku-4` | `claude-haiku-4-5-20251001` | 200K |

Any unrecognized model name is passed through to Anthropic as-is.

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (streaming + non-streaming) |

## Extracting OAuth Token

From macOS with Claude Code installed:

```bash
security find-generic-password -s "Claude Code-credentials" -a "$(whoami)" -w \
  | python3 -c "import sys,json; print(json.loads(sys.stdin.read())['claudeAiOauth']['accessToken'])"
```

Token expires periodically. When it does, re-extract and update `ANTHROPIC_API_KEY`.

## License

MIT
