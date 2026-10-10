import type { EventRefs, MemoryProposal } from "@socrates/contracts";
import { type Goal, type LedgerStore, type Memory, StoreError } from "@socrates/store";

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
