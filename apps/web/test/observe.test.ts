import { describe, expect, it } from "vitest";
import { average, axisLabel, tokenRows, totalPerBucket, bytes, duration, groupOf, inspectHref, inspectTarget, niceTicks, ratio, stacked, type Bucket, type SeriesData, messageText, percent, promptSplit, roleLabel, shortModel, speed, switched, tokens, usd } from "../src/lib/observe";

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
    expect(shortModel("gemini:interactions:gemini-3.8-flash")).toBe("gemini:gemini-3.8-flash");
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

  it("finds the tab, message, database and table an address names", () => {
    const none = { question: null, db: null, table: null };
    expect(inspectTarget("#/inspect")).toEqual({ tab: "overview", ...none });
    expect(inspectTarget("#/inspect/overview")).toEqual({ tab: "overview", ...none });
    expect(inspectTarget("#/inspect/traces")).toEqual({ tab: "traces", ...none });
    expect(inspectTarget("#/inspect/traces/evt_abc123")).toEqual({ tab: "traces", ...none, question: "evt_abc123" });
    // From before there were tabs: a message's id alone opens its trace.
    expect(inspectTarget("#/inspect/evt_abc123")).toEqual({ tab: "traces", ...none, question: "evt_abc123" });
    expect(inspectTarget("#/inspect/data")).toEqual({ tab: "data", ...none });
    expect(inspectTarget("#/inspect/data/ledger")).toEqual({ tab: "data", ...none, db: "ledger" });
    expect(inspectTarget("#/inspect/data/ledger/events")).toEqual({ tab: "data", ...none, db: "ledger", table: "events" });
    for (const bad of ["#/chat", "#/inspect/a/b/c", "#/inspect/data/a/b/c", "#/inspect/traces/a/b", "#/inspect/overview/x", "#/inspect/data/le dger"]) expect(inspectTarget(bad)).toBeNull();
    expect(inspectHref("overview")).toBe("#/inspect");
    expect(inspectHref("traces", "evt_1")).toBe("#/inspect/traces/evt_1");
    expect(inspectHref("data", "ledger", null)).toBe("#/inspect/data/ledger");
  });
});

describe("the chart series", () => {
  const totals = { calls: 1, failed: 0, stopped: 0, promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: null, costUsd: 0, priced: 0, ms: 0, tokensPerSecond: null, firstTokenMs: null };
  const at = ["2026-10-06T10:00:00.000Z", "2026-10-06T11:00:00.000Z", "2026-10-06T12:00:00.000Z"];
  const bucket = (i: number, role: Bucket["role"], over: Partial<Bucket> = {}): Bucket => ({ ...totals, at: at[i]!, role, ...over });
  const series: SeriesData = { range: "24h", bucketMs: 3_600_000, at, buckets: [bucket(0, "work", { calls: 3, promptTokens: 1000, cacheReadTokens: 800, tokensPerSecond: 100 }), bucket(0, "router", { calls: 1, promptTokens: 200, cacheReadTokens: 100 }), bucket(2, "wrap_up", { calls: 2, promptTokens: 400, cacheReadTokens: 0, tokensPerSecond: 50 }), bucket(2, "repair", { calls: 1, promptTokens: 100, cacheReadTokens: 0, tokensPerSecond: 20 })] };

  it("groups roles into the series charts draw", () => {
    expect(["work", "router", "compaction", "wrap_up", "repair", "embedding", "other"].map((r) => groupOf(r as Bucket["role"]))).toEqual(["Agent", "Router", "Compaction", "Wrap-up and repair", "Wrap-up and repair", null, "Other"]);
  });

  it("stacks a value per bucket and group, with zeros where nothing happened, and only the groups that appear", () => {
    expect(stacked(series, (b) => b.calls)).toEqual({ groups: ["Agent", "Router", "Wrap-up and repair"], rows: [[3, 1, 0], [0, 0, 0], [0, 0, 3]] });
  });

  it("splits prompt tokens into cached and fresh beside the output, and sums over every role", () => {
    expect(tokenRows(series)).toEqual([[900, 300, 0], [0, 0, 0], [0, 500, 0]]);
    expect(totalPerBucket(series, (b) => b.calls)).toEqual([4, 0, 3]);
  });

  it("works out a rate over some roles, null where there was no prompt", () => {
    expect(ratio(series, ["work"], (b) => b.cacheReadTokens, (b) => b.promptTokens)).toEqual([0.8, null, null]);
    expect(ratio(series, ["work", "router"], (b) => b.cacheReadTokens, (b) => b.promptTokens)).toEqual([0.75, null, null]);
  });

  it("averages weighted by calls, from the buckets that have a value", () => {
    expect(average(series, ["wrap_up", "repair"], (b) => b.tokensPerSecond)).toEqual([null, null, (50 * 2 + 20) / 3]);
  });

  it("weights timing averages by measured requests, excluding failed or unmeasured calls", () => {
    const measured = { ...series, buckets: [bucket(0, "work", { calls: 9, tokensPerSecond: 100, speedSamples: 1 }), bucket(0, "repair", { calls: 2, tokensPerSecond: 20, speedSamples: 2 }), bucket(1, "work", { calls: 4, speedSamples: 0 })] };
    expect(average(measured, ["work", "repair"], (b) => b.tokensPerSecond, (b) => b.speedSamples ?? 0)).toEqual([140 / 3, null, null]);
  });

  it("picks round axis ticks from zero", () => {
    expect(niceTicks(87)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(1240)).toEqual([0, 500, 1000, 1500]);
  });

  it("labels an axis by the hour or by the day", () => {
    expect(axisLabel("2026-10-06T10:00:00.000Z", 3_600_000, "en-GB")).toMatch(/^\d{1,2}(:\d\d)?\s?(am|pm)?$/i);
    expect(axisLabel("2026-10-06T10:00:00.000Z", 86_400_000, "en-GB")).toMatch(/Oct/);
    expect(axisLabel("nonsense", 3_600_000)).toBe("");
  });
});
