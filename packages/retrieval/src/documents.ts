import { createHash } from "node:crypto";
import type { LedgerStore } from "@socrates/store";

/**
 * What the embedding index holds (agent-harness.md, "Embeddings"). Each
 * document points back to its exact source in the ledger; search returns
 * pointers, never a replacement for the source.
 *
 * - goal: title, objective, note, workspace, and anchors (the keyword index's text);
 * - task: title, objective, completion criteria, continuation note, and derived facts;
 * - exchange: the user's request and the final answer of one turn, in overlapping chunks;
 * - tool_call: one line per call naming the tool and its input; outputs are not
 *   embedded, the call's evidence handle opens them;
 * - capability: an installed Skill's or MCP tool's name and description.
 */
export type DocumentKind = "goal" | "task" | "exchange" | "tool_call" | "capability";

export interface SourceDocument {
  id: string;
  kind: DocumentKind;
  /** The source record: a goal, task, or turn id, or a capability's catalog name. */
  sourceId: string;
  goalId: string | null;
  taskId: string | null;
  turnId: string | null;
  projectTurn: number | null;
  /** When the source last changed; recency and date filters use it. */
  at: string;
  text: string;
}

/** Long exchanges are split into overlapping windows that fit the embedding model's input. */
export const CHUNK_CHARS = 4_000;
export const CHUNK_OVERLAP_CHARS = 600;
const CALL_INPUT_CHARS = 300;

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Overlapping windows that break at whitespace where possible. */
export function chunkText(text: string, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP_CHARS): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const space = text.lastIndexOf(" ", end);
      if (space > start + size / 2) end = space;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}

export function goalDocument(store: LedgerStore, goalId: string): SourceDocument {
  const goal = store.requireGoal(goalId);
  const { title, body } = store.goalSearchText(goalId);
  return { id: `goal:${goalId}`, kind: "goal", sourceId: goalId, goalId, taskId: null, turnId: null, projectTurn: null, at: goal.updatedAt, text: `${title}\n${body}`.trim() };
}

export function taskDocument(store: LedgerStore, taskId: string): SourceDocument {
  const task = store.requireTask(taskId);
  const { title, body } = store.taskSearchText(taskId);
  return { id: `task:${taskId}`, kind: "task", sourceId: taskId, goalId: task.goalId, taskId, turnId: null, projectTurn: null, at: task.updatedAt, text: `${title}\n${body}`.trim() };
}

/** A turn's exchange chunks and tool-call lines; none for a turn without a searchable exchange. */
export function turnDocuments(store: LedgerStore, turnId: string): SourceDocument[] {
  const exchange = store.exchangeForTurn(turnId);
  if (!exchange) return [];
  const base = { goalId: exchange.goalId, taskId: exchange.taskId, turnId, projectTurn: exchange.projectTurn };
  const docs: SourceDocument[] = chunkText(`USER:\n${exchange.userMessage}\n\nSOCRATES:\n${exchange.response}`).map((text, i) => ({
    ...base, id: `exchange:${turnId}:${i}`, kind: "exchange", sourceId: turnId, at: exchange.at, text,
  }));
  for (const ev of store.evidenceForTurn(turnId)) {
    docs.push({ ...base, id: `tool_call:${exchange.taskId}:${ev.handle}`, kind: "tool_call", sourceId: turnId, at: exchange.at, text: callLine(ev.tool, ev.input) });
  }
  return docs;
}

export function capabilityDocument(entry: { kind: "skill" | "mcp"; name: string; description: string }, at: string): SourceDocument {
  return { id: `capability:${entry.kind}:${entry.name}`, kind: "capability", sourceId: entry.name, goalId: null, taskId: null, turnId: null, projectTurn: null, at, text: `${entry.name}\n${entry.description}` };
}

/** One line naming a call and the part of its input that says what it did. */
export function callLine(tool: string, input: unknown): string {
  const i = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const cut = (s: string) => (s.length > CALL_INPUT_CHARS ? `${s.slice(0, CALL_INPUT_CHARS - 1)}…` : s);
  switch (tool) {
    case "terminal": return `terminal: ${cut(String(i.command ?? ""))}`;
    case "read": case "edit": return `${tool} ${String(i.path ?? "")}`;
    case "glob": case "grep": return `${tool} ${JSON.stringify(i.pattern ?? "")}${i.path ? ` in ${String(i.path)}` : ""}`;
    case "apply_patch": {
      const files = [...String(i.patch ?? "").matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1]);
      return `apply_patch ${files.join(", ")}`;
    }
    default: return `${tool} ${cut(JSON.stringify(input ?? {}))}`;
  }
}

/**
 * The documents to refresh for the events after a watermark: the goals,
 * tasks, and turns those events touched. With no watermark, everything.
 */
export function changedDocuments(store: LedgerStore, afterSeq: number | null): SourceDocument[] {
  const goals = new Set<string>();
  const tasks = new Set<string>();
  const turns = new Set<string>();
  if (afterSeq === null) {
    for (const g of store.listGoals()) goals.add(g.id);
    for (const t of store.allTasks()) tasks.add(t.task.id);
    for (const id of store.exchangeTurnIds()) turns.add(id);
  } else {
    for (const e of store.listEvents({ afterSeq })) {
      if (e.goal_id) goals.add(e.goal_id);
      if (e.type === "goal_workspace_bound" && e.goal_id) {
        for (const task of store.listTasks(e.goal_id)) tasks.add(task.id);
      }
      if (e.task_id) tasks.add(e.task_id);
      if (e.turn_id) turns.add(e.turn_id);
    }
  }
  const docs: SourceDocument[] = [];
  for (const id of goals) if (store.getGoal(id)) docs.push(goalDocument(store, id));
  for (const id of tasks) if (store.getTask(id)) docs.push(taskDocument(store, id));
  for (const id of turns) docs.push(...turnDocuments(store, id));
  return docs;
}
