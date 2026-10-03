import type { SemanticHit, SemanticQuery, SemanticSearch } from "@socrates/retrieval";
import { describe, expect, it } from "vitest";
import { type CatalogEntry, RunState, StaticCatalog, capabilityCandidates } from "../src";
import { type Harness, harness } from "./helpers";

/** A semantic search that answers from a fixed list, applying the query's kind and scope filters, and records each query. */
function fake(hits: () => SemanticHit[]): SemanticSearch & { queries: { query: string; filter: SemanticQuery }[] } {
  const queries: { query: string; filter: SemanticQuery }[] = [];
  return {
    queries,
    async search(query, filter) {
      queries.push({ query, filter });
      return hits().filter((h) => filter.kinds.includes(h.kind) && (!filter.goalIds || filter.goalIds.includes(h.goalId!)) && (!filter.taskIds || filter.taskIds.includes(h.taskId!))).slice(0, filter.limit);
    },
  };
}

function finish(h: Harness, response: string) {
  const turnId = h.binding.turnId!;
  const reply = h.store.recordResponse(response, { goal_id: h.binding.goalId, task_id: h.binding.taskId, turn_id: turnId });
  h.store.completeTurn(turnId, { responseEventId: reply.id, continuationNote: "noted" });
  h.nextTurn();
  return h.store.requireTurn(turnId);
}

const hit = (h: Harness, turnId: string, kind: "exchange" | "tool_call" = "exchange"): SemanticHit => {
  const t = h.store.requireTurn(turnId);
  return { kind, sourceId: turnId, goalId: t.goalId, taskId: t.taskId, turnId, projectTurn: t.projectTurn, at: t.completedAt ?? "", similarity: 0.6 };
};

describe("meaning-based context_retrieve", () => {
  it("search finds an exchange that shares no words with the query and fuses it with keyword matches", async () => {
    let hits: SemanticHit[] = [];
    const semantic = fake(() => hits);
    const h = harness({ semantic });
    const basket = finish(h, "The cart limit check used > instead of >=; fixed.");
    const keyword = finish(h, "Checkout totals now include tax.");
    hits = [hit(h, basket.id)];
    const result = await h.call("context_retrieve", { action: "search", query: "what broke when buying lots of things checkout" });
    expect(result.json.results.map((r: { project_turn: number }) => r.project_turn)).toEqual([keyword.projectTurn, basket.projectTurn]);
    expect(semantic.queries[0]).toMatchObject({ query: "what broke when buying lots of things checkout", filter: { kinds: ["exchange", "tool_call"], taskIds: [h.binding.taskId] } });
  });

  it("a match on a tool call finds its exchange, and date filters still apply", async () => {
    let hits: SemanticHit[] = [];
    const h = harness({ semantic: fake(() => hits) });
    const migrated = finish(h, "Done.");
    hits = [hit(h, migrated.id, "tool_call")];
    const found = await h.call("context_retrieve", { action: "search", query: "did we migrate staging" });
    expect(found.json.results.map((r: { project_turn: number }) => r.project_turn)).toEqual([migrated.projectTurn]);
    const filtered = await h.call("context_retrieve", { action: "search", query: "did we migrate staging", from: "2026-09-02" });
    expect(filtered.json.results).toEqual([]);
  });

  it("ledger_search finds a goal by meaning within its scope", async () => {
    let hits: SemanticHit[] = [];
    const h = harness({ semantic: fake(() => hits) });
    const german = h.store.createGoal({ title: "Ongoing German learning", objective: "Reach B1." });
    hits = [{ kind: "goal", sourceId: german.id, goalId: german.id, taskId: null, turnId: null, projectTurn: null, at: german.updatedAt, similarity: 0.5 }];
    const local = await h.call("context_retrieve", { action: "ledger_search", query: "today's lesson" });
    expect(local.json.results).toEqual([]);
    const all = await h.call("context_retrieve", { action: "ledger_search", query: "today's lesson", scope: "all_goals" });
    expect(all.json.results.map((r: { selector: string }) => r.selector)).toEqual(["g2"]);
  });

  it("works unchanged without a semantic index", async () => {
    const h = harness();
    finish(h, "The cart limit check used > instead of >=.");
    const result = await h.call("context_retrieve", { action: "search", query: "buying lots of things" });
    expect(result.json.results).toEqual([]);
  });
});

describe("meaning-based capability candidates", () => {
  const skill = (name: string, description: string): CatalogEntry => ({ kind: "skill", name, description, tags: [], aliases: [], provider: "user", availability: "available" });
  const catalog = new StaticCatalog([skill("release-notes", "Write release notes from merged changes."), skill("pdf", "Read and create PDF files.")]);
  const capability = (name: string): SemanticHit => ({ kind: "capability", sourceId: name, goalId: null, taskId: null, turnId: null, projectTurn: null, at: "", similarity: 0.5 });

  it("qualifies a strong meaning match that no keyword reaches, and an exact name still wins", () => {
    const h = harness({ catalog });
    const text = capabilityCandidates({ store: h.store, catalog, goalId: h.binding.goalId, message: "Summarise what shipped this sprint for customers", run: new RunState(), semantic: [capability("release-notes")] });
    expect(text).toBe("<CAPABILITY_CANDIDATES>\n- skill c1: release-notes — Write release notes from merged changes. (similar in meaning)\n</CAPABILITY_CANDIDATES>");
    const named = capabilityCandidates({ store: h.store, catalog, goalId: h.binding.goalId, message: "Use pdf for the summary of what shipped", run: new RunState(), semantic: [capability("release-notes")] });
    expect(named).toContain("skill c1: pdf — Read and create PDF files. (named in the message)");
    // A meaning hit for something not installed is ignored.
    expect(capabilityCandidates({ store: h.store, catalog, goalId: h.binding.goalId, message: "anything", run: new RunState(), semantic: [capability("gone")] })).toBeNull();
  });
});
