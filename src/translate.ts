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

// ─── Prompt Building (OpenAI messages → text for CLI) ───────────────────────

export function buildPrompt(oai: OAIChatRequest): string {
  const parts: string[] = [];

  for (const msg of oai.messages) {
    switch (msg.role) {
      case "system":
        parts.push(`<system>${extractText(msg.content)}</system>`);
        break;
      case "user":
        parts.push(extractText(msg.content));
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
          parts.push(`<previous_response>${combined}</previous_response>`);
        }
        break;
      }
      case "tool":
        parts.push(
          `<tool_result tool_call_id="${msg.tool_call_id ?? ""}">${extractText(msg.content)}</tool_result>`,
        );
        break;
    }
  }

  // Inject tool definitions if present
  if (oai.tools?.length) {
    const toolDefs = oai.tools
      .map((t) => {
        const fn = t.function;
        return `- ${fn.name}: ${fn.description ?? ""}\n  Parameters: ${JSON.stringify(fn.parameters ?? {})}`;
      })
      .join("\n");
    parts.unshift(
      `<tools>\nYou have access to the following tools. To call a tool, output a <tool_call> XML tag with JSON inside.\nFormat: <tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>\n\n${toolDefs}\n</tools>`,
    );
  }

  return parts.join("\n\n");
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

export function translateToolChoice(
  _choice: string | { type: string; function?: { name: string } },
): string {
  // Placeholder — CLI doesn't support tool_choice directly
  return "auto";
}
