// ─── OpenAI Types ───────────────────────────────────────────────────────────

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

export interface OAIChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface OAIStreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: "assistant";
      content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: "function";
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason: string | null;
  }>;
}

// ─── Anthropic Types ────────────────────────────────────────────────────────

export type AnthropicContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
    };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  max_tokens: number;
  system?: string;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  tools?: AnthropicTool[];
  tool_choice?: { type: string; name?: string };
  stop_sequences?: string[];
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

// ─── Request Translation (OpenAI → Anthropic) ──────────────────────────────

export function translateRequest(
  oai: OAIChatRequest,
  anthropicModel: string,
): AnthropicRequest {
  const systemParts: string[] = [];
  const messages: AnthropicMessage[] = [];

  for (const msg of oai.messages) {
    switch (msg.role) {
      case "system":
        systemParts.push(extractText(msg.content));
        break;
      case "user":
        messages.push({ role: "user", content: translateContent(msg.content) });
        break;
      case "assistant":
        messages.push({
          role: "assistant",
          content: translateAssistant(msg),
        });
        break;
      case "tool":
        appendToolResult(messages, msg);
        break;
    }
  }

  // Anthropic requires alternating user/assistant. Merge consecutive same-role messages.
  const merged = mergeConsecutiveMessages(messages);

  const result: AnthropicRequest = {
    model: anthropicModel,
    messages: merged,
    max_tokens: oai.max_tokens ?? oai.max_completion_tokens ?? 4096,
  };

  if (systemParts.length > 0) result.system = systemParts.join("\n\n");
  if (oai.temperature !== undefined) result.temperature = oai.temperature;
  if (oai.top_p !== undefined) result.top_p = oai.top_p;
  if (oai.stream !== undefined) result.stream = oai.stream;
  if (oai.tools?.length) result.tools = oai.tools.map(translateTool);
  if (oai.tool_choice !== undefined)
    result.tool_choice = translateToolChoice(oai.tool_choice);
  if (oai.stop) {
    result.stop_sequences = Array.isArray(oai.stop) ? oai.stop : [oai.stop];
  }

  return result;
}

function extractText(content: OAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return String(content ?? "");
}

function translateContent(
  content: OAIMessage["content"],
): string | AnthropicContentBlock[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  const blocks: AnthropicContentBlock[] = [];
  for (const part of content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text ?? "" });
    } else if (part.type === "image_url" && part.image_url) {
      const parsed = parseDataUrl(part.image_url.url);
      if (parsed) {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: parsed.mediaType,
            data: parsed.data,
          },
        });
      }
    }
  }
  return blocks.length === 1 && blocks[0].type === "text"
    ? blocks[0].text
    : blocks;
}

function translateAssistant(
  msg: OAIMessage,
): string | AnthropicContentBlock[] {
  const blocks: AnthropicContentBlock[] = [];

  // Text content
  const text = extractText(msg.content);
  if (text) blocks.push({ type: "text", text });

  // Tool calls → tool_use blocks
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = { _raw: tc.function.arguments };
      }
      blocks.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  if (blocks.length === 0) return "";
  if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text;
  return blocks;
}

function appendToolResult(messages: AnthropicMessage[], msg: OAIMessage): void {
  const block: AnthropicContentBlock = {
    type: "tool_result",
    tool_use_id: msg.tool_call_id ?? "",
    content: extractText(msg.content),
  };

  // Anthropic wants tool_result in a user message.
  // If the last message is already a user message with tool_result blocks, append.
  const last = messages[messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    const allToolResults = last.content.every(
      (b) =>
        (b as AnthropicContentBlock & { type: string }).type === "tool_result",
    );
    if (allToolResults) {
      (last.content as AnthropicContentBlock[]).push(block);
      return;
    }
  }

  messages.push({ role: "user", content: [block] });
}

function mergeConsecutiveMessages(
  messages: AnthropicMessage[],
): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  for (const msg of messages) {
    const last = result[result.length - 1];
    if (last && last.role === msg.role) {
      // Merge content
      const lastBlocks = toBlocks(last.content);
      const newBlocks = toBlocks(msg.content);
      last.content = [...lastBlocks, ...newBlocks];
    } else {
      result.push({ ...msg });
    }
  }
  return result;
}

function toBlocks(
  content: string | AnthropicContentBlock[],
): AnthropicContentBlock[] {
  if (typeof content === "string")
    return content ? [{ type: "text", text: content }] : [];
  return content;
}

function translateTool(tool: OAITool): AnthropicTool {
  return {
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters ?? { type: "object", properties: {} },
  };
}

function translateToolChoice(
  choice: string | { type: string; function?: { name: string } },
): { type: string; name?: string } {
  if (typeof choice === "string") {
    switch (choice) {
      case "auto":
        return { type: "auto" };
      case "none":
        return { type: "none" };
      case "required":
        return { type: "any" };
      default:
        return { type: "auto" };
    }
  }
  if (choice.type === "function" && choice.function?.name) {
    return { type: "tool", name: choice.function.name };
  }
  return { type: "auto" };
}

function parseDataUrl(
  url: string,
): { mediaType: string; data: string } | null {
  const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

// ─── Response Translation (Anthropic → OpenAI) ─────────────────────────────

export function translateResponse(
  resp: AnthropicResponse,
  requestModel: string,
): OAIChatResponse {
  let textContent = "";
  const toolCalls: OAIToolCall[] = [];

  for (const block of resp.content) {
    if (block.type === "text") {
      textContent += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const finishReason = translateStopReason(resp.stop_reason);
  const message: OAIChatResponse["choices"][0]["message"] = {
    role: "assistant",
    content: textContent || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  return {
    id: `chatcmpl-${resp.id}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: requestModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: resp.usage.input_tokens,
      completion_tokens: resp.usage.output_tokens,
      total_tokens: resp.usage.input_tokens + resp.usage.output_tokens,
    },
  };
}

function translateStopReason(reason: string | null): string {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return "stop";
  }
}

// ─── Streaming Translation ──────────────────────────────────────────────────

export interface StreamState {
  messageId: string;
  model: string;
  requestModel: string;
  toolCallIndex: number;
}

export function createStreamState(requestModel: string): StreamState {
  return { messageId: "", model: "", requestModel, toolCallIndex: -1 };
}

export function translateStreamEvent(
  eventType: string,
  data: Record<string, unknown>,
  state: StreamState,
): OAIStreamChunk | null {
  const ts = Math.floor(Date.now() / 1000);

  switch (eventType) {
    case "message_start": {
      const msg = data.message as Record<string, unknown>;
      state.messageId = (msg?.id as string) ?? `msg_${Date.now()}`;
      state.model = (msg?.model as string) ?? "";
      return makeChunk(state, ts, { role: "assistant", content: "" }, null);
    }

    case "content_block_start": {
      const block = data.content_block as Record<string, unknown>;
      if (block?.type === "tool_use") {
        state.toolCallIndex++;
        return makeChunk(
          state,
          ts,
          {
            tool_calls: [
              {
                index: state.toolCallIndex,
                id: block.id as string,
                type: "function" as const,
                function: {
                  name: block.name as string,
                  arguments: "",
                },
              },
            ],
          },
          null,
        );
      }
      return null;
    }

    case "content_block_delta": {
      const delta = data.delta as Record<string, unknown>;
      if (delta?.type === "text_delta") {
        return makeChunk(
          state,
          ts,
          { content: delta.text as string },
          null,
        );
      }
      if (delta?.type === "input_json_delta") {
        return makeChunk(
          state,
          ts,
          {
            tool_calls: [
              {
                index: state.toolCallIndex,
                function: { arguments: delta.partial_json as string },
              },
            ],
          },
          null,
        );
      }
      return null;
    }

    case "message_delta": {
      const delta = data.delta as Record<string, unknown>;
      const reason = translateStopReason(
        (delta?.stop_reason as string) ?? null,
      );
      return makeChunk(state, ts, {}, reason);
    }

    case "message_stop":
      return null; // We send [DONE] separately

    default:
      return null;
  }
}

function makeChunk(
  state: StreamState,
  created: number,
  delta: OAIStreamChunk["choices"][0]["delta"],
  finishReason: string | null,
): OAIStreamChunk {
  return {
    id: `chatcmpl-${state.messageId}`,
    object: "chat.completion.chunk",
    created,
    model: state.requestModel,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
