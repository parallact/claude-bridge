// ─── OpenAI Types (kept for request parsing) ───────────────────────────────

export interface OAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string; detail?: string };
}

export interface OAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OAITool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface OAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OAIContentPart[] | null;
  name?: string;
  tool_calls?: OAIToolCall[];
  tool_call_id?: string;
}

export interface OAIChatRequest {
  model: string;
  messages: OAIMessage[];
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: OAITool[];
  tool_choice?: string | { type: string; function?: { name: string } };
  stop?: string | string[];
  user?: string;
}

// ─── Anthropic Content Blocks ───────────────────────────────────────────────

export type ImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageSource }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: ContentBlock[] | string;
      is_error?: boolean;
    };

/**
 * Convert OpenAI-shape message content into Anthropic content blocks.
 * Preserves images (both data-URL and http) and text. Unknown OAI part
 * types are dropped silently — caller should validate upstream.
 */
export function toContentBlocks(content: OAIMessage["content"]): ContentBlock[] {
  if (content == null) return [];
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: "text", text: content }];
  }
  if (!Array.isArray(content)) {
    return [{ type: "text", text: String(content) }];
  }
  const blocks: ContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text" && part.text != null) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url" && part.image_url) {
      blocks.push(toImageBlock(part.image_url));
    }
    // unknown types: drop. Stage 1 only handles text + image.
  }
  return blocks;
}

function toImageBlock(image: { url: string; detail?: string }): ContentBlock {
  // Data URL: data:<media-type>;base64,<data>
  const dataUrlMatch = image.url.match(/^data:([^;]+);base64,(.+)$/);
  if (dataUrlMatch) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: dataUrlMatch[1],
        data: dataUrlMatch[2],
      },
    };
  }
  return { type: "image", source: { type: "url", url: image.url } };
}

// ─── Prompt Building ────────────────────────────────────────────────────────

export interface BuiltPrompt {
  prompt: string;
  systemPrompt: string | undefined;
}

/**
 * Assemble the text sent to Claude CLI.
 *
 * Tool definitions are no longer injected here — they are registered through
 * an MCP stdio server so the model sees them as structured tools. Historical
 * tool_calls and tool_result messages still need narration because Claude CLI
 * stores its own session state and we don't rewrite that state; the narration
 * keeps the model grounded when a session is resumed or a new session is
 * primed with prior turns.
 */
export function buildPrompt(oai: OAIChatRequest): BuiltPrompt {
  const systemParts: string[] = [];
  const conversationParts: string[] = [];

  for (const msg of oai.messages) {
    if (msg.role === "system") {
      systemParts.push(extractText(msg.content));
    }
  }

  for (const msg of oai.messages) {
    switch (msg.role) {
      case "system":
        break;
      case "user":
        conversationParts.push(extractText(msg.content));
        break;
      case "assistant": {
        const text = extractText(msg.content);
        const toolParts: string[] = [];
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            toolParts.push(
              `<tool_call>{"name":"${tc.function.name}","arguments":${tc.function.arguments}}</tool_call>`,
            );
          }
        }
        const combined = [text, ...toolParts].filter(Boolean).join("\n");
        if (combined) {
          conversationParts.push(`<previous_response>${combined}</previous_response>`);
        }
        break;
      }
      case "tool":
        conversationParts.push(
          `<tool_result tool_call_id="${msg.tool_call_id ?? ""}">${extractText(msg.content)}</tool_result>`,
        );
        break;
    }
  }

  return {
    prompt: conversationParts.join("\n\n"),
    systemPrompt: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
  };
}

export function extractText(content: OAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return String(content ?? "");
}

export function toolsFromRequest(
  oai: OAIChatRequest,
): Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> {
  if (!oai.tools?.length) return [];
  return oai.tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    inputSchema: (t.function.parameters as Record<string, unknown>) ?? {
      type: "object",
      properties: {},
    },
  }));
}

// ─── Path D extraction ──────────────────────────────────────────────────────

export interface PathDExtracted {
  systemPrompt: string | undefined;
  /** Fresh user text to feed the persistent CLI. Empty string when the
   *  request is a pure continuation (tool_result delivery). */
  lastUserText: string;
  /** When the caller is delivering a tool_result, this is the payload +
   *  the tool_use id it resolves. */
  pendingToolResult:
    | { toolUseId: string; content: Array<Record<string, unknown>> | string }
    | null;
}

/**
 * Extract just the information Path D needs from an OpenAI request.
 * Unlike buildPrompt, this is *incremental*: the persistent CLI already
 * holds the prior conversation in memory, so we only care about the last
 * message the caller sent (a fresh user message OR a tool_result).
 *
 * - Last role=tool (OAI-native) → continuation. `tool_call_id` is the id
 *   of the tool_use block this result belongs to.
 * - Last role=user with a tool_result content block (Anthropic-style
 *   adapter) → continuation. Extract `tool_use_id` + `content`.
 * - Last role=user with text content → initial. Pack the text.
 *
 * Returns null if the shape is something we don't handle (e.g. no
 * messages). Caller should fall back to the v3.3 path.
 */
export function extractForPathD(oai: OAIChatRequest): PathDExtracted | null {
  if (!oai.messages?.length) return null;
  const systemParts: string[] = [];
  for (const msg of oai.messages) {
    if (msg.role === "system") systemParts.push(extractText(msg.content));
  }
  const systemPrompt = systemParts.length > 0 ? systemParts.join("\n\n") : undefined;

  const last = oai.messages[oai.messages.length - 1];
  if (!last) return null;

  if (last.role === "tool") {
    const toolUseId = last.tool_call_id;
    if (!toolUseId) return null;
    return {
      systemPrompt,
      lastUserText: "",
      pendingToolResult: {
        toolUseId,
        content: extractText(last.content),
      },
    };
  }

  if (last.role === "user") {
    // Anthropic-style tool_result carried inside a user message. Only the
    // first tool_result block in the message is honored — with --max-turns
    // 1 semantics there should only be one anyway. OAIContentPart.type is
    // only "text" | "image_url" in our public type; callers using the
    // Anthropic adapter add "tool_result" at runtime, so cast-via-unknown.
    if (Array.isArray(last.content)) {
      const parts = last.content as unknown as Array<Record<string, unknown>>;
      for (const part of parts) {
        if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
          const content = part.content as
            | Array<Record<string, unknown>>
            | string
            | undefined;
          return {
            systemPrompt,
            lastUserText: "",
            pendingToolResult: {
              toolUseId: part.tool_use_id,
              content: content ?? "",
            },
          };
        }
      }
    }
    return {
      systemPrompt,
      lastUserText: extractText(last.content),
      pendingToolResult: null,
    };
  }

  // Last message is assistant or system — doesn't match either pattern.
  return null;
}
