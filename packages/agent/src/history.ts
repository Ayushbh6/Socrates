import type { TextPart } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import { renderContextExchange, quoteEvidence, type Evidence, type HistoryRecord, type LedgerStore, type Turn } from "@socrates/store";
import { attachmentLines, requestAttachments, requestText } from "./attachments";
import { omissionMarker, renderRecord } from "./summaries";

/** Turn N−1 is fitted to this size (agent-harness.md, "Fitting turn N−1"). */
export const PREVIOUS_TURN_BUDGET_TOKENS = 20_000;
/** Step 2 of the fitting ladder never trims a result below this size. */
export const TRIM_FLOOR_TOKENS = 1_500;

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
  // A turn whose question was asked again in another task is set aside.
  const redone = store.redoneTurnIds();
  const turns = store
    .turnsForTask(current.taskId!)
    .filter((t) => t.id !== currentTurnId && t.projectTurn < current.projectTurn && t.projectTurn > boundary && t.status !== "in_progress" && !redone.has(t.id));
  return { summary, omitted, turns };
}

/**
 * History as prompt parts, one per block, rendered from the event log alone
 * so the same history always yields the same text. Older turns are Q&A only;
 * the newest is fitted to the N−1 budget. Cache breakpoints fall after the
 * last stable part before N−1, and after N−1.
 */
export function historyParts(store: LedgerStore, history: History, previousTurnBudget = PREVIOUS_TURN_BUDGET_TOKENS, timeZone = "UTC"): TextPart[] {
  const parts: TextPart[] = [];
  if (history.summary) parts.push({ text: `${promptHistoryRecord(history.summary)}\n\n` });
  if (history.omitted) parts.push({ text: `${omissionMarker(history.omitted)}\n\n` });
  const last = history.turns.at(-1);
  for (const t of history.turns.slice(0, -1)) parts.push({ text: `${renderExchangeTurn(store, t, timeZone)}\n\n` });
  if (parts.length) parts[parts.length - 1]!.cache = true;
  if (last) parts.push({ text: `${renderFullTurn(store, last, previousTurnBudget, timeZone)}\n\n`, cache: true });
  return parts;
}

/** A turn as its request and final response only (tier 3). */
export function renderExchangeTurn(store: LedgerStore, turn: Turn, timeZone = "UTC"): string {
  return renderContextExchange(store, turn, {timeZone});
}

/** Canonical previous exchange; tool records and coverage fit the same budget as router history. */
export function renderFullTurn(store: LedgerStore, turn: Turn, budget = PREVIOUS_TURN_BUDGET_TOKENS, timeZone = "UTC"): string {
  return renderContextExchange(store, turn, {tools: true, budget, timeZone});
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
    case "capability_control": {
      const outcome = typeof r?.name === "string" ? `${String(r.kind)} ${r.name} ${String(r.status ?? "")}`.trimEnd() : "ok";
      const skill = r?.kind === "skill" && r.status === "activated" ? " (its instructions are in ACTIVE_CAPABILITIES while it stays active)" : "";
      return `${prefix} ${String(input.action ?? "")} ${String(input.name ?? input.ref ?? "")} → ${outcome}${skill}`;
    }
    default:
      return `${prefix} → ok`;
  }
}

function target(tool: string, input: Record<string, unknown>): string {
  const value = tool === "terminal" ? input.command : (input.path ?? input.pattern ?? input.action);
  return value === undefined ? "" : `${oneLine(String(value), 120)} `;
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
  const attachments = requestAttachments(store, turn);
  return [requestText(request, attachments), clarification ? clarificationLine(clarification) : "", attachmentLines(attachments)].filter(Boolean).join("\n");
}

export function clarificationLine(c: { question: string; answer: string }): string {
  return `(Before this request was routed, Socrates asked: ${JSON.stringify(c.question)} The user answered: ${JSON.stringify(c.answer)})`;
}

/** Checkpoints stay distinguishable from exact exchanges and quote their generated content. */
export function promptHistoryRecord(record: HistoryRecord): string {
  return `## ${record.kind === "checkpoint" ? "CHECKPOINT" : "HANDOVER"}\n${record.kind === "handover" ? "handover_ref" : "checkpoint_ref"}: ${record.handle}\nsource_chat_ref: ${record.chatId}\ncovers_turn_refs: ${record.from}–${record.to}\nretrieve_refs: ${record.handle}\nmechanical: ${record.mechanical}\nsource: ${record.mechanical ? "mechanical fallback" : "generated summary; exact evidence takes precedence"}\n${record.kind === "checkpoint" ? "summary" : "content"}:\n${quoteEvidence(renderRecord(record))}`;
}

/** General has one chronological evidence window across daily tasks, never lane history. */
export function generalHistoryParts(store: LedgerStore, current: Turn, timeZone: string, previousBudget = 20_000, totalBudget = 30_000, asOf = store.clock.now()): { parts: TextPart[]; included: number[]; omitted: number; used: number; budget: number; dates: string[] } {
  const redone = store.redoneTurnIds();
  const units: {at: number; text?: string; turn?: Turn; taskId?: string}[] = [];
  for (const task of store.listTasks(current.goalId!)) {
    const record = store.latestHistoryRecord(task.id), omission = store.pendingOmission(task.id);
    const boundary = Math.max(record?.to ?? 0, omission?.to ?? 0);
    if (record) units.push({at: record.to, taskId: task.id, text: `task_ref: g${store.requireGoal(task.goalId).number}/t${task.number}\n${promptHistoryRecord(record)}`});
    if (omission) units.push({at: omission.to, text: omissionMarker(omission)});
    for (const t of store.turnsForTask(task.id)) {
      if (t.projectTurn < current.projectTurn && store.requestRoot(t.userEventId).id !== store.requestRoot(current.userEventId).id && !t.laneId && t.status !== "in_progress" && t.projectTurn > boundary && (t.completedAt ?? t.createdAt) <= asOf.toISOString() && !redone.has(t.id)) units.push({at: t.projectTurn, turn: t});
    }
  }
  units.sort((a,b) => b.at-a.at);
  const picked: {at: number; text: string; turn?: Turn}[] = [];
  let used = 0, newest = true;
  // The active capsule is required: reserve it before selecting bounded exact evidence.
  const active = store.latestHistoryRecord(current.taskId!);
  const mandatory = units.find(u => u.taskId === current.taskId && u.text && active && u.text.includes(`ref: ${active.handle}\n`));
  if (mandatory && countTokens(mandatory.text!) < totalBudget - 180) {picked.push({...mandatory, text: mandatory.text!}); used += countTokens(mandatory.text! + "\n\n");}
  for (const u of units) {
    if (u === mandatory) continue;
    const room = totalBudget - 180 - used;
    if (room < 100) break;
    const text = u.turn ? renderContextExchange(store, u.turn, {timeZone, tools: newest, budget: Math.min(room, newest ? previousBudget : room)}) : u.text!;
    if (!text || countTokens(text + "\n\n") > room) break;
    picked.push({...u,text}); used += countTokens(text + "\n\n");
    if (u.turn) newest = false;
  }
  picked.sort((a,b) => a.at-b.at);
  const turns = picked.flatMap(u=>u.turn ? [u.turn] : []);
  const omitted = units.length-picked.length;
  const notice = `## GENERAL_HISTORY_WINDOW\ntotal_allowance: ${totalBudget}\nprevious_exchange_allowance: ${previousBudget}\nomitted_records: ${omitted}\nCheckpoint-covered and explicitly omitted spans are not replayed. context_retrieve can recover exact older evidence. Notes are summaries; answers and tool evidence take precedence.\n\n`;
  return {parts:[{text:notice}, ...picked.map(u=>({text:u.text + "\n\n", cache:true}))], included:turns.map(t=>t.projectTurn), omitted, used:used+countTokens(notice), budget:totalBudget, dates:turns.map(t=>store.requestRoot(t.userEventId).at)};
}
