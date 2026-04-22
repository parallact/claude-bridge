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
