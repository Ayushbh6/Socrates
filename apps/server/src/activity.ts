import type { EventPayloads, StoredEvent } from "@socrates/contracts";
import { callLine } from "@socrates/retrieval";
import type { LedgerStore } from "@socrates/store";

/** A tool's output is previewed up to this many characters; the evidence route returns the rest. */
export const OUTPUT_PREVIEW_CHARS = 2_000;
const STEP_TEXT_CHARS = 4_000;

/** What happened, for the web app (architecture/server.md, "Live activity"). */
export type ActivityBody =
  | { kind: "message"; text: string }
  | { kind: "routed"; turnId: string; projectTurn: number; goal: { number: number; title: string }; task: { number: number; title: string }; lane: number | null }
  | { kind: "question"; turnId: string; text: string }
  | { kind: "step"; turnId: string; text: string }
  | { kind: "tool_started"; turnId: string; task: string; handle: string; line: string }
  | { kind: "tool_finished"; turnId: string; task: string; handle: string; status: "ok" | "error"; preview: string; truncated: boolean }
  | { kind: "answer"; turnId: string; text: string }
  | { kind: "finished"; turnId: string; status: "completed" | "interrupted"; reason: EventPayloads["turn_interrupted"]["reason"] | null; partial?: string | null }
  | { kind: "handed_off"; turnId: string; lane: number; laneId: string; goal: { number: number; title: string }; task: { number: number; title: string } }
  | { kind: "lane"; laneId: string; number: number; state: "opened" | "closed" }
  | { kind: "approval_decided"; turnId: string | null; granted: boolean; detail: string }
  | { kind: "warning"; turnId: string | null; detail: string }
  | { kind: "ledger" };

/** Every activity carries its event's sequence number, time, and conversation: "main" or a lane id. */
export type Activity = { seq: number; at: string; conversation: string } & ActivityBody;

const LEDGER_EVENTS = new Set(["goal_created", "task_created", "task_revised", "goal_note_revised", "goal_workspace_bound", "anchor_revised"]);

/**
 * One event as an activity, or null for events the app does not show. A
 * turn's activities belong to the conversation the turn runs in now; the
 * handoff itself belongs to the main conversation, where it was sent.
 */
export function activityOf(store: LedgerStore, event: StoredEvent): Activity | null {
  const turn = event.turn_id ? store.getTurn(event.turn_id) : null;
  const conversation = turn?.laneId ?? "main";
  const base = { seq: event.seq, at: event.at, conversation };
  const selector = () => {
    const task = store.requireTask(event.task_id!);
    return `g${store.requireGoal(task.goalId).number}/t${task.number}`;
  };
  switch (event.type) {
    case "user_message": {
      const p = event.payload as EventPayloads["user_message"];
      return { ...base, conversation: p.lane_id ?? "main", kind: "message", text: p.text };
    }
    case "turn_bound": {
      if (!turn?.goalId || !turn.taskId) return null;
      const goal = store.requireGoal(turn.goalId);
      const task = store.requireTask(turn.taskId);
      return { ...base, kind: "routed", turnId: turn.id, projectTurn: turn.projectTurn, goal: { number: goal.number, title: goal.title }, task: { number: task.number, title: task.title }, lane: turn.laneId ? store.requireLane(turn.laneId).number : null };
    }
    case "agent_message": {
      const p = event.payload as EventPayloads["agent_message"];
      // Narration before tool calls; the final answer arrives as `answer`.
      if (p.phase !== "work" || !p.response.toolCalls.length || !p.response.text.trim() || !turn) return null;
      return { ...base, kind: "step", turnId: turn.id, text: p.response.text.trim().slice(0, STEP_TEXT_CHARS) };
    }
    case "tool_called": {
      const p = event.payload as EventPayloads["tool_called"];
      if (!turn) return null;
      return { ...base, kind: "tool_started", turnId: turn.id, task: selector(), handle: p.handle, line: callLine(p.tool, p.input) };
    }
    case "tool_completed": {
      const p = event.payload as EventPayloads["tool_completed"];
      if (!turn) return null;
      return { ...base, kind: "tool_finished", turnId: turn.id, task: selector(), handle: p.handle, status: p.status, preview: p.content.slice(0, OUTPUT_PREVIEW_CHARS), truncated: p.content.length > OUTPUT_PREVIEW_CHARS };
    }
    case "assistant_response": {
      if (!turn) return null;
      const text = (event.payload as EventPayloads["assistant_response"]).text;
      return turn.kind === "clarification" ? { ...base, kind: "question", turnId: turn.id, text } : { ...base, kind: "answer", turnId: turn.id, text };
    }
    case "turn_completed":
      return turn?.kind === "task" ? { ...base, kind: "finished", turnId: turn.id, status: "completed", reason: null } : null;
    case "turn_interrupted": {
      // A stopped answer keeps what had been written.
      const p = event.payload as EventPayloads["turn_interrupted"];
      return turn ? { ...base, kind: "finished", turnId: turn.id, status: "interrupted", reason: p.reason, partial: p.partial_answer ?? null } : null;
    }
    case "turn_moved_to_lane": {
      const p = event.payload as EventPayloads["turn_moved_to_lane"];
      const goal = store.requireGoal(turn!.goalId!);
      const task = store.requireTask(turn!.taskId!);
      return { ...base, conversation: "main", kind: "handed_off", turnId: event.turn_id!, lane: store.requireLane(p.lane_id).number, laneId: p.lane_id, goal: { number: goal.number, title: goal.title }, task: { number: task.number, title: task.title } };
    }
    case "lane_opened":
    case "lane_closed": {
      const laneId = (event.payload as EventPayloads["lane_opened"]).lane_id;
      return { ...base, conversation: laneId, kind: "lane", laneId, number: store.requireLane(laneId).number, state: event.type === "lane_opened" ? "opened" : "closed" };
    }
    case "approval_decided": {
      const p = event.payload as EventPayloads["approval_decided"];
      return { ...base, kind: "approval_decided", turnId: turn?.id ?? null, granted: p.granted, detail: p.detail };
    }
    case "agent_warning":
      return { ...base, kind: "warning", turnId: turn?.id ?? null, detail: (event.payload as EventPayloads["agent_warning"]).detail };
    default:
      return LEDGER_EVENTS.has(event.type) ? { ...base, kind: "ledger" } : null;
  }
}
