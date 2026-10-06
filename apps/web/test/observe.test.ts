import { describe, expect, it } from "vitest";
import { bytes, duration, inspectTarget, messageText, percent, promptSplit, roleLabel, shortModel, speed, switched, tokens, usd } from "../src/lib/observe";

describe("how the inspect numbers read", () => {
  it("shortens token counts", () => {
    expect([0, 950, 1200, 9990, 12_345, 340_000, 1_234_567].map(tokens)).toEqual(["0", "950", "1.2k", "10.0k", "12k", "340k", "1.23M"]);
  });

  it("shows dollars with the digits a fraction of a cent needs", () => {
    expect([null, 0, 0.000162, 0.0031, 0.0698, 0.5, 12].map(usd)).toEqual(["–", "$0", "$0.00016", "$0.0031", "$0.0698", "$0.50", "$12.00"]);
  });

  it("shows rates, durations, speeds and sizes", () => {
    expect([null, 0, 0.756, 1].map(percent)).toEqual(["–", "0%", "76%", "100%"]);
    expect([null, 420, 12_340, 125_000].map(duration)).toEqual(["–", "420 ms", "12.3 s", "2m 05s"]);
    expect([null, 85.44, 240.7].map(speed)).toEqual(["–", "85.4 tok/s", "241 tok/s"]);
    expect([500, 2048, 5 * 1024 * 1024].map(bytes)).toEqual(["500 B", "2.0 KB", "5.0 MB"]);
  });

  it("splits a prompt into what the cache served, what it was told to keep and what was sent fresh", () => {
    expect(promptSplit({ promptTokens: 1000, cacheReadTokens: 600, cacheWriteTokens: 100 })).toEqual({ cached: 600, written: 100, fresh: 300 });
    // A provider that reports more cached tokens than the prompt holds cannot make the bar overflow.
    expect(promptSplit({ promptTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50 })).toEqual({ cached: 100, written: 0, fresh: 0 });
  });

  it("drops the fingerprint from an embedding model's id", () => {
    expect(shortModel("ollama:embeddinggemma:7866d63830422cd421667c95360eaf1d8819f6f603bd2d479450e06cf01cb023")).toBe("ollama:embeddinggemma");
    expect(shortModel("deepseek:deepseek-v4-pro")).toBe("deepseek:deepseek-v4-pro");
    expect(shortModel("openrouter:z-ai/glm-5.3-flash:free")).toBe("openrouter:z-ai/glm-5.3-flash:free");
  });

  it("names a call by what it was for", () => {
    expect(roleLabel({ role: "router", step: 1 })).toBe("Router");
    expect(roleLabel({ role: "router", step: 2 })).toBe("Router 2");
    expect(roleLabel({ role: "work", step: 3 })).toBe("Agent step 3");
    expect(roleLabel({ role: "wrap_up", step: 5 })).toBe("Wrap-up");
  });

  it("knows which moves are a context switch", () => {
    expect((["first", "continued", "general", "switched_task", "new_task", "switched_goal", "new_goal"] as const).filter(switched)).toEqual(["switched_task", "new_task", "switched_goal", "new_goal"]);
  });

  it("reads a message as the model saw it, tool calls included", () => {
    expect(messageText({ role: "user", content: [{ text: "a" }, { text: "b" }] })).toBe("ab");
    expect(messageText({ role: "assistant", content: "Reading.", toolCalls: [{ id: "1", name: "read", input: { path: "a.md" } }] })).toBe('Reading.\n→ read({"path":"a.md"})');
  });

  it("finds the inspect page and a message in the address", () => {
    expect(inspectTarget("#/inspect")).toEqual({ question: null });
    expect(inspectTarget("#/inspect/evt_abc123")).toEqual({ question: "evt_abc123" });
    expect(inspectTarget("#/chat")).toBeNull();
    expect(inspectTarget("#/inspect/a/b")).toBeNull();
  });
});
