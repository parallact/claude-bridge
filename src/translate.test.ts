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
