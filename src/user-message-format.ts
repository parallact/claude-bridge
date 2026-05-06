import type { ContentBlock } from "./translate.js";

/**
 * Build the stream-json line for a `user` message with the given content
 * blocks. Pure function — no I/O — so it's directly unit-testable.
 */
export function formatUserMessageLine(content: ContentBlock[]): string {
  return (
    JSON.stringify({
      type: "user",
      message: { role: "user", content },
    }) + "\n"
  );
}
