/**
 * Event log payloads. The event log is append-only and is the source of
 * truth; every ledger projection is derived from or recorded alongside these
 * events. Payloads are written only by the harness ("models propose, the
 * harness disposes").
 */

export interface EventPayloads {
  user_message: { text: string };
  routing_completed: {
    outcome: "decision" | "clarify";
    decision: unknown;
    model: string;
    attempts: number;
    escalated: boolean;
    fallback: string | null;
    ledger_queries: number;
    reason: string;
  };
  clarification_asked: { question: string; candidates: unknown[]; allow_new: boolean; zero_history: boolean };
  workspace_created: { name: string; root_path: string | null };
  goal_created: { goal_number: number; title: string; workspace_id: string | null; general: boolean };
  goal_workspace_bound: { workspace_id: string };
  goal_note_revised: { revision: number; note: string };
  task_created: { task_number: number; title: string; objective: string; general: boolean };
  task_revised: { revision: number; status: string; continuation_note: string | null; title: string; objective: string };
  chat_opened: { ordinal: number; continuation_of: string | null };
  turn_bound: {
    project_turn: number;
    part_order: number | null;
    workspace_confidence: "high" | "low" | null;
    first_mutation_gate_armed: boolean;
    route: string;
  };
  assistant_response: { text: string };
  turn_completed: { project_turn: number };
}

export type EventType = keyof EventPayloads;

export interface EventRefs {
  goal_id?: string | null;
  task_id?: string | null;
  chat_id?: string | null;
  turn_id?: string | null;
}

export interface StoredEvent<T extends EventType = EventType> extends Required<EventRefs> {
  seq: number;
  id: string;
  type: T;
  at: string;
  payload: EventPayloads[T];
}
