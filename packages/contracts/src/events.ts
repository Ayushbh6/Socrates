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
    validation_errors?: string[];
  };
  clarification_asked: { question: string; candidates: unknown[]; allow_new: boolean; zero_history: boolean; candidate_bindings?: ({ goal_id: string; task_id: string | null } | null)[] };
  workspace_created: { workspace_id: string; name: string; root_path: string | null };
  goal_created: { goal_number: number; title: string; workspace_id: string | null; general: boolean; objective?: string | null };
  goal_workspace_bound: { workspace_id: string };
  goal_note_revised: { revision: number; note: string };
  task_created: { task_number: number; title: string; objective: string; general: boolean; completion_criteria?: string | null };
  task_revised: { revision: number; status: string; continuation_note: string | null; title: string; objective: string; completion_criteria?: string | null };
  chat_opened: { ordinal: number; continuation_of: string | null; handover_ref: string | null };
  clarification_bound: { project_turn: number; user_event_id: string };
  anchor_revised: { anchor_id: string; path: string; role: string; status: "provisional" | "active" | "superseded"; summary: string };
  turn_bound: {
    project_turn: number;
    part_order: number | null;
    workspace_confidence: "high" | "low" | null;
    first_mutation_gate_armed: boolean;
    route: string;
    user_event_id: string;
    /** Original request when the current user message answers a clarification. */
    request_event_id: string;
    request_range: [number, number] | null;
    clarification_turn_id: string | null;
    depends_on: number[];
  };
  assistant_response: { text: string };
  turn_completed: { project_turn: number; response_event_id: string };
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
