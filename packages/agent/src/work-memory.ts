import { lstatSync, readFileSync } from "node:fs";
import { callLine } from "@socrates/retrieval";
import { countTokens } from "@socrates/shared";
import type { Evidence, LedgerStore } from "@socrates/store";
import { type AccessPolicy, WORK_MEMORY_INDEX, type WorkspaceRoot, canReadAutomatically } from "@socrates/tools";
import type { MemorySettings } from "./memory";

/**
 * Work memory (agent-harness.md, "Work memory"): how things are done in one
 * project, kept in the project. `.socrates/MEMORY.md` is an index, one line
 * per topic with the turns it came from; the detail of each topic is a short
 * file under `.socrates/memory/`. The index is shown to the agent in every
 * request of the project (`<WORK_MEMORY>`); topic files are opened with
 * `read`, and the turns with `context_retrieve`. After verified work the
 * decider may say it is worth recording, and the agent then gets the writing
 * guide below for one short extra step.
 */

/** The index shown to the agent is held to this many tokens; past it, the oldest lines are left out and the agent is told to tidy. */
export const WORK_MEMORY_INDEX_MAX_TOKENS = 1_500;
const INDEX_MAX_BYTES = 64 * 1024;

/** A turn is only asked about when it made at least this many tool calls, one of them a change or a command. */
export const WORK_MIN_TOOL_CALLS = 3;
/** At or above this chance that a finished turn established something worth writing down, the agent is asked to record it. */
export const WORK_AT = 0.5;
/** The extra step may take this many model requests. */
export const WORK_FOLLOW_UP_MAX_STEPS = 8;

/** The index as it is on disk, or null when the project has none, it is empty, or memory is not used. */
export function readWorkMemoryIndex(workspace: WorkspaceRoot | null, access: AccessPolicy | null): string | null {
  if (!workspace) return null;
  try {
    const abs = workspace.resolve(WORK_MEMORY_INDEX).abs;
    if (!canReadAutomatically(access, abs)) return null;
    const stat = lstatSync(abs);
    if (!stat.isFile() || stat.size > INDEX_MAX_BYTES) return null;
    return readFileSync(abs, "utf8").trim() || null;
  } catch { return null; }
}

/**
 * `<WORK_MEMORY>`: the project's index, in the stable first part of the
 * request, so it changes only when the index does. Held to
 * WORK_MEMORY_INDEX_MAX_TOKENS: past it the oldest lines (the index lists the
 * newest first) are left out and a last line says so, so the agent tidies it.
 */
export function workMemoryBlock(workspace: WorkspaceRoot | null, access: AccessPolicy | null, settings: MemorySettings | null | undefined): string | null {
  if (settings && !settings.use) return null;
  const index = readWorkMemoryIndex(workspace, access);
  if (!index) return null;
  const lines = index.split("\n");
  const shown: string[] = [];
  let used = countTokens("<WORK_MEMORY>\n\n</WORK_MEMORY>") + 40;
  for (const line of lines) {
    used += countTokens(line) + 1;
    if (used > WORK_MEMORY_INDEX_MAX_TOKENS) break;
    shown.push(line);
  }
  const left = lines.length - shown.length;
  if (left > 0) shown.push(`(${left} older line${left === 1 ? "" : "s"} not shown: the index is over its budget of ${WORK_MEMORY_INDEX_MAX_TOKENS} tokens; merge related lines or drop the stalest when you next update it)`);
  return `<WORK_MEMORY>\n${shown.join("\n")}\n</WORK_MEMORY>`;
}

const MUTATING_TOOLS = new Set(["edit", "apply_patch", "terminal"]);

/** Whether a finished turn did enough real work to be asked about: several calls, one of them a change or a command. */
export function didRealWork(calls: Evidence[]): boolean {
  return calls.length >= WORK_MIN_TOOL_CALLS && calls.some((c) => MUTATING_TOOLS.has(c.tool));
}

const REQUEST_CHARS = 800;
const ANSWER_CHARS = 800;
const CALL_LINES_MAX = 24;
const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/**
 * What the decider reads about a finished turn: the request, the tool calls
 * in order (a failed one marked), and the answer, each cut short. Long runs of
 * calls keep their first and last lines.
 */
export function workState(input: { request: string; calls: Evidence[]; answer: string }): string {
  const lines = input.calls.map((c) => `- ${callLine(c.tool, c.input)}${c.status === "error" ? " ✗" : ""}`);
  const shown = lines.length > CALL_LINES_MAX ? [...lines.slice(0, 10), `- … ${lines.length - CALL_LINES_MAX} more calls`, ...lines.slice(-(CALL_LINES_MAX - 10))] : lines;
  return `The user asked:\n${cut(input.request.trim(), REQUEST_CHARS)}\n\nWhat the assistant did (tool calls, in order):\n${shown.join("\n")}\n\nThe assistant's answer:\n${cut(input.answer.trim(), ANSWER_CHARS)}`;
}

/**
 * The writing guide, attached to one turn only when the decider says the work
 * is worth recording (docs/memory.md, M3b): zero cost on every other turn. It
 * is a bundled guide, not an installed Skill, because it is attached by the
 * harness at the right moment instead of found and activated by the agent.
 */
export function workMemorySkill(turnNumber: number): string {
  return `<WORK_MEMORY_SKILL>
The work you just finished looks reusable in this project. Before this turn ends, record what a later turn should know. This is one short extra step: do not repeat your answer.

1. Decide. Record only what this work verified (its checks passed): a repeatable procedure (the steps of a kind of change that will come up again here) or a lesson (a surprise or mistake, and the fix). Not a one-off edit, not a guess, not what the code or README already says plainly. If nothing qualifies, reply "Nothing to record." and stop.
2. Topic file: .socrates/memory/<topic>.md, one topic per file, a short kebab-case name. If a file already covers the topic, read it and change it, do not add a second copy. Write: a title line; "Steps" (numbered, imperative, naming the files and commands); "Pitfalls" (symptom → fix) when there are any; "Evidence: turns N, M" (this turn is turn ${turnNumber}; add the earlier turns it came from). At most about 300 words.
3. Index: .socrates/MEMORY.md, one line per topic, newest first: "- <what to do, in a few words> → memory/<topic>.md · turns N, M". At most 150 characters a line; keep it under about 40 lines. When it is full, merge related lines or drop the stalest before adding one. No steps in the index.
4. Use edit or apply_patch, only on those files (no approval is asked for them). Run no commands and change nothing else.
5. Finish with one short sentence naming the files you wrote.
</WORK_MEMORY_SKILL>`;
}
