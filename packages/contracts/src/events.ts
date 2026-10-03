import type { JsonSchema, ModelResponse } from "./model";

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
  anchor_question: { proposals: { path: string; role: string; reason: string; hash: string; conflicts: string[] }[] };
  anchor_decided: { path: string; role: string; hash: string; decision: "approved" | "rejected" | "ignored"; question_id?: string };
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
  /** Exact received agent output, including intermediate and invalid candidates.
   * Separate from assistant_response, which is the accepted visible answer. */
  agent_message: { phase: "work" | "wrap_up" | "repair"; response: ModelResponse };
  /**
   * `stop` says why the working agent ended: its own final answer, or the
   * wrap-up after a per-turn limit. `task_complete_reason` is the agent's
   * completion proposal, recorded with the task's completed status.
   */
  turn_completed: { project_turn: number; response_event_id: string; stop?: TurnStop; task_complete_reason?: string | null };
  /**
   * A history checkpoint or handover capsule, stored under its task-scoped
   * handle `hc-N`. `from`/`to` is the project-turn range it covers; 0/0 means
   * it covers no turns. `content` is the validated schema output, or the
   * harness's mechanical capsule when `mechanical` is true.
   */
  history_record_created: { number: number; kind: "checkpoint" | "handover"; from: number; to: number; content: unknown; mechanical: boolean };
  /** Turns a failed checkpoint left out of the prompt until a later checkpoint absorbs them. */
  history_omitted: { from: number; to: number };
  /** One compaction of a chat: the layers that ran and the checkpoint it wrote. */
  compaction_recorded: {
    count: number;
    layers: ("checkpoint" | "linearize" | "failsafe")[];
    checkpoint: string | null;
    before_tokens: number;
    after_tokens: number;
  };
  /** A chat closed by automatic rollover; its continuation opens with the handover capsule. */
  chat_closed: { reason: "rollover"; handover: string };
  /** A turn that ended without a final answer: cancelled by the user, or failed. */
  turn_interrupted: { project_turn: number; reason: "cancelled" | "failed"; tool_calls: number; continuation_note: string };
  /** An operational warning about one turn, such as a rejected final answer or anchor proposal. */
  agent_warning: { kind: "final_answer_invalid" | "anchor_rejected" | "model_error" | "agent_error" | "context_limit" | "compactor_failed" | "compaction_failsafe"; detail: string };
  /**
   * One working-agent tool call, exactly as the model emitted it. `handle` is
   * the call's permanent evidence handle within its task ("e12").
   */
  tool_called: { call_id: string; tool: string; input: unknown; handle: string };
  /**
   * The complete result of one tool call. `result` is the full structured
   * result (or null on failure); `content` is the bounded model-facing text.
   * `diagnostics` holds internal detail of an infrastructure failure and is
   * never shown to a model.
   */
  tool_completed: {
    call_id: string;
    handle: string;
    tool: string;
    status: "ok" | "error";
    content: string;
    result: unknown;
    error: { code: string; message: string; correction: string; retryable: boolean } | null;
    /** The complete failure detail of a correctable failure, such as an MCP server's error output. */
    failure_detail?: unknown;
    diagnostics: string | null;
    /** Content hashes the call observed or produced, for the stale-edit check. */
    observed: { path: string; hash: string | null }[];
    facts: { kind: "file_changed" | "command" | "test" | "capability"; value: string }[];
    wall_time_ms: number;
  };
  /** One file mutation with complete before/after text (null for absent files). */
  file_changed: { call_id: string; path: string; action: "created" | "updated" | "deleted" | "moved"; from_path: string | null; before: string | null; after: string | null };
  terminal_started: { session_id: string; name: string | null; command: string; cwd: string; background: boolean };
  /** A session's exit, with the facts derived from it (a test run's outcome) for the launching task. */
  terminal_exited: { session_id: string; exit_code: number | null; signal: string | null; reason: "exited" | "terminated" | "timeout" | "failed"; facts?: { kind: "test"; value: string }[] };
  /** One approval decision. An MCP tool approval names the tool's catalog name as its subject. */
  approval_decided: { kind: "first_mutation" | "sigkill" | "no_deadline" | "mcp_tool"; granted: boolean; detail: string; subject?: string };
  capability_activated: { kind: "skill" | "mcp"; name: string; version: string; digest: string };
  capability_deactivated: { kind: "skill" | "mcp"; name: string };
  /** A configured MCP server's tools/list, recorded whenever it differs from the server's previous snapshot. */
  mcp_tools_listed: { server: string; digest: string; tools: McpToolSnapshot[] };
  /** The goal's Skill shelf, resolved once and frozen so ordinary turns stay cache-stable. */
  skill_shelf_frozen: { skills: { name: string; description: string }[] };
}

export type EventType = keyof EventPayloads;

/** One tool as its MCP server advertised it. */
export interface McpToolSnapshot {
  name: string;
  description: string;
  /** The server's readOnlyHint annotation; servers are user-configured and trusted. */
  read_only: boolean;
  input_schema: JsonSchema;
}

export type TurnStop = "final" | "steps" | "time" | "tokens" | "context";

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
