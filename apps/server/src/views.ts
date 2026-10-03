import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { EventPayloads } from "@socrates/contracts";
import { callLine } from "@socrates/retrieval";
import type { LedgerStore, Turn, Workspace } from "@socrates/store";

/** Turns per history page; a message's compound parts always stay on one page. */
export const HISTORY_PAGE_TURNS = 30;
const FOLDER_LIST_MAX = 500;

export interface HistoryPart {
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
  /** The message's ledger event; stable across pages. */
  id: string;
  at: string;
  message: string;
  /** The router's question, when the message was answered with one instead of being worked on. */
  question: string | null;
  parts: HistoryPart[];
}

/**
 * One conversation's history, newest message first (architecture/server.md,
 * "History"). `before` pages backward by project turn; `next` is the value
 * for the following page, or null at the start.
 */
export function conversationHistory(store: LedgerStore, laneId: string | null, before?: number, limit = HISTORY_PAGE_TURNS): { items: HistoryItem[]; next: number | null } {
  const turns = store.conversationTurns(laneId, { ...(before !== undefined ? { before } : {}), limit });
  const items: HistoryItem[] = [];
  const seen = new Set<string>();
  let next: number | null = turns.length === limit ? turns.at(-1)!.projectTurn : null;
  for (const turn of turns) {
    if (seen.has(turn.userEventId)) continue;
    seen.add(turn.userEventId);
    const event = store.getEvent(turn.userEventId)!;
    const sentIn = (event.payload as EventPayloads["user_message"]).lane_id ?? null;
    // In the main conversation, a message's parts include any handed to a lane; in a lane, only its own.
    const all = store.turnsForUserEvent(turn.userEventId).filter((t) => (laneId ? t.laneId === laneId : sentIn === null));
    if (next !== null) next = Math.min(next, ...all.map((t) => t.projectTurn));
    const clarification = all.find((t) => t.kind === "clarification");
    items.push({
      id: turn.userEventId,
      at: event.at,
      message: (event.payload as EventPayloads["user_message"]).text,
      question: clarification ? responseText(store, clarification) : null,
      parts: all.filter((t) => t.kind === "task").map((t) => part(store, t, laneId)),
    });
  }
  return { items, next };
}

function part(store: LedgerStore, t: Turn, laneId: string | null): HistoryPart {
  const goal = store.requireGoal(t.goalId!);
  const task = store.requireTask(t.taskId!);
  return {
    projectTurn: t.projectTurn,
    status: t.status,
    goal: { number: goal.number, title: goal.title },
    task: { number: task.number, title: task.title },
    lane: t.laneId ? store.requireLane(t.laneId).number : null,
    handedOff: laneId === null && t.laneId !== null,
    answer: responseText(store, t),
    interrupted: store.interruption(t.id)?.reason ?? null,
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
  if (!existsSync(input) || !statSync(input).isDirectory()) throw new FolderError("That folder does not exist.");
  const real = realpathSync(input);
  const home = realpathSync(homedir());
  if (real === path.parse(real).root || real === home) throw new FolderError("Choose a project folder, not the whole disk or your home folder.");
  const data = existsSync(dataHome) ? realpathSync(dataHome) : path.resolve(dataHome);
  if (real === data || real.startsWith(`${data}${path.sep}`)) throw new FolderError("That folder is Socrates' own data folder.");
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
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new FolderError("That folder does not exist.");
  const real = realpathSync(dir);
  const folders = readdirSync(real, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(real, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, FOLDER_LIST_MAX);
  const parent = path.dirname(real);
  return { path: real, parent: parent === real ? null : parent, folders };
}
