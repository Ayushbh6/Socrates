import { type LaneSummary, laneSelector, laneTime } from "@socrates/router";
import { countTokens } from "@socrates/shared";
import { type LedgerStore, excerpt } from "@socrates/store";

/** `<LANES>` in total. */
export const LANES_MAX_TOKENS = 1_500;
const ANSWER_CHARS = 300;

/** A lane summary with what only the running Socrates knows. */
export interface LaneView extends LaneSummary {
  /** A run in this lane is waiting for the user's approval. */
  waitingForApproval: boolean;
}

/**
 * `<LANES>` (agent-harness.md, "Lanes"): what each lane beside the main
 * conversation is doing, so the main conversation can answer questions about
 * it. Oldest lane first; null when no lane is worth showing.
 */
export function lanesBlock(store: LedgerStore, lanes: LaneView[], now: Date, timeZone: string): string | null {
  if (!lanes.length) return null;
  const blocks: string[] = [];
  let used = countTokens("<LANES>\n</LANES>");
  for (const s of lanes) {
    const status = s.waitingForApproval
      ? "waiting for the user's approval"
      : s.status === "working" ? `working since ${laneTime(s.at, now, timeZone)}`
      : s.status === "waiting_for_answer" ? "waiting for the user's answer to its question"
      : s.status === "starting" ? "starting"
      : `${s.status} at ${laneTime(s.at, now, timeZone)}`;
    const lines = [`lane ${s.lane.number} · ${status}${s.goal && s.task ? ` · ${laneSelector(store, s)} "${s.task.title}" in goal "${s.goal.title}" · workspace ${s.workspace ?? "none"}` : ""}`];
    if (s.latestStep) lines.push(`  latest step: ${s.latestStep}`);
    // While a lane works, its task's note still describes the turn before this one.
    if (s.task?.continuationNote) lines.push(`  ${s.status === "working" ? "note from before this run" : "note"}: ${s.task.continuationNote}`);
    if (s.text) lines.push(`  ${s.status === "waiting_for_answer" ? "question" : "answer"}: ${excerpt(s.text.replace(/\s+/g, " "), ANSWER_CHARS)}`);
    const text = lines.join("\n");
    const cost = countTokens(text) + 1;
    if (used + cost > LANES_MAX_TOKENS) break;
    blocks.push(text);
    used += cost;
  }
  return blocks.length ? `<LANES>\n${blocks.join("\n")}\n</LANES>` : null;
}

/** The one line the main conversation shows when a lane's message finishes, stops, or asks something. */
export function laneNotice(laneNumber: number, outcome: { kind: "clarify"; question: string } | { kind: "done"; status: "completed" | "interrupted"; title: string; answer: string }): string {
  if (outcome.kind === "clarify") return `Lane ${laneNumber} needs an answer: ${firstSentence(outcome.question)}`;
  return `Lane ${laneNumber} ${outcome.status === "completed" ? "finished" : "stopped"}: ${outcome.title} — ${firstSentence(outcome.answer)}`;
}

function firstSentence(text: string): string {
  const flat = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return excerpt(end > 0 ? flat.slice(0, end + 1) : flat, 140);
}
