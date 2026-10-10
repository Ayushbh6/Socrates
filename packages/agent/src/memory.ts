import type { EventRefs, MemoryProposal } from "@socrates/contracts";
import { DEFAULT_THRESHOLDS, type SemanticHit, rankMemories } from "@socrates/retrieval";
import { countTokens, zonedParts } from "@socrates/shared";
import { type Goal, type LedgerStore, type Memory, StoreError } from "@socrates/store";
import { type GateReading, RECALL_AT, RECALL_STRONG_AT, SAVE_AT } from "./gates";

/** The user's two memory switches (architecture/server.md, "Settings"). */
export interface MemorySettings {
  /** Save new memories from what the user says. */
  save: boolean;
  /** Show memories to the agent. */
  use: boolean;
}

export const MEMORY_ON: MemorySettings = { save: true, use: true };

/**
 * `<MEMORY>` (agent-harness.md, "Memory"): the always-on entries for work in
 * this goal, grouped as who the user is, how they like to work, and what
 * holds only in this goal, each with its handle. It sits in the stable first
 * part of the request and changes only when memory does. When saving is off,
 * it says so, so the agent does not promise to remember. Null when there is
 * nothing to say.
 */
export function memoryBlock(store: LedgerStore, goal: Goal, settings: MemorySettings): string | null {
  const entries = settings.use ? store.profileMemories(goal.id) : [];
  const line = (m: Memory) => `- ${m.text} [${m.handle}]`;
  const group = (title: string, list: Memory[]) => (list.length ? [title, ...list.map(line)] : []);
  const lines = [
    ...group("About the user:", entries.filter((m) => !m.goalId && m.kind === "about")),
    ...group("How they like to work:", entries.filter((m) => !m.goalId && m.kind === "preference")),
    ...group("In this goal only:", entries.filter((m) => m.goalId)),
    ...(settings.save ? [] : ["Saving new memories is turned off by the user: leave memory.save out, and if asked to remember something, say it is off."]),
  ];
  return lines.length ? `<MEMORY>\n${lines.join("\n")}\n</MEMORY>` : null;
}

/** At most this many entries are offered in `<MEMORY_CANDIDATES>` (more when the gate expects a recall), within this many tokens. */
export const MEMORY_CANDIDATES_MAX = 4;
export const MEMORY_CANDIDATES_RECALL_MAX = 6;
export const MEMORY_CANDIDATES_MAX_TOKENS = 250;

/**
 * `<MEMORY_CANDIDATES>` (agent-harness.md, "Memory"): entries not in
 * `<MEMORY>` (knowledge, and who the user is or how they work beyond its
 * budget) whose words or meaning match the message, for everywhere and this
 * goal, best first, each with its handle, kind and date. Offered strictly:
 * one shared common word is not enough. Null when nothing qualifies or
 * memories are not used.
 *
 * When the gate thinks the message depends on something remembered
 * (`reading.recall`), the meaning floor drops to "related" and six entries
 * may be offered; when it is nearly sure and nothing matched, the block says
 * so and points at the search tools, so the agent looks before it guesses or
 * asks the user.
 */
export function memoryCandidates(store: LedgerStore, input: { goal: Goal; message: string; semantic: SemanticHit[]; settings: MemorySettings; now: Date; timeZone: string; meaningFloor?: number; reading?: GateReading | null }): { block: string | null; ids: string[] } {
  if (!input.settings.use) return { block: null, ids: [] };
  const recall = input.reading?.recall ?? 0;
  const widened = recall >= RECALL_AT;
  const shown = new Set(store.profileMemories(input.goal.id).map((m) => m.id));
  const ranked = rankMemories(store, { query: input.message, goalId: input.goal.id, semantic: input.semantic, exclude: shown, strict: true, meaningFloor: input.meaningFloor ?? (widened ? DEFAULT_THRESHOLDS.related : DEFAULT_THRESHOLDS.suggest), limit: widened ? MEMORY_CANDIDATES_RECALL_MAX : MEMORY_CANDIDATES_MAX, now: input.now });
  const lines: string[] = [];
  const ids: string[] = [];
  let used = countTokens("<MEMORY_CANDIDATES>\n</MEMORY_CANDIDATES>");
  for (const { memory } of ranked) {
    const line = `- [${memory.handle} · ${memory.kind}${memory.goalId ? " · this goal" : ""} · ${zonedParts(new Date(memory.updatedAt), input.timeZone).date}] ${memory.text}`;
    const cost = countTokens(line) + 1;
    if (used + cost > MEMORY_CANDIDATES_MAX_TOKENS) continue;
    lines.push(line);
    ids.push(memory.id);
    used += cost;
  }
  if (lines.length) return { block: `<MEMORY_CANDIDATES>\n${lines.join("\n")}\n</MEMORY_CANDIDATES>`, ids };
  if (recall >= RECALL_STRONG_AT) return { block: `<MEMORY_CANDIDATES>\nNothing remembered matches closely, but this message seems to depend on something about the user or an earlier conversation. Before guessing or asking, look: context_retrieve with action "memory", then "ledger_search" over all goals.\n</MEMORY_CANDIDATES>`, ids: [] };
  return { block: null, ids: [] };
}

/** What the router is shown (Goal-router.md, "REMEMBERED"): at most this many entries, within this many tokens. */
export const MEMORY_ROUTING_MAX = 6;
export const MEMORY_ROUTING_MAX_TOKENS = 250;

/**
 * The saved memories that may bear on a message, for the router, which runs
 * before the goal is known: entries of every goal, matching by words or
 * meaning at the related floor, each with its date and, when it is limited to
 * one goal, that goal's title, so the router can see what the message is
 * about (a trip, a person, a project) instead of asking the user. No handles:
 * the router does not use them. Null when nothing matches.
 */
export function memoryForRouting(store: LedgerStore, input: { message: string; semantic: SemanticHit[]; now: Date; timeZone: string }): string | null {
  const ranked = rankMemories(store, { query: input.message, goalId: undefined, semantic: input.semantic, strict: true, meaningFloor: DEFAULT_THRESHOLDS.related, limit: MEMORY_ROUTING_MAX, now: input.now });
  const lines: string[] = [];
  let used = 0;
  for (const { memory } of ranked) {
    const goal = memory.goalId ? store.getGoal(memory.goalId) : null;
    const line = `- [${memory.kind} · ${zonedParts(new Date(memory.updatedAt), input.timeZone).date}${goal ? ` · limited to goal "${goal.title}"` : ""}] ${memory.text}`;
    const cost = countTokens(line) + 1;
    if (used + cost > MEMORY_ROUTING_MAX_TOKENS) continue;
    lines.push(line);
    used += cost;
  }
  return lines.length ? lines.join("\n") : null;
}

/**
 * `<MEMORY_HINT>`: when the gate thinks the message states something lasting
 * (`reading.save`), one line reminds the agent that it can save it. The agent
 * still decides; a hint it does not need costs one line. Null when saving is
 * off or the gate did not say so.
 */
export function memoryHint(settings: MemorySettings, reading: GateReading | null | undefined): string | null {
  if (!settings.save || (reading?.save ?? 0) < SAVE_AT) return null;
  return "<MEMORY_HINT>\nA small model reads this message as possibly stating something lasting: a fact about the user, a standing preference, or a correction of how you work. If it does, save it with memory.save in your answer; if not, ignore this.\n</MEMORY_HINT>";
}

/** One change a turn made to memory. */
export interface MemoryChange {
  handle: string;
  text: string;
  change: "saved" | "forgotten";
}

/**
 * Apply the final answer's `memory` (agent-harness.md, "Memory"): models
 * propose, the harness disposes. A save that is refused (secret-like, too
 * long), an unknown handle, or one the agent could not have seen becomes a
 * warning on the turn; the rest still applies. A save with the same words as
 * an existing entry changes nothing. With saving off, saves are dropped;
 * forgetting always works. The general conversation has no goal of its own to
 * keep a memory in, so "goal" there means everywhere.
 */
export function applyMemory(input: { store: LedgerStore; goal: Goal; refs: EventRefs; proposal: MemoryProposal | null | undefined; settings: MemorySettings }): MemoryChange[] {
  const { store, goal, refs, proposal, settings } = input;
  if (!proposal) return [];
  const changes: MemoryChange[] = [];
  const reject = (detail: string) => store.recordWarning(refs, { kind: "memory_rejected", detail });
  for (const save of settings.save ? proposal.save : []) {
    try {
      const { memory, created } = store.saveMemory({ kind: save.kind, goalId: save.scope === "goal" && !goal.general ? goal.id : null, text: save.text, by: "agent" }, refs);
      if (created) changes.push({ handle: memory.handle, text: memory.text, change: "saved" });
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      reject(`memory.save was not kept: ${error.message}`);
    }
  }
  for (const handle of new Set(proposal.forget)) {
    const memory = store.getMemoryByNumber(Number(handle.slice(1)));
    if (!memory || memory.forgottenAt || (memory.goalId && memory.goalId !== goal.id)) {
      reject(`memory.forget ${handle}: there is no such memory here.`);
      continue;
    }
    store.forgetMemory(memory.id, "agent", refs);
    changes.push({ handle: memory.handle, text: memory.text, change: "forgotten" });
  }
  return changes;
}
