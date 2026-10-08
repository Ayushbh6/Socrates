import type { ModelClient, ModelRequest } from "@socrates/contracts";
import { describe, expect, it } from "vitest";
import { cleanTitle, copiesStart, nameChat } from "../src/titles";

const trace = { goalId: "g", taskId: "t", turnId: "u", userEventId: "e" };

/** A model that replies with each of the given texts in turn, and keeps what it was asked. */
function replying(...texts: string[]) {
  const requests: ModelRequest[] = [];
  const model = {
    id: "scripted:titler",
    complete: async (request: ModelRequest) => {
      requests.push(request);
      return { text: texts[Math.min(requests.length - 1, texts.length - 1)]!, toolCalls: [], reasoning: null, stopReason: "end", usage: { promptTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
    },
  } as unknown as ModelClient;
  return { model, requests };
}

describe("a chat's name", () => {
  it("is cut to one plain line of at most eight words", () => {
    expect(cleanTitle('Name: "Friday dinner for six."')).toBe("Friday dinner for six");
    expect(cleanTitle("<think>hmm</think>\nTwo background servers")).toBe("Two background servers");
    expect(cleanTitle("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight");
    expect(cleanTitle("  ")).toBeNull();
  });

  it("is refused when it only repeats the opening words of the answer, or four or more of the message", () => {
    const message = "Start two background terminals named a and b, then tell me when both are up";
    expect(copiesStart("Both are up", message, "Both are up.\n\n- a running")).toBe(true);
    expect(copiesStart("Start two background terminals", message, "Done.")).toBe(true);
    // Fewer than four of the message's words, or words from the middle, are a name.
    expect(copiesStart("Start two", message, "Done.")).toBe(false);
    expect(copiesStart("Background terminals a and b", message, "Done.")).toBe(false);
    // One word of the answer is no copy.
    expect(copiesStart("Done", message, "Done. All set.")).toBe(false);
  });

  it("is asked for again, once, when the first reply copies; the second is kept", async () => {
    const { model, requests } = replying("Both are up", "Two background terminals");
    const name = await nameChat(model, { message: "Start two background terminals and tell me when both are up.", answer: "Both are up.", trace });
    expect(name).toBe("Two background terminals");
    expect(requests).toHaveLength(2);
    expect(requests[1]!.messages[0]!.content).toContain('You named it "Both are up"');
  });

  it("is left to the first words when the second reply copies too, or the model says nothing", async () => {
    expect(await nameChat(replying("Both are up", "Both are up now").model, { message: "Start two things", answer: "Both are up now.", trace })).toBeNull();
    expect(await nameChat(replying("").model, { message: "Hello there", answer: "Hi.", trace })).toBeNull();
  });

  it("is asked for without thinking when told, with room for a model that thinks anyway", async () => {
    const { model, requests } = replying("Friday dinner for six");
    await nameChat(model, { message: "what should I cook on friday", answer: "Try a curry.", effort: "off", trace });
    expect(requests[0]).toMatchObject({ effort: "off", maxOutputTokens: 1500 });
    const content = String(requests[0]!.messages[0]!.content);
    expect(content).toContain("<message>\nwhat should I cook on friday\n</message>");
    expect(content).toContain("<answer_start>\nTry a curry.\n</answer_start>");
  });
});
