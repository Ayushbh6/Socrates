import { HashEmbedder } from "@socrates/providers";
import { Retrieval, type SemanticHit, type SemanticIndex, type SemanticQuery } from "@socrates/retrieval";
import { countTokens } from "@socrates/shared";
import type { LedgerStore, Turn } from "@socrates/store";
import { describe, expect, it } from "vitest";
import { retrievedHistory } from "../src";
import { continueTask } from "../../router/test/helpers";
import { contextText, final, tempDir, world } from "./helpers";

function end(store: LedgerStore, taskId: string, text: string, answer: string): Turn {
  const t = store.bindTurn({ userEventId: store.recordUserMessage(text).id, taskId, route: "continue" });
  store.completeTurn(t.id, { responseEventId: store.recordResponse(answer, { turn_id: t.id }).id, continuationNote: "Continue" });
  return store.requireTurn(t.id);
}

const hitFor = (turn: Turn, similarity: number): SemanticHit => ({ kind: "exchange", sourceId: turn.id, goalId: turn.goalId, taskId: turn.taskId, turnId: turn.id, projectTurn: turn.projectTurn, at: turn.completedAt!, similarity });

/** A semantic index answering from fixed hits, honouring the query's task filters; it records queries, syncs, and closes. */
function fake(hits: () => SemanticHit[]): SemanticIndex & { queries: SemanticQuery[]; syncs: number; closed: number } {
  const index = {
    queries: [] as SemanticQuery[],
    syncs: 0,
    closed: 0,
    async search(_query: string, filter: SemanticQuery) {
      index.queries.push(filter);
      return hits().filter((h) => filter.kinds.includes(h.kind) && (!filter.taskIds || filter.taskIds.includes(h.taskId!)) && !filter.excludeTaskIds?.includes(h.taskId!) && (filter.throughTurn === undefined || h.projectTurn! <= filter.throughTurn)).slice(0, filter.limit);
    },
    scheduleSync() { index.syncs++; },
    async close() { index.closed++; },
  };
  return index;
}

describe("<RETRIEVED_HISTORY> with meaning search", () => {
  it("adds a strongly related exchange from another task of the goal, labelled with that task", async () => {
    const w = await world();
    const sibling = w.store.createTask(w.goalId, { title: "Fix cart limit", objective: "Checkout works for large carts." });
    const fact = end(w.store, sibling.id, "Why does checkout fail with 51 items?", "The cart limit check used > instead of >=. Code word lantern-7.");
    // Back on the first task, so the next message continues it.
    end(w.store, w.taskId, "Back to the server work.", "Sure.");
    let hits: SemanticHit[] = [hitFor(fact, 0.6)];
    const semantic = fake(() => hits);
    const { socrates, model } = w.socrates([continueTask()], [final()], { semantic });
    await socrates.handle("What was the problem with buying lots of items?");
    const text = contextText(model.requests[0]!);
    expect(text).toContain(`<RETRIEVED_HISTORY>\n[TURN ${fact.projectTurn} — 2026-09-01] (retrieved from task g1/t2 "Fix cart limit")\nUSER:\nWhy does checkout fail with 51 items?`);
    expect(text).toContain("lantern-7");
    // One search per use: routing, this task at the related floor, sibling tasks at the strong floor, capabilities,
    // other workspace files at the strong floor (the goal has no anchors, so none are searched), and memories at the related floor.
    expect(semantic.queries).toEqual([
      { kinds: ["goal", "task"], limit: 30 },
      { kinds: ["exchange", "tool_call"], taskIds: [w.taskId], throughTurn: 0, limit: 20 },
      { kinds: ["exchange", "tool_call"], goalIds: [w.goalId], excludeTaskIds: [w.taskId], excludeTurnIds: [w.store.turnsForTask(w.taskId).at(-1)!.id], limit: 3, min: "strong" },
      { kinds: ["capability"], limit: 5, min: "suggest" },
      { kinds: ["file_section"], workspaceIds: [w.store.requireGoal(w.goalId).workspaceId], excludePaths: [], limit: 2, min: "strong" },
      { kinds: ["memory"], goalIdsOrNone: [w.goalId], limit: 20, min: "related" },
    ]);
    // The index is refreshed after the message, in the background, and closed with Socrates.
    expect(semantic.syncs).toBe(1);
    await socrates.close();
    expect(semantic.closed).toBe(1);

    // Below the strong floor the search returns nothing for sibling tasks, and no other task's history appears.
    hits = [];
    const next = w.socrates([continueTask()], [final()], { semantic: fake(() => hits) });
    await next.socrates.handle("What was the problem with buying lots of items?");
    expect(contextText(next.model.requests[0]!)).not.toContain("<RETRIEVED_HISTORY>");
  });

  it("fuses this task's keyword and meaning matches, shows everything oldest first with dates, and stays in budget", async () => {
    const w = await world();
    w.clock.set("2026-09-02T09:00:00Z");
    const early = end(w.store, w.taskId, "Which port does the server use?", "Port 8080, set in config.ts.");
    w.clock.set("2026-09-05T09:00:00Z");
    const later = end(w.store, w.taskId, "Move the server elsewhere.", "Now on 9090; config.ts updated.");
    const sibling = w.store.createTask(w.goalId, { title: "Deploy", objective: "Ship it." });
    w.clock.set("2026-09-03T09:00:00Z");
    const deploy = end(w.store, sibling.id, "Deploy notes?", "The load balancer expects the server port from config.ts.");
    const text = retrievedHistory(w.store, {
      taskId: w.taskId,
      message: "which port",
      boundary: later.projectTurn,
      maxTokens: 900,
      // "Move the server elsewhere" shares no keyword with the question; meaning finds it.
      semantic: [hitFor(later, 0.4)],
      siblings: [hitFor(deploy, 0.7)],
    })!;
    const labels = [...text.matchAll(/\[TURN (\d+) — ([\d-]+)\]/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(labels).toEqual([`${early.projectTurn} 2026-09-02`, `${later.projectTurn} 2026-09-05`, `${deploy.projectTurn} 2026-09-03`].sort((a, b) => Number(a.split(" ")[0]) - Number(b.split(" ")[0])));
    expect(text).toContain('(retrieved from task g1/t2 "Deploy")');
    expect(countTokens(text)).toBeLessThanOrEqual(900);

    // Turns of the current message (compound parts) are never retrieved.
    const without = retrievedHistory(w.store, { taskId: w.taskId, message: "which port", boundary: later.projectTurn, maxTokens: 900, siblings: [hitFor(deploy, 0.7)], excludeTurnIds: new Set([deploy.id]) })!;
    expect(without).not.toContain("Deploy");
    // A sibling hit is never mistaken for this task's history, and this task's turns after the boundary never appear.
    const bounded = retrievedHistory(w.store, { taskId: w.taskId, message: "which port", boundary: early.projectTurn, maxTokens: 900, semantic: [hitFor(later, 0.9)] })!;
    expect(bounded).not.toContain("9090");
  });

  it("recovers an omitted exchange despite twenty stronger recent matches", async () => {
    const w = await world();
    const old = end(w.store, w.taskId, "Amber", "Older decision: lantern-7.");
    const recent = Array.from({ length: 21 }, (_, i) => end(w.store, w.taskId, `Recent ${i}`, "Unrelated."));
    w.store.recordOmission({ goal_id: w.goalId, task_id: w.taskId, chat_id: old.chatId! }, { from: old.projectTurn, to: old.projectTurn });
    const semantic = fake(() => [...recent.map((t) => hitFor(t, 0.9)), hitFor(old, 0.8)]);
    const { socrates, model } = w.socrates([continueTask()], [final()], { semantic });
    await socrates.handle("violet");
    const text = contextText(model.requests[0]!);
    expect(text).toContain(`<RETRIEVED_HISTORY>\n[TURN ${old.projectTurn}`);
    expect(text).toContain("lantern-7");
    await socrates.close();
  });

  it("indexes each message in the background with a real index and finds it next time by meaning", async () => {
    const w = await world();
    const embedder = new HashEmbedder({ concepts: [["checkout", "basket", "buying", "cart"]] });
    const retrieval = await Retrieval.open({ store: w.store, embedder, uri: tempDir(), thresholds: { related: 0.1, strong: 0.5 } });
    const { socrates } = w.socrates([continueTask()], [final({ full_answer: "The cart limit check used > instead of >=." })], { semantic: retrieval });
    await socrates.handle("Why does checkout fail with 51 items?");
    await retrieval.idle();
    const turn = w.store.turnsForTask(w.taskId).at(-1)!;
    expect((await retrieval.status()).watermark).toBe(w.store.latestEventSeq());
    const found = await retrieval.search("problem buying a big basket", { kinds: ["exchange"], taskIds: [w.taskId], limit: 3 });
    expect(found[0]).toMatchObject({ turnId: turn.id });
    await socrates.close();
    expect(await retrieval.search("problem buying a big basket", { kinds: ["exchange"], limit: 3 })).toEqual([]);
  });
});
