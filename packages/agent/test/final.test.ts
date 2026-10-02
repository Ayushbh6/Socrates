import { describe, expect, it } from "vitest";
import { fallbackAnswer, validateFinalAnswer } from "../src";

const answer = (full: string) => ({ full_answer: full, continuation_note: "Done.", goal_note: null, task_complete: null, anchors: [] });

describe("final answer validation", () => {
  it("accepts an answer whose Markdown contains code fences", () => {
    const full = "Fixed it.\n\n```js\nexport function add(a, b) {\n  return a + b;\n}\n```\n\nTests:\n```\n✔ add\n```";
    for (const text of [JSON.stringify(answer(full)), `\`\`\`json\n${JSON.stringify(answer(full), null, 2)}\n\`\`\``, `Here it is:\n${JSON.stringify(answer(full))}`]) {
      const result = validateFinalAnswer(text);
      expect(result.ok && result.value.full_answer).toBe(full);
    }
  });

  it("explains missing fields and unknown keys", () => {
    const result = validateFinalAnswer(JSON.stringify({ full_answer: "x", extra: 1 }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.join(" ")).toMatch(/continuation_note/);
  });

  it("falls back to a readable full_answer from a malformed object", () => {
    expect(fallbackAnswer('{"full_answer": "Line one.\\nLine two.", "continuation_note": ')).toBe("Line one.\nLine two.");
    expect(fallbackAnswer("  plain text  ")).toBe("plain text");
    expect(fallbackAnswer("")).toMatch(/could not put together/);
  });
});
