import { describe, expect, it } from "vitest";
import { speechChunksFromMarkdown } from "./readAloud";

describe("speechChunksFromMarkdown", () => {
  it("turns response markdown into short, speakable chunks", () => {
    const chunks = speechChunksFromMarkdown([
      "## Result",
      "Here is the [important source](https://example.com). It explains the result clearly.",
      "- Keep `stateVersion` monotonic.",
      "- Ignore stale events.",
    ].join("\n"), 72);

    expect(chunks).toEqual([
      "Result Here is the important source. It explains the result clearly.",
      "Keep stateVersion monotonic. Ignore stale events.",
    ]);
    expect(chunks.every((chunk) => chunk.length <= 72)).toBe(true);
  });

  it("splits a long sentence on word boundaries and ignores empty markdown", () => {
    expect(speechChunksFromMarkdown("   ")).toEqual([]);
    const chunks = speechChunksFromMarkdown("one two three four five six seven", 14);
    expect(chunks).toEqual(["one two three", "four five six", "seven"]);
  });
});
