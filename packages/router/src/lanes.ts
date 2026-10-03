import type { EventPayloads } from "@socrates/contracts";
import { callLine } from "@socrates/retrieval";
import { zonedParts } from "@socrates/shared";
import { type Goal, type Lane, type LedgerStore, type Task, excerpt } from "@socrates/store";

/** A lane that finished or stopped drops out of the summaries after this long. */
export const LANE_VISIBLE_HOURS = 24;

export type LaneStatus = "starting" | "working" | "waiting_for_answer" | "finished" | "stopped";

/** What a parallel lane is doing, derived from the ledger (agent-harness.md, "Lanes"). */
export interface LaneSummary {
  lane: Lane;
  status: LaneStatus;
  goal: Goal | null;
  task: Task | null;
  workspace: string | null;
  /** When the lane's latest turn started (working) or ended. */
  at: string;
  /** The newest tool call of a working lane, as one line. */
  latestStep: string | null;
  /** A finished lane's answer, a stopped lane's last words, or the question a lane waits on. */
  text: string | null;
}

/**
 * The open lanes, oldest first, except `exclude`; lanes that finished or
 * stopped more than LANE_VISIBLE_HOURS ago are left out.
 */
export function laneSummaries(store: LedgerStore, now: Date, exclude: string | null = null): LaneSummary[] {
  const since = new Date(now.getTime() - LANE_VISIBLE_HOURS * 3_600_000).toISOString();
  const out: LaneSummary[] = [];
  for (const lane of store.listLanes()) {
    if (lane.id === exclude) continue;
    const turn = store.latestLaneTurn(lane.id);
    if (!turn) {
      out.push({ lane, status: "starting", goal: null, task: null, workspace: null, at: lane.openedAt, latestStep: null, text: null });
      continue;
    }
    const response = turn.responseEventId ? (store.getEvent(turn.responseEventId)?.payload as EventPayloads["assistant_response"] | undefined)?.text ?? null : null;
    if (turn.kind === "clarification") {
      out.push({ lane, status: "waiting_for_answer", goal: null, task: null, workspace: null, at: turn.completedAt ?? turn.createdAt, latestStep: null, text: response });
      continue;
    }
    const goal = store.requireGoal(turn.goalId!);
    const task = store.requireTask(turn.taskId!);
    const workspace = goal.workspaceId ? (store.getWorkspace(goal.workspaceId)?.name ?? null) : null;
    const status: LaneStatus = turn.status === "in_progress" ? "working" : turn.status === "completed" ? "finished" : "stopped";
    const at = status === "working" ? turn.createdAt : (turn.completedAt ?? turn.createdAt);
    if (status !== "working" && at < since) continue;
    const last = status === "working" ? store.evidenceForTurn(turn.id).at(-1) : undefined;
    out.push({ lane, status, goal, task, workspace, at, latestStep: last ? callLine(last.tool, last.input) : null, text: status === "working" ? null : response });
  }
  return out;
}

/** "14:05" today, "2026-10-02 14:05" otherwise. */
export function laneTime(at: string, now: Date, timeZone: string): string {
  const when = zonedParts(new Date(at), timeZone);
  return when.date === zonedParts(now, timeZone).date ? when.time : `${when.date} ${when.time}`;
}

export function laneSelector(store: LedgerStore, summary: LaneSummary): string | null {
  return summary.goal && summary.task ? `g${summary.goal.number}/t${summary.task.number}` : null;
}

/** The router's LANES section: one line per lane with selectors it may route to. */
export function renderLanesForRouter(store: LedgerStore, summaries: LaneSummary[], now: Date, timeZone: string): string {
  return summaries.map((s) => {
    const status = s.status === "working" ? "working" : s.status === "waiting_for_answer" ? "waiting for the user's answer" : s.status === "starting" ? "starting" : `${s.status} at ${laneTime(s.at, now, timeZone)}`;
    const work = s.goal && s.task ? ` — goal g${s.goal.number} "${excerpt(s.goal.title, 80)}" · task ${laneSelector(store, s)} "${excerpt(s.task.title, 80)}" · workspace ${s.workspace ?? "—"}` : "";
    return `lane ${s.lane.number} — ${status}${work}`;
  }).join("\n");
}
