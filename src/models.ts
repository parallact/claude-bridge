export interface BridgeModel {
  id: string;
  anthropicId: string;
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsTools: boolean;
  supportsVision: boolean;
}

const MODELS: BridgeModel[] = [
  {
    id: "claude-opus-4",
    anthropicId: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    contextWindow: 200_000,
    maxOutputTokens: 32_768,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "claude-sonnet-4",
    anthropicId: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
  },
  {
    id: "claude-haiku-4",
    anthropicId: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsVision: true,
  },
];

// Allow overriding model mappings via env: JSON object of { alias: anthropicId }
let overrides: Record<string, string> = {};
try {
  const raw = process.env.CLAUDE_BRIDGE_MODEL_MAP;
  if (raw) overrides = JSON.parse(raw);
} catch {
  // ignore malformed override
}

export function resolveModel(requested: string): BridgeModel {
  // Check env overrides first
  if (overrides[requested]) {
    const found = MODELS.find((m) => m.anthropicId === overrides[requested]);
    if (found) return { ...found, id: requested };
    return makePassthrough(requested, overrides[requested]);
  }

  // Match by bridge ID
  const byId = MODELS.find((m) => m.id === requested);
  if (byId) return byId;

  // Match by Anthropic ID
  const byAnthropicId = MODELS.find((m) => m.anthropicId === requested);
  if (byAnthropicId) return byAnthropicId;

  // Passthrough: assume it's a valid Anthropic model ID
  return makePassthrough(requested, requested);
}

function makePassthrough(id: string, anthropicId: string): BridgeModel {
  return {
    id,
    anthropicId,
    name: id,
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    supportsVision: true,
  };
}

export function listModels(): BridgeModel[] {
  return MODELS;
}
