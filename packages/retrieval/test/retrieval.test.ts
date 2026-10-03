import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HashEmbedder } from "@socrates/providers";
import type { LedgerStore } from "@socrates/store";
import { afterEach, describe, expect, it } from "vitest";
import { continueTask, createGoal, createTask, exchange, setup } from "../../router/test/helpers";
import { Retrieval, callLine, chunkText, fuse, rankScore, recencyBoost, wherePredicate } from "../src";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function dir(): string {
  const d = realpathSync(mkdtempSync(path.join(tmpdir(), "socrates-lance-")));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Paraphrases share a concept, so the test embedder treats them as similar without shared words. */
const CONCEPTS = [["lesson", "german", "dative", "grammar", "vocabulary"], ["checkout", "cart", "basket", "purchase", "buying"], ["database", "postgresql", "storage", "timescaledb"]];

async function open(store: LedgerStore, options: Partial<Parameters<typeof Retrieval.open>[0]> = {}) {
  const embedder = (options.embedder as HashEmbedder | undefined) ?? new HashEmbedder({ concepts: CONCEPTS });
  const retrieval = await Retrieval.open({ store, embedder, uri: options.uri ?? dir(), thresholds: { related: 0.1, strong: 0.5 }, ...options });
  cleanups.push(() => retrieval.close());
  await retrieval.idle();
  return { retrieval, embedder };
}

/** Two goals: German with two tasks, and a shop goal; four exchanges. */
async function seed(store: LedgerStore) {
  await exchange(store, "Start my German course.", createGoal("Ongoing German learning", "Day 9 dative"), "Day 9 covers dative prepositions: mit, nach, bei.");
  await exchange(store, "Plan the vocabulary review.", createTask("Vocabulary review"), "We review fifty words every Sunday.");
  await exchange(store, "Checkout breaks with 51 items.", createGoal("Shop checkout", "Fix cart limit"), "The cart limit check used > instead of >=; fixed.");
  await exchange(store, "Which storage should metrics use?", continueTask(), "We chose PostgreSQL with TimescaleDB.");
}

describe("hybrid scoring", () => {
  it("adds rank scores across rankings, then a boost, keeping first appearance on ties", () => {
    expect(rankScore(1)).toBe(1);
    expect(rankScore(2)).toBeCloseTo(11 / 12);
    const fused = fuse([["a", "b", "c"], ["b", "d"]], (x) => x);
    expect(fused.map((f) => f.item)).toEqual(["b", "a", "d", "c"]);
    expect(fused[0]!.score).toBeCloseTo(11 / 12 + 1);
    // Equal relevance in mirrored positions: the boost (recency) decides.
    const tied = fuse([["old", "new"], ["new", "old"]], (x) => x, (x) => (x === "new" ? 0.01 : 0));
    expect(tied.map((t) => t.item)).toEqual(["new", "old"]);
  });

  it("gives newer evidence a small boost that halves every thirty days and never outweighs a clear rank gap", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(recencyBoost(now, now)).toBeCloseTo(0.05);
    expect(recencyBoost("2026-09-01T00:00:00Z", now)).toBeCloseTo(0.025);
    expect(recencyBoost(now, now)).toBeLessThan(rankScore(1) - rankScore(2));
  });
});

describe("documents", () => {
  it("chunks long text into overlapping windows and describes calls by their input", () => {
    const text = Array.from({ length: 2_000 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(text, 4_000, 600);
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.every((c) => c.length <= 4_000)).toBe(true);
    expect(chunks[1]!.startsWith(chunks[0]!.slice(-600).split(" ").slice(1, 2)[0]!) || chunks[0]!.includes(chunks[1]!.split(" ")[0]!)).toBe(true);
    expect(chunkText("short")).toEqual(["short"]);
    expect(callLine("terminal", { command: "npm run migrate -- --env staging" })).toBe("terminal: npm run migrate -- --env staging");
    expect(callLine("apply_patch", { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: b.md\n+x\n*** End Patch" })).toBe("apply_patch src/a.ts, b.md");
    expect(callLine("grep", { pattern: "cart limit", path: "src" })).toBe('grep "cart limit" in src');
  });

  it("builds a prefilter predicate with escaped values", () => {
    expect(wherePredicate({ kinds: ["exchange", "tool_call"], goalIds: ["g'1"], excludeTaskIds: ["t2"], throughTurn: 7, fromIso: "2026-09-01" })).toBe(
      "kind IN ('exchange', 'tool_call') AND goal_id IN ('g''1') AND (task_id IS NULL OR task_id NOT IN ('t2')) AND project_turn <= 7 AND at >= '2026-09-01'",
    );
  });
});

describe("Retrieval", () => {
  it("indexes goals, tasks, exchanges and tool calls, and embeds only what changed", async () => {
    const { store } = setup();
    await seed(store);
    const { retrieval, embedder } = await open(store);
    const status = await retrieval.status();
    // 2 goals + 3 tasks (general excluded only by the router) + 4 exchanges, plus the general goal and task.
    expect(status.documents).toBeGreaterThanOrEqual(9);
    expect(status.watermark).toBe(store.latestEventSeq());

    const calls = embedder.calls;
    expect(await retrieval.sync()).toEqual({ embedded: 0 });
    expect(embedder.calls).toBe(calls);

    await exchange(store, "Practise dative again.", continueTask(), "Mit dem Bus, nach der Schule.");
    const { embedded } = await retrieval.sync();
    // The new exchange plus the touched task and goal metadata.
    expect(embedded).toBeGreaterThanOrEqual(1);
    expect(embedded).toBeLessThanOrEqual(3);
  });

  it("finds meaning without shared words, filtered by kind, goal, task and turn", async () => {
    const { store } = setup();
    await seed(store);
    const { retrieval } = await open(store);
    const goals = await retrieval.search("let's start today's lesson", { kinds: ["goal"], limit: 3 });
    expect(goals.map((h) => store.requireGoal(h.sourceId).title)[0]).toBe("Ongoing German learning");

    const shop = store.listGoals().find((g) => g.title === "Shop checkout")!;
    const turns = await retrieval.search("what went wrong when buying lots of things?", { kinds: ["exchange"], goalIds: [shop.id], limit: 5 });
    expect(turns[0]).toMatchObject({ kind: "exchange", goalId: shop.id, projectTurn: 3 });
    expect(await retrieval.search("what went wrong when buying lots of things?", { kinds: ["exchange"], goalIds: [shop.id], throughTurn: 2, limit: 5 })).toEqual([]);
    // The strong floor drops weaker matches.
    expect((await retrieval.search("dative", { kinds: ["exchange"], limit: 5, min: "strong" })).every((h) => h.similarity >= 0.5)).toBe(true);
  });

  it("falls back to nothing while the embedder is unreachable, then recovers after the back-off", async () => {
    const { store } = setup();
    await seed(store);
    let now = 1_000_000;
    const logs: string[] = [];
    const embedder = new HashEmbedder({ concepts: CONCEPTS });
    const { retrieval } = await open(store, { embedder, now: () => now, log: (m) => logs.push(m) });
    embedder.failing = true;
    expect(await retrieval.search("german lesson", { kinds: ["goal"], limit: 3 })).toEqual([]);
    embedder.failing = false;
    const calls = embedder.calls;
    expect(await retrieval.search("german lesson again", { kinds: ["goal"], limit: 3 })).toEqual([]);
    expect(embedder.calls).toBe(calls);
    now += 30_000;
    expect((await retrieval.search("german lesson again", { kinds: ["goal"], limit: 3 })).length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes("keyword search only"))).toBe(true);
  });

  it("gives up on a slow query embedding instead of delaying the reply", async () => {
    const { store } = setup();
    await seed(store);
    const { retrieval } = await open(store, { embedder: new HashEmbedder({ concepts: CONCEPTS, delayMs: 200 }), queryTimeoutMs: 20 });
    const started = Date.now();
    expect(await retrieval.search("german", { kinds: ["goal"], limit: 3 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("keeps its watermark across restarts and rebuilds separately for a different model", async () => {
    const { store } = setup();
    await seed(store);
    const uri = dir();
    const first = await open(store, { uri });
    await first.retrieval.close();
    const again = await open(store, { uri, embedder: new HashEmbedder({ concepts: CONCEPTS }) });
    expect(again.embedder.calls).toBe(0);
    const other = await open(store, { uri, embedder: new HashEmbedder({ concepts: CONCEPTS, id: "test:other" }) });
    expect(other.embedder.calls).toBeGreaterThan(0);
    expect((await other.retrieval.status()).watermark).toBe(store.latestEventSeq());
  });

  it("indexes installed capabilities and forgets uninstalled ones", async () => {
    const { store } = setup();
    let entries = [{ kind: "skill" as const, name: "release-notes", description: "Write release notes from merged changes." }, { kind: "mcp" as const, name: "shop.cart_get", description: "Read a customer's basket." }];
    const { retrieval } = await open(store, { capabilities: () => entries });
    expect((await retrieval.search("what is in the shopping cart", { kinds: ["capability"], limit: 3 }))[0]).toMatchObject({ kind: "capability", sourceId: "shop.cart_get" });
    entries = entries.slice(0, 1);
    await retrieval.sync();
    expect((await retrieval.search("what is in the shopping cart", { kinds: ["capability"], limit: 3 })).map((h) => h.sourceId)).not.toContain("shop.cart_get");
  });

  it("folds overlapping sync requests into one more pass and stops cleanly on close", async () => {
    const { store } = setup();
    await seed(store);
    const embedder = new HashEmbedder({ concepts: CONCEPTS, delayMs: 20 });
    const retrieval = await Retrieval.open({ store, embedder, uri: dir() });
    retrieval.scheduleSync();
    retrieval.scheduleSync();
    retrieval.scheduleSync();
    await retrieval.close();
    await retrieval.idle();
    expect(await retrieval.search("german", { kinds: ["goal"], limit: 3 })).toEqual([]);
  });
});
