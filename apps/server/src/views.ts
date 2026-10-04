import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { EventPayloads } from "@socrates/contracts";
import { callLine } from "@socrates/retrieval";
import type { LedgerStore, Turn, Workspace } from "@socrates/store";
import { assertSeparateFromClassic } from "./config";
import { type Activity, activityOf } from "./activity";
import { type AttachmentView, viewOf } from "./attachments";

/** Turns per history page; a message's compound parts always stay on one page. */
export const HISTORY_PAGE_TURNS = 30;
const FOLDER_LIST_MAX = 500;

export interface HistoryPart {
  turnId: string;
  projectTurn: number;
  status: Turn["status"];
  goal: { number: number; title: string };
  task: { number: number; title: string };
  /** The lane the part ran in, or null for the main conversation. */
  lane: number | null;
  /** A main-conversation part handed to the lane busy with its task. */
  handedOff: boolean;
  answer: string | null;
  /** Why an interrupted part ended. */
  interrupted: EventPayloads["turn_interrupted"]["reason"] | null;
  toolCalls: { handle: string; line: string; status: "ok" | "error" | null }[];
}

export interface HistoryItem {
  /** Snapshot boundary: replayed events through here are already represented. */
  throughSeq: number;
  /** Ordered narration, tool previews and decisions, using the live activity format. */
  activities: Activity[];
  /** The message's ledger event; stable across pages. */
  id: string;
  /** Images the user attached, without where they are stored. */
  attachments: AttachmentView[];
  /** That event's sequence number: a page resumes the live connection from just before an unfinished message. */
  seq: number;
  at: string;
  message: string;
  /** The exact message is saved, but routing has not bound any part yet. */
  unrouted: boolean;
  /** The router's question, when the message was answered with one instead of being worked on. */
  question: string | null;
  parts: HistoryPart[];
}

/**
 * One conversation's history, newest message first (architecture/server.md,
 * "History"). `before` pages backward by message event; `next` is the value
 * for the following page, or null at the start.
 */
export function conversationHistory(store: LedgerStore, laneId: string | null, before?: number, limit = HISTORY_PAGE_TURNS): { items: HistoryItem[]; next: number | null; seq: number } {
  const seq = store.latestEventSeq();
  const messages = store.conversationMessages(laneId, { ...(before !== undefined ? { before } : {}), limit });
  const items: HistoryItem[] = [];
  for (const event of messages) {
    const turns = store.turnsForUserEvent(event.id);
    // In the main conversation, a message's parts include any handed to a lane; in a lane, only its own.
    const all = turns.filter((t) => !laneId || t.laneId === laneId);
    const clarification = all.find((t) => t.kind === "clarification");
    items.push({
      throughSeq: seq,
      activities: all.flatMap((turn) => store.listEvents({ turnId: turn.id }))
        .sort((a, b) => a.seq - b.seq)
        .flatMap((event) => {
          const a = activityOf(store, event);
          return a && ["step", "tool_started", "tool_finished", "warning", "approval_decided"].includes(a.kind) ? [a] : [];
        }),
      id: event.id,
      seq: event.seq,
      at: event.at,
      message: event.payload.text,
      attachments: (event.payload.attachments ?? []).map(viewOf),
      unrouted: turns.length === 0,
      question: clarification ? responseText(store, clarification) : null,
      parts: all.filter((t) => t.kind === "task").map((t) => part(store, t, laneId)),
    });
  }
  const oldest = messages.at(-1)?.seq;
  const next = oldest !== undefined && store.conversationMessages(laneId, { before: oldest, limit: 1 }).length ? oldest : null;
  return { items, next, seq };
}

function part(store: LedgerStore, t: Turn, laneId: string | null): HistoryPart {
  const interruption = store.interruption(t.id);
  const goal = store.requireGoal(t.goalId!);
  const task = store.requireTask(t.taskId!);
  return {
    turnId: t.id,
    projectTurn: t.projectTurn,
    status: t.status,
    goal: { number: goal.number, title: goal.title },
    task: { number: task.number, title: task.title },
    lane: t.laneId ? store.requireLane(t.laneId).number : null,
    handedOff: laneId === null && t.laneId !== null,
    // A stopped part shows its answer as far as it was written.
    answer: responseText(store, t) ?? interruption?.partial_answer ?? null,
    interrupted: interruption?.reason ?? null,
    toolCalls: store.evidenceForTurn(t.id).map((e) => ({ handle: e.handle, line: callLine(e.tool, e.input), status: e.status })),
  };
}

function responseText(store: LedgerStore, turn: Turn): string | null {
  return turn.responseEventId ? (store.getEvent(turn.responseEventId)!.payload as EventPayloads["assistant_response"]).text : null;
}

/** Every goal with its tasks, most recently updated first. */
export function goalsView(store: LedgerStore) {
  return store.listGoals()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((goal) => ({
      number: goal.number,
      title: goal.title,
      objective: goal.objective,
      note: goal.note,
      status: goal.status,
      general: goal.general,
      workspace: goal.workspaceId ? (store.getWorkspace(goal.workspaceId)?.name ?? null) : null,
      updatedAt: goal.updatedAt,
      tasks: store.listTasks(goal.id).map((task) => ({ number: task.number, title: task.title, status: task.status, note: task.continuationNote, updatedAt: task.updatedAt })),
    }));
}

export class FolderError extends Error {
  override name = "FolderError";
}

/**
 * Check a folder the user offers as a workspace: an existing directory, by
 * its real path, that is neither the whole disk, the home folder itself, nor
 * inside Socrates' own data folder.
 */
export function workspaceFolder(input: string, dataHome: string): string {
  if (!path.isAbsolute(input)) throw new FolderError("Give the folder's full path.");
  const real = folderPath(input);
  const home = realpathSync(homedir());
  if (real === path.parse(real).root || real === home) throw new FolderError("Choose a project folder, not the whole disk or your home folder.");
  const data = existsSync(dataHome) ? realpathSync(dataHome) : path.resolve(dataHome);
  if (real === data || real.startsWith(`${data}${path.sep}`)) throw new FolderError("That folder is Socrates' own data folder.");
  if (data.startsWith(`${real}${path.sep}`)) throw new FolderError("That folder contains Socrates' own data folder.");
  try { assertSeparateFromClassic(real); } catch { throw new FolderError("That folder belongs to Socrates 0.1. Choose a project folder."); }
  return real;
}

/** The workspace for a folder: the existing one with that path, or a new one named after it. */
export function workspaceFor(store: LedgerStore, folder: string): Workspace {
  const existing = store.listWorkspaces().find((w) => w.rootPath === folder);
  if (existing) return existing;
  const base = path.basename(folder) || "project";
  let name = base;
  for (let n = 2; store.findWorkspaceByName(name); n++) name = `${base}-${n}`;
  return store.createWorkspace(name, folder);
}

/** The visible subfolders of a folder, for choosing a workspace. */
export function listFolders(input: string | undefined): { path: string; parent: string | null; folders: { name: string; path: string }[] } {
  const dir = input ?? homedir();
  if (!path.isAbsolute(dir)) throw new FolderError("Give the folder's full path.");
  const real = folderPath(dir);
  let entries;
  try { entries = readdirSync(real, { withFileTypes: true }); }
  catch { throw new FolderError("That folder cannot be read. Choose an accessible folder."); }
  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(real, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, FOLDER_LIST_MAX);
  const parent = path.dirname(real);
  return { path: real, parent: parent === real ? null : parent, folders };
}

function folderPath(input: string): string {
  try {
    if (statSync(input).isDirectory()) return realpathSync(input);
  } catch {}
  throw new FolderError("That folder does not exist.");
}
