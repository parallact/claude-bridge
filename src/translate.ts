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

export function buildPrompt(oai: OAIChatRequest): BuiltPrompt {
  const systemParts: string[] = [];
  const conversationParts: string[] = [];

  // Extract system messages and tool definitions into systemPrompt
  for (const msg of oai.messages) {
    if (msg.role === "system") {
      systemParts.push(extractText(msg.content));
    }
  }

  // Add tool definitions to system prompt (authoritative, not user text)
  if (oai.tools?.length) {
    const toolDefs = oai.tools
      .map((t) => {
        const fn = t.function;
        return `- ${fn.name}: ${fn.description ?? ""}\n  Parameters: ${JSON.stringify(fn.parameters ?? {})}`;
      })
      .join("\n");
    systemParts.push(
      [
        "<tools>",
        "You have access to the following tools and MUST use them when appropriate.",
        "To call a tool, output EXACTLY a <tool_call> XML tag with JSON inside.",
        "Format: <tool_call>{\"name\": \"tool_name\", \"arguments\": {\"param\": \"value\"}}</tool_call>",
        "",
        "CRITICAL RULES:",
        "- Output NOTHING after the closing </tool_call> tag. No explanation, no commentary. STOP immediately.",
        "- If you need multiple tool calls, output each on its own line.",
        "- Do NOT output <tool_result> tags — those come from the system, not from you.",
        "",
        toolDefs,
        "</tools>",
      ].join("\n"),
    );
  }

  // Build conversation prompt (user, assistant, tool messages only)
  for (const msg of oai.messages) {
    switch (msg.role) {
      case "system":
        // Already handled above
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
          conversationParts.push(
            `<previous_response>${combined}</previous_response>`,
          );
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

// ─── Tool Call Parsing (from CLI text response) ─────────────────────────────

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ParsedResponse {
  text: string | null;
  toolCalls: ParsedToolCall[];
}

let toolCallCounter = 0;

export function parseToolCallsFromText(raw: string): ParsedResponse {
  const toolCalls: ParsedToolCall[] = [];
  let text = raw;

  for (const match of raw.matchAll(TOOL_CALL_RE)) {
    const json = match[1];
    try {
      const parsed = JSON.parse(json);
      toolCalls.push({
        id: `call_${Date.now()}_${toolCallCounter++}`,
        name: parsed.name,
        arguments:
          typeof parsed.arguments === "string"
            ? parsed.arguments
            : JSON.stringify(parsed.arguments ?? {}),
      });
    } catch {
      continue;
    }
    text = text.replace(match[0], "");
  }

  // If tool calls were found, discard ALL remaining text.
  // The model sometimes adds commentary after tool calls — strip it.
  if (toolCalls.length > 0) {
    return { text: null, toolCalls };
  }

  text = text.trim();
  return { text: text || null, toolCalls };
}
