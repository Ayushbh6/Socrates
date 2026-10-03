import type { EventPayloads, TextPart } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import type { Evidence, HistoryRecord, LedgerStore, Turn } from "@socrates/store";
import { head, headTail } from "@socrates/tools";
import { omissionMarker, renderRecord } from "./summaries";

/** Turn N−1 is fitted to this size (agent-harness.md, "Fitting turn N−1"). */
export const PREVIOUS_TURN_BUDGET_TOKENS = 20_000;
/** Step 2 of the fitting ladder never trims a result below this size. */
export const TRIM_FLOOR_TOKENS = 1_500;

/** Room kept inside a trimmed result's cap for its omission marker. */
const MARKER_TOKENS = 60;

/** Calls that collapse to one line in step 1: reproducible, or already reflected on disk. */
const COLLAPSIBLE = new Set(["edit", "apply_patch", "glob", "grep", "context_retrieve", "capability_search", "capability_control", "terminal_control"]);

/** What chat history holds for one request: an optional summary and the turns after it. */
export interface History {
  /** The active checkpoint or handover capsule. */
  summary: HistoryRecord | null;
  /** Turns a failed compaction omitted, not yet absorbed by a checkpoint. */
  omitted: { from: number; to: number } | null;
  /** Completed turns after the summary, oldest first; the last one is N−1. */
  turns: Turn[];
}

/**
 * The history of the current turn's task (agent-harness.md, "Three-tier
 * history attachment"). It runs across the task's whole chain of chats: the
 * newest checkpoint or capsule, then every ended turn of the task after the
 * turns it covers. A turn that was in flight during a rollover therefore
 * stays in history even though it is recorded under the closed chat.
 */
export function taskHistory(store: LedgerStore, currentTurnId: string): History {
  const current = store.requireTurn(currentTurnId);
  const summary = store.latestHistoryRecord(current.taskId!);
  const omitted = store.pendingOmission(current.taskId!);
  const boundary = Math.max(summary?.to ?? 0, omitted?.to ?? 0);
  const turns = store
    .turnsForTask(current.taskId!)
    .filter((t) => t.id !== currentTurnId && t.projectTurn < current.projectTurn && t.projectTurn > boundary && t.status !== "in_progress");
  return { summary, omitted, turns };
}

/**
 * History as prompt parts, one per block, rendered from the event log alone
 * so the same history always yields the same text. Older turns are Q&A only;
 * the newest is fitted to the N−1 budget. Cache breakpoints fall after the
 * last stable part before N−1, and after N−1.
 */
export function historyParts(store: LedgerStore, history: History, previousTurnBudget = PREVIOUS_TURN_BUDGET_TOKENS): TextPart[] {
  const parts: TextPart[] = [];
  if (history.summary) parts.push({ text: `${renderRecord(history.summary)}\n\n` });
  if (history.omitted) parts.push({ text: `${omissionMarker(history.omitted)}\n\n` });
  const last = history.turns.at(-1);
  for (const t of history.turns.slice(0, -1)) parts.push({ text: `${renderExchangeTurn(store, t)}\n\n` });
  if (parts.length) parts[parts.length - 1]!.cache = true;
  if (last) parts.push({ text: `${renderFullTurn(store, last, previousTurnBudget)}\n\n`, cache: true });
  return parts;
}

/** A turn as its request and final response only (tier 3). */
export function renderExchangeTurn(store: LedgerStore, turn: Turn): string {
  return `[TURN ${turn.projectTurn}]\nUSER:\n${userSection(store, turn)}\n\nSOCRATES:\n${responseSection(store, turn)}`;
}

/** The previous turn with its tool calls and results, reduced step by step until it fits (tier 2). */
export function renderFullTurn(store: LedgerStore, turn: Turn, budget = PREVIOUS_TURN_BUDGET_TOKENS): string {
  const user = userSection(store, turn);
  const response = responseSection(store, turn);
  const calls = store.evidenceForTurn(turn.id).map(toCall);
  const render = () =>
    [`[TURN ${turn.projectTurn} — full]`, "USER:", user, "", ...calls.flatMap((c) => [renderCall(c), ""]), "SOCRATES:", response].join("\n");
  const fixed = countTokens(`[TURN ${turn.projectTurn} — full]\nUSER:\n${user}\n\nSOCRATES:\n${response}`) + calls.length;
  const total = () => fixed + calls.reduce((n, c) => n + c.tokens(), 0);
  if (total() <= budget) return render();

  // Step 1: collapse what is reproducible or stale.
  calls.forEach((c, i) => {
    const stale = c.ev.tool === "read" && c.path !== null && calls.slice(i + 1).some((later) => later.changed.includes(c.path!));
    if (stale) c.state = { kind: "collapsed", reason: "stale" };
    else if (COLLAPSIBLE.has(c.ev.tool) || (c.ev.tool === "terminal" && succeeded(c.ev))) c.state = { kind: "collapsed", reason: null };
  });
  if (total() <= budget) return render();

  // Step 2: one cap for every remaining result larger than it, never below the floor.
  const full = calls.filter((c) => c.state.kind !== "collapsed");
  if (full.length) {
    const withCap = (cap: number) => fixed + calls.reduce((n, c) => n + (c.state.kind === "collapsed" ? c.tokens() : c.headerTokens + Math.min(c.resultTokens, cap)), 0);
    let cap = TRIM_FLOOR_TOKENS;
    let high = Math.max(...full.map((c) => c.resultTokens));
    if (withCap(cap) <= budget) {
      while (cap < high) {
        const mid = Math.ceil((cap + high) / 2);
        if (withCap(mid) <= budget) cap = mid;
        else high = mid - 1;
      }
    }
    for (const c of full) if (c.resultTokens > cap) c.state = { kind: "trimmed", cap };
  }

  // Step 3: collapse the oldest remaining calls until the rendered turn fits.
  let text = render();
  for (const c of calls) {
    if (total() <= budget && countTokens(text) <= budget) break;
    if (c.state.kind === "collapsed") continue;
    c.state = { kind: "collapsed", reason: null };
    text = render();
  }
  return text;
}

interface Call {
  ev: Evidence;
  /** The workspace path a read covered, when it is one. */
  path: string | null;
  /** Paths this call changed. */
  changed: string[];
  header: string;
  headerTokens: number;
  result: string;
  resultTokens: number;
  state: { kind: "full" } | { kind: "trimmed"; cap: number } | { kind: "collapsed"; reason: "stale" | null };
  tokens(): number;
}

function toCall(ev: Evidence): Call {
  const header = `TOOL CALL [${ev.handle}] ${ev.tool} ${compactInput(ev.input)}`;
  const result = ev.result?.content ?? "(no result was recorded)";
  const r = (ev.result?.result ?? null) as Record<string, unknown> | null;
  let collapsedTokens: number | null = null;
  return {
    ev,
    path: ev.tool === "read" && typeof r?.path === "string" ? r.path : null,
    changed: changedPaths(ev),
    header,
    headerTokens: countTokens(header) + 1,
    result,
    resultTokens: countTokens(result),
    state: { kind: "full" },
    tokens() {
      if (this.state.kind === "collapsed") return (collapsedTokens ??= countTokens(collapsedLine(this)) + 1);
      // A trimmed result also carries its omission marker.
      return this.headerTokens + (this.state.kind === "trimmed" ? Math.min(this.resultTokens, this.state.cap) : this.resultTokens);
    },
  };
}

function renderCall(c: Call): string {
  if (c.state.kind === "collapsed") return collapsedLine(c);
  if (c.state.kind === "full") return `${c.header}\n${c.result}`;
  const hint = `trimmed to fit; context_retrieve inspect ${c.ev.handle} returns the complete result`;
  const failedCommand = c.ev.tool === "terminal" || c.ev.status === "error";
  // The cap includes the omission marker.
  const room = c.state.cap - MARKER_TOKENS;
  const shown = c.ev.tool === "read" || !failedCommand ? head(c.result, room, hint) : headTail(c.result, room, hint);
  return `${c.header}\n${shown.text}`;
}

/** One call in the linearization grammar, with its evidence handle. */
export function collapsedLine(c: { ev: Evidence; state: Call["state"] }): string {
  const ev = c.ev;
  const input = (typeof ev.input === "object" && ev.input !== null ? ev.input : {}) as Record<string, unknown>;
  const r = (ev.result?.result ?? null) as Record<string, unknown> | null;
  const prefix = `TOOL CALL [${ev.handle}] ${ev.tool}`;
  if (!ev.result) return `${prefix} → no result was recorded`;
  if (ev.status === "error" && ev.result.error) return `${prefix} ${target(ev.tool, input)}→ error ${ev.result.error.code}: ${oneLine(ev.result.error.message, 160)}`;
  switch (ev.tool) {
    case "edit":
      return `${prefix} ${String(r?.path ?? input.path ?? "")} (${diffStat(r?.diff)})`;
    case "apply_patch": {
      const files = Array.isArray(r?.files) ? (r.files as { path: string; action: string }[]).map((f) => `${f.action} ${f.path}`).join(", ") : "";
      return `${prefix} ${files} (${diffStat(r?.diff)})`;
    }
    case "read": {
      const lines = Array.isArray(r?.lines) ? (r.lines as { number: number }[]) : [];
      const range = lines.length ? `lines ${lines[0]!.number}–${lines.at(-1)!.number} of ${String(r?.total_lines)}` : "empty";
      return `${prefix} ${String(r?.path ?? input.path ?? "")} (${range})${c.state.kind === "collapsed" && c.state.reason === "stale" ? " — changed later in this turn" : ""}`;
    }
    case "glob":
    case "grep":
      return `${prefix} ${JSON.stringify(input.pattern ?? "")} → ${String(r?.returned ?? 0)} match${r?.returned === 1 ? "" : "es"}${r?.truncated ? " (more available)" : ""}`;
    case "terminal": {
      const status = r?.status === "running" ? `running as ${String(r.terminal)}` : `exit ${String(r?.exit_code ?? r?.signal ?? "?")}`;
      const output = typeof r?.output === "string" ? lastLine(r.output) : "";
      return `${prefix}: ${oneLine(String(input.command ?? ""), 200)} → ${status}${output ? ` · last line: ${JSON.stringify(output)}` : ""}`;
    }
    case "terminal_control":
      return `${prefix} ${String(input.action ?? "")} ${String(input.terminal ?? "")} → ${String(r?.status ?? "ok")}`;
    case "context_retrieve":
      return `${prefix} ${String(input.action ?? "")} → ok`;
    case "capability_search":
      return `${prefix} ${JSON.stringify(input.query ?? "")} → ${String(r?.returned ?? 0)} match${r?.returned === 1 ? "" : "es"}`;
    case "capability_control":
      return `${prefix} ${String(input.action ?? "")} ${String(input.name ?? input.ref ?? "")} → ok`;
    default:
      return `${prefix} → ok`;
  }
}

function target(tool: string, input: Record<string, unknown>): string {
  const value = tool === "terminal" ? input.command : (input.path ?? input.pattern ?? input.action);
  return value === undefined ? "" : `${oneLine(String(value), 120)} `;
}

function changedPaths(ev: Evidence): string[] {
  if (ev.status !== "ok") return [];
  const r = (ev.result?.result ?? null) as Record<string, unknown> | null;
  if (ev.tool === "edit" && typeof r?.path === "string") return [r.path];
  if (ev.tool === "apply_patch" && Array.isArray(r?.files)) return (r.files as { path: string; from?: string }[]).flatMap((f) => [f.path, ...(f.from ? [f.from] : [])]);
  return [];
}

function succeeded(ev: Evidence): boolean {
  const r = (ev.result?.result ?? null) as Record<string, unknown> | null;
  return ev.status === "ok" && r?.status === "completed" && r.exit_code === 0;
}

function diffStat(diff: unknown): string {
  if (typeof diff !== "string") return "changed";
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return `+${added} −${removed}`;
}

function compactInput(input: unknown): string {
  const text = typeof input === "string" ? input : JSON.stringify(input ?? {});
  return text.length > 2_000 ? `${text.slice(0, 2_000)}… (input shortened; the full call is stored)` : text;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function lastLine(text: string): string {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return oneLine(lines.at(-1) ?? "", 160);
}

/** The user's request as this turn received it, with a routing clarification when there was one. */
export function userSection(store: LedgerStore, turn: Turn): string {
  const { request, clarification } = store.requestForTurn(turn.id);
  return clarification ? `${request}\n${clarificationLine(clarification)}` : request;
}

export function clarificationLine(c: { question: string; answer: string }): string {
  return `(Before this request was routed, Socrates asked: ${JSON.stringify(c.question)} The user answered: ${JSON.stringify(c.answer)})`;
}

function responseSection(store: LedgerStore, turn: Turn): string {
  if (turn.responseEventId) return (store.getEvent(turn.responseEventId)!.payload as EventPayloads["assistant_response"]).text;
  const interruption = store.interruption(turn.id);
  if (!interruption) return "(No answer was given.)";
  const calls = `${interruption.tool_calls} tool call${interruption.tool_calls === 1 ? "" : "s"}`;
  return interruption.reason === "cancelled" ? `(The user stopped this turn after ${calls}; no answer was given.)` : `(This turn failed after ${calls}; no answer was given.)`;
}
