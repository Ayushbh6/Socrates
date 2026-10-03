import { type LaneSummary, laneSelector, laneTime } from "@socrates/router";
import { countTokens, truncateToTokens } from "@socrates/shared";
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
 * it. Live work takes priority over recent completed work under the token cap.
 */
export function lanesBlock(store: LedgerStore, lanes: LaneView[], now: Date, timeZone: string): string | null {
  if (!lanes.length) return null;
  const blocks: string[] = [];
  const priority = (s: LaneView) => s.status === "working" || s.waitingForApproval ? 0 : s.status === "starting" || s.status === "waiting_for_answer" ? 1 : 2;
  const ordered = [...lanes].sort((a, b) => priority(a) - priority(b) || (priority(a) === 2 ? b.at.localeCompare(a.at) : a.lane.number - b.lane.number));
  const line = (text: string) => text.replace(/\s+/g, " ").trim();
  const clip = (text: string, tokens: number) => {
    const result = truncateToTokens(line(text), tokens);
    return result.text + (result.truncated ? "…" : "");
  };
  for (const s of ordered) {
    const status = s.waitingForApproval
      ? "waiting for the user's approval"
      : s.status === "working" ? `working since ${laneTime(s.at, now, timeZone)}`
      : s.status === "waiting_for_answer" ? "waiting for the user's answer to its question"
      : s.status === "starting" || s.status === "idle" ? s.status
      : `${s.status} at ${laneTime(s.at, now, timeZone)}`;
    const lines = [`lane ${s.lane.number} · ${status}${s.goal && s.task ? ` · ${laneSelector(store, s)} "${excerpt(line(s.task.title), 80)}" in goal "${excerpt(line(s.goal.title), 80)}" · workspace ${excerpt(line(s.workspace ?? "none"), 80)}` : ""}`];
    if (s.latestStep) lines.push(`  latest step: ${clip(s.latestStep, 35)}`);
    // While a lane works, its task's note still describes the turn before this one.
    if (s.task?.continuationNote) lines.push(`  ${s.status === "working" || s.status === "starting" ? "note from before this run" : "note"}: ${clip(s.task.continuationNote, 60)}`);
    if (s.text) lines.push(`  ${s.status === "waiting_for_answer" ? "question" : "answer"}: ${excerpt(s.text.replace(/\s+/g, " "), ANSWER_CHARS)}`);
    // Bound every entry so a long note cannot hide the lane or its neighbours.
    const text = truncateToTokens(lines.join("\n"), 280).text;
    const omitted = ordered.length - blocks.length - 1;
    const candidate = `<LANES>\n${[...blocks, text].join("\n")}${omitted ? `\n${omitted} more lanes omitted; use context_retrieve for exact work.` : ""}\n</LANES>`;
    if (countTokens(candidate) > LANES_MAX_TOKENS) break;
    blocks.push(text);
  }
  const omitted = ordered.length - blocks.length;
  return `<LANES>\n${blocks.join("\n")}${omitted ? `\n${omitted} more lanes omitted; use context_retrieve for exact work.` : ""}\n</LANES>`;
}

/** The one line the main conversation shows when a lane's message finishes, stops, or asks something. */
export function laneNotice(laneNumber: number, outcome: { kind: "clarify"; question: string } | { kind: "done"; status: "completed" | "interrupted"; title: string; answer: string }): string {
  if (outcome.kind === "clarify") return `Lane ${laneNumber} needs an answer: ${firstSentence(outcome.question)}`;
  return `Lane ${laneNumber} ${outcome.status === "completed" ? "finished" : "stopped"}: ${outcome.title.replace(/\s+/g, " ").trim()} — ${firstSentence(outcome.answer)}`;
}

function firstSentence(text: string): string {
  const flat = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
  const end = flat.search(/[.!?](\s|$)/);
  return excerpt(end > 0 ? flat.slice(0, end + 1) : flat, 140);
}
