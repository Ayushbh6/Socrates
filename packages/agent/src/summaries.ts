import {
  HistoryCheckpoint,
  MAX_OUTSTANDING_REQUESTS,
  OUTSTANDING_QUOTE_MAX_TOKENS,
  OUTSTANDING_TOTAL_MAX_TOKENS,
  TaskHandover,
} from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import type { HistoryRecord, LedgerStore, Turn } from "@socrates/store";
import { parseJsonObject } from "./final";
import { collapsedLine, renderExchangeTurn, userSection } from "./history";

/** Tool activity lines per turn in the compactor's input. */
const SPAN_ACTIVITY_LINES = 30;

/** A covered project-turn range for display: "1–8", or "none". */
export function rangeText(from: number, to: number): string {
  return from > 0 ? (from === to ? `${from}` : `${from}–${to}`) : "none";
}

/** A checkpoint or capsule as it appears in the working prompt and in `inspect hc-N`. */
export function renderRecord(record: HistoryRecord): string {
  const range = rangeText(record.from, record.to);
  const lines: string[] = [];
  const list = (name: string, items: string[]) => {
    if (items.length) lines.push(`${name}:`, ...items.map((i) => `- ${i}`));
  };
  const outstanding = (c: { outstanding_requests: { turn: number; quote: string }[]; more_outstanding_turns?: number[] }) => {
    list("outstanding_requests", c.outstanding_requests.map((r) => `turn ${r.turn}: ${JSON.stringify(r.quote)}`));
    if (c.more_outstanding_turns?.length) {
      lines.push(`more_outstanding_requests: turns ${c.more_outstanding_turns.join(", ")} hold further unanswered requests; read them with context_retrieve inspect turn_number`);
    }
  };
  if (record.mechanical) lines.push("note: written mechanically because the summarizer was unavailable; inspect the turns for detail");
  if (record.kind === "checkpoint") {
    const c = record.content as HistoryCheckpoint;
    lines.push(`summary: ${c.summary}`);
    if (c.progress) lines.push(`progress: ${c.progress}`);
    list("decisions", c.decisions.map((d) => (d.rationale ? `${d.decision} (because ${d.rationale})` : d.decision)));
    list("constraints", c.constraints);
    if (c.files_touched.length) lines.push(`files_touched: ${c.files_touched.join(", ")}`);
    list("open_threads", c.open_threads);
    outstanding(c);
    list("next_steps", c.next_steps);
    list("key_evidence", c.key_evidence.map((e) => `${e.ref}: ${e.note}`));
    return `<HISTORY_CHECKPOINT ref="${record.handle}" turns="${range}">\n${lines.join("\n")}\n</HISTORY_CHECKPOINT>`;
  }
  const h = record.content as TaskHandover;
  lines.unshift("This task continues from an earlier chat. Socrates wrote this capsule when it refreshed the context; the user did not write it.");
  lines.push(`task_objective: ${h.task_objective}`);
  if (h.completion_criteria) lines.push(`completion_criteria: ${h.completion_criteria}`);
  if (h.verified_progress) lines.push(`verified_progress: ${h.verified_progress}`);
  outstanding(h);
  list("decisions", h.decisions);
  list("constraints", h.constraints);
  list("files_and_tests", h.files_and_tests);
  list("blockers", h.blockers);
  lines.push(`next_action: ${h.next_action}`);
  if (h.omitted_details) lines.push(`omitted_details: ${h.omitted_details}`);
  list("key_evidence", h.key_evidence.map((e) => `${e.ref}: ${e.note}`));
  return `<HANDOVER_CAPSULE ref="${record.handle}" turns="${range}">\n${lines.join("\n")}\n</HANDOVER_CAPSULE>`;
}

/** The marker for turns a failed compaction left out of the prompt. */
export function omissionMarker(range: { from: number; to: number }): string {
  return `[TURNS ${rangeText(range.from, range.to)} OMITTED — the summarizer was unavailable; use context_retrieve inspect turn_number to recover them]`;
}

/**
 * The compactor's input (agent-harness.md, "Compactor input contract"): every
 * turn of the span labelled with its permanent project-turn number, its
 * request, its tool activity as one-line entries with evidence handles, and
 * its answer, followed by the prior checkpoint when one exists.
 */
export function renderSpan(store: LedgerStore, turns: Turn[], prior: HistoryRecord | null, range: { from: number; to: number }): string {
  const blocks = turns.map((t) => {
    const evidence = store.evidenceForTurn(t.id);
    const activity = evidence.slice(0, SPAN_ACTIVITY_LINES).map((e) => `- ${collapsedLine({ ev: e, state: { kind: "collapsed", reason: null } })}`);
    if (evidence.length > SPAN_ACTIVITY_LINES) activity.push(`- … ${evidence.length - SPAN_ACTIVITY_LINES} more tool calls`);
    const exchange = renderExchangeTurn(store, t);
    return activity.length ? exchange.replace("\n\nSOCRATES:\n", `\n\nTOOL ACTIVITY:\n${activity.join("\n")}\n\nSOCRATES:\n`) : exchange;
  });
  const priorBlock = prior ? [`[PRIOR ${prior.kind === "checkpoint" ? "CHECKPOINT" : "HANDOVER CAPSULE"} ref="${prior.handle}" turns="${rangeText(prior.from, prior.to)}"]`, renderRecord(prior)] : [];
  return [`<COMPACTED_SPAN turns ${rangeText(range.from, range.to)}>`, ...blocks, ...priorBlock, "</COMPACTED_SPAN>"].join("\n\n");
}

export type SummaryValidation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

/**
 * Validate a compactor reply: the schema, the exact covered range, verbatim
 * outstanding quotes cited to turns of this task, resolvable evidence refs,
 * and the size bounds. The harness, not the model, guarantees these.
 */
export function validateSummary<K extends "checkpoint" | "handover">(
  kind: K,
  text: string,
  ctx: { store: LedgerStore; taskId: string; range: { from: number; to: number }; latestTurn: number; carried?: Pick<HistoryCheckpoint, "outstanding_requests" | "more_outstanding_turns">; maxTokens: number; render: (content: K extends "checkpoint" ? HistoryCheckpoint : TaskHandover) => string },
): SummaryValidation<K extends "checkpoint" ? HistoryCheckpoint : TaskHandover> {
  let raw: unknown;
  try {
    raw = parseJsonObject(text);
  } catch {
    return { ok: false, errors: ["Reply with exactly one JSON object; it could not be parsed."] };
  }
  const parsed = (kind === "checkpoint" ? HistoryCheckpoint : TaskHandover).safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(object)"}: ${i.message}`) };
  const value = parsed.data as K extends "checkpoint" ? HistoryCheckpoint : TaskHandover;
  const { store, taskId, range } = ctx;
  const errors: string[] = [];

  if (kind === "checkpoint") {
    const covered = (value as HistoryCheckpoint).turns_covered;
    if (covered.from !== range.from || covered.to !== range.to) errors.push(`turns_covered must be exactly {"from": ${range.from}, "to": ${range.to}}, the span you were given.`);
  }
  // Outstanding requests may come from the covered turns, or, in a capsule, from any turn of the task up to the current one.
  const lowest = range.from > 0 ? range.from : 1;
  const highest = kind === "checkpoint" ? range.to : ctx.latestTurn;
  const turnText = (n: number, carried = false): string | null => {
    const turn = store.getTurnByNumber(n);
    if (!turn || turn.taskId !== taskId || n > ctx.latestTurn || (!carried && (n < lowest || n > highest))) return null;
    return userSection(store, turn);
  };
  const requests = value.outstanding_requests;
  if (requests.length > MAX_OUTSTANDING_REQUESTS) errors.push(`outstanding_requests has ${requests.length} entries; keep the ${MAX_OUTSTANDING_REQUESTS} earliest and list the turns of the rest in more_outstanding_turns.`);
  let total = 0;
  for (const r of requests) {
    const carried = ctx.carried?.outstanding_requests.some(old => old.turn === r.turn && fold(old.quote) === fold(r.quote)) ?? false;
    const source = turnText(r.turn, carried);
    const tokens = countTokens(r.quote);
    total += tokens;
    if (source === null) errors.push(`outstanding_requests turn ${r.turn} is not a turn of this task between ${lowest} and ${highest}.`);
    else if (!fold(source).includes(fold(r.quote))) errors.push(`outstanding_requests turn ${r.turn}: the quote is not verbatim; copy the exact words of the request from turn ${r.turn}.`);
    if (tokens > OUTSTANDING_QUOTE_MAX_TOKENS) errors.push(`outstanding_requests turn ${r.turn}: the quote is ${tokens} tokens; quote only the unanswered sub-request, at most ${OUTSTANDING_QUOTE_MAX_TOKENS}.`);
  }
  if (total > OUTSTANDING_TOTAL_MAX_TOKENS) errors.push(`outstanding_requests total ${total} tokens; at most ${OUTSTANDING_TOTAL_MAX_TOKENS}.`);
  for (const n of value.more_outstanding_turns ?? []) {
    if (turnText(n, ctx.carried?.more_outstanding_turns?.includes(n) || ctx.carried?.outstanding_requests.some(r => r.turn === n)) === null) errors.push(`more_outstanding_turns ${n} is not a turn of this task between ${lowest} and ${highest}.`);
  }
  // Newer carried obligations are not described by the compacted span. They
  // cannot be declared resolved just because this checkpoint covers less.
  if (kind === "checkpoint" && ctx.carried) {
    for (const old of ctx.carried.outstanding_requests) {
      if (old.turn > range.to && !requests.some(r => r.turn === old.turn && fold(r.quote) === fold(old.quote)) && !value.more_outstanding_turns?.includes(old.turn)) {
        errors.push(`Retain the carried outstanding request from turn ${old.turn}; it is outside this span and has not been resolved here.`);
      }
    }
    for (const n of ctx.carried.more_outstanding_turns ?? []) {
      if (n > range.to && !value.more_outstanding_turns?.includes(n)) errors.push(`Retain carried more_outstanding_turns ${n}; it is outside this span.`);
    }
  }
  for (const e of value.key_evidence) {
    if (!resolves(store, taskId, e.ref)) errors.push(`key_evidence ref ${e.ref} does not exist; use only evidence handles shown in the input, such as e12.`);
  }
  const size = countTokens(ctx.render(value));
  if (size > ctx.maxTokens) errors.push(`The result renders to ${size} tokens; shorten it to at most ${ctx.maxTokens}.`);
  return errors.length ? { ok: false, errors: errors.slice(0, 12) } : { ok: true, value };
}

function resolves(store: LedgerStore, taskId: string, ref: string): boolean {
  const local = /^e(\d+)$/.exec(ref);
  if (local) return store.getEvidence(taskId, Number(local[1])) !== null;
  const qualified = /^g(\d+)\/t(\d+)\/e(\d+)$/.exec(ref);
  if (!qualified) return false;
  const goal = store.getGoalByNumber(Number(qualified[1]));
  const task = goal ? store.getTaskByNumber(goal.id, Number(qualified[2])) : null;
  return task !== null && store.getEvidence(task.id, Number(qualified[3])) !== null;
}

/** Comparison form for verbatim checks: only whitespace and quote style may differ. */
function fold(text: string): string {
  return text.normalize("NFC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
}
