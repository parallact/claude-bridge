import { test } from "node:test";
import assert from "node:assert/strict";
import { toContentBlocks } from "./translate.ts";

test("toContentBlocks: string content becomes single text block", () => {
  assert.deepEqual(toContentBlocks("hello"), [{ type: "text", text: "hello" }]);
});

test("toContentBlocks: empty string becomes empty array", () => {
  assert.deepEqual(toContentBlocks(""), []);
});

test("toContentBlocks: null/undefined becomes empty array", () => {
  assert.deepEqual(toContentBlocks(null), []);
  assert.deepEqual(toContentBlocks(undefined), []);
});

test("toContentBlocks: text part preserved", () => {
  assert.deepEqual(
    toContentBlocks([{ type: "text", text: "hi" }]),
    [{ type: "text", text: "hi" }],
  );
});

test("toContentBlocks: data-URL image becomes base64 image block", () => {
  const result = toContentBlocks([
    {
      type: "image_url",
      image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
    },
  ]);
  assert.deepEqual(result, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    },
  ]);
});

test("toContentBlocks: http image URL becomes url image block", () => {
  const result = toContentBlocks([
    { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
  ]);
  assert.deepEqual(result, [
    {
      type: "image",
      source: { type: "url", url: "https://example.com/cat.png" },
    },
  ]);
});

test("toContentBlocks: mixed text + image preserved in order", () => {
  const result = toContentBlocks([
    { type: "text", text: "look at this:" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,abc" } },
  ]);
  assert.equal(result.length, 2);
  assert.equal(result[0].type, "text");
  assert.equal(result[1].type, "image");
});

test("toContentBlocks: data-URL with charset param parses correctly", () => {
  const result = toContentBlocks([
    {
      type: "image_url",
      image_url: { url: "data:image/png;charset=utf-8;base64,XYZ=" },
    },
  ]);
  assert.deepEqual(result, [
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "XYZ=" },
    },
  ]);
});

test("toContentBlocks: image_url without url is dropped", () => {
  const result = toContentBlocks([
    // @ts-expect-error — runtime data without required url field
    { type: "image_url", image_url: {} },
    { type: "text", text: "hi" },
  ]);
  assert.deepEqual(result, [{ type: "text", text: "hi" }]);
});

import { extractForPathD } from "./translate.ts";

test("extractForPathD: last user text → lastUserContent has text block", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "system", content: "be helpful" },
      { role: "user", content: "hola" },
    ],
  });
  assert.ok(result, "extractForPathD returned null");
  assert.equal(result.systemPrompt, "be helpful");
  assert.deepEqual(result.lastUserContent, [{ type: "text", text: "hola" }]);
  assert.equal(result.pendingToolResult, null);
});

test("extractForPathD: last user with image preserves image block", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,XYZ" },
          },
        ],
      },
    ],
  });
  assert.ok(result);
  assert.equal(result.lastUserContent.length, 2);
  assert.equal(result.lastUserContent[0].type, "text");
  assert.equal(result.lastUserContent[1].type, "image");
});

test("extractForPathD: role=tool → pendingToolResult.content is content blocks", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "user", content: "do thing" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "the result", tool_call_id: "call_1" },
    ],
  });
  assert.ok(result);
  assert.deepEqual(result.lastUserContent, []);
  assert.deepEqual(result.pendingToolResult, {
    toolUseId: "call_1",
    content: [{ type: "text", text: "the result" }],
  });
});

test("extractForPathD: anthropic-style tool_result in user message preserves structure", () => {
  const result = extractForPathD({
    model: "x",
    messages: [
      { role: "user", content: "x" },
      {
        role: "user",
        content: [
          {
            // @ts-expect-error — adapter shape, not in OAIContentPart
            type: "tool_result",
            tool_use_id: "call_2",
            content: [
              { type: "text", text: "row 1" },
              { type: "text", text: "row 2" },
            ],
          },
        ],
      },
    ],
  });
  assert.ok(result);
  assert.deepEqual(result.pendingToolResult, {
    toolUseId: "call_2",
    content: [
      { type: "text", text: "row 1" },
      { type: "text", text: "row 2" },
    ],
  });
});
