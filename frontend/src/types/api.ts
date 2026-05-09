// Shared TypeScript types mirroring CONTRACTS.md

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export type InputMode = 'text' | 'voice'
export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'queued' | 'completed' | 'failed'
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'blocked' | 'cancelled' | 'stalled'

export interface User {
  id: string
  display_name: string
  preferences: Record<string, unknown>
  created_at: string
  updated_at: string
  onboarding_completed_at: string | null
}

export interface Project {
  id: string
  user_id: string
  name: string
  description: string | null
  status: 'active'
  default_system_prompt: string | null
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface Conversation {
  id: string
  project_id: string
  title: string
  summary: string | null
  model: string
  thinking_level: ThinkingLevel
  created_at: string
  updated_at: string
  archived_at: string | null
}

export interface Asset {
  id: string
  project_id: string
  created_by_task_id: string | null
  kind: string
  source_type: string
  original_name: string
  mime_type: string
  storage_path: string
  size_bytes: number
  sha256: string
  created_at: string
  deleted_at: string | null
  metadata: Record<string, unknown>
}

export interface Message {
  id: string
  project_id: string
  conversation_id: string
  agent_run_id: string | null
  task_id: string | null
  execution_mode: 'chat' | 'task'
  role: MessageRole
  input_mode: InputMode
  content_text: string | null
  thinking_text: string | null
  status: MessageStatus
  sequence_no: number
  provider: string | null
  model: string | null
  created_at: string
  updated_at: string
  failed_at: string | null
  metadata: Record<string, unknown>
  assets: Asset[]
}

export interface BootstrapStatus {
  has_user: boolean
  onboarding_completed: boolean
}

export interface SendMessageResponse {
  message_id: string
  agent_run_id: string
  status: AgentRunStatus
}

export interface ApiErrorDetail {
  code?: string
  message?: string
  run_id?: string
}

// ── Trace types ────────────────────────────────────────────────────────────────

export interface AgentRun {
  id: string
  project_id: string
  conversation_id: string
  task_id: string | null
  trigger_message_id: string | null
  response_message_id: string | null
  status: AgentRunStatus
  execution_mode: 'chat' | 'task'
  provider: string | null
  model: string | null
  input_mode: InputMode
  system_prompt_text: string | null
  query_text: string | null
  request_json: Record<string, unknown>
  final_response_json: Record<string, unknown>
  final_parsed_json: Record<string, unknown>
  aggregated_metadata_json: Record<string, unknown>
  usage_input_tokens: number | null
  usage_output_tokens: number | null
  usage_completion_tokens: number | null
  usage_total_tokens: number | null
  elapsed_ms: number | null
  started_at: string | null
  completed_at: string | null
  error_message: string | null
  created_at: string
  event_count: number
  turn_count: number
}

export interface AgentRunTurn {
  id: string
  agent_run_id: string
  round_index: number
  phase: string
  provider: string | null
  model: string | null
  request_json: Record<string, unknown>
  response_json: Record<string, unknown>
  raw_dump_json: Record<string, unknown>
  parsed_output_json: Record<string, unknown>
  metadata_json: Record<string, unknown>
  had_thinking: boolean
  tool_call_count: number
  parsed_output_present: boolean
  usage_input_tokens: number | null
  usage_output_tokens: number | null
  usage_completion_tokens: number | null
  usage_total_tokens: number | null
  elapsed_ms: number | null
  created_at: string
}

export interface AgentRunEvent {
  id: string
  agent_run_id: string
  agent_run_turn_id: string | null
  sequence_no: number
  event_type: string
  status: string
  content_text: string | null
  thinking_text: string | null
  tool_call_ref: string | null
  payload: Record<string, unknown>
  created_at: string
}

export interface ProjectWorkspace {
  id: string
  project_id: string
  label: string
  root_path: string
  editor_type: string
  is_primary: boolean
  access_granted: boolean
  access_granted_at: string | null
  access_revoked_at: string | null
  created_at: string
  updated_at: string
}

export interface Task {
  id: string
  project_id: string
  conversation_id: string
  project_workspace_id: string | null
  created_from_agent_run_id: string | null
  last_agent_run_id: string | null
  status: string
  title: string
  goal_text: string
  success_criteria_text: string | null
  brief_markdown: string
  workspace_root: string
  workspace_host_root: string | null
  venv_path: string
  result_summary: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  failed_at: string | null
  recovery_state: TaskRecoveryState | null
}

export interface TaskRecoveryAction {
  id: 'retry_remaining_work' | 'revise_plan' | 'accept_partial_output' | 'close_task_failed' | 'start_separate_task' | string
  label: string
  description: string
  owner: 'socrates' | string
}

export interface TaskRecoveryState {
  kind:
    | 'cancelled'
    | 'stalled'
    | 'worker_blocked'
    | 'outputs_waiting_for_acceptance'
    | 'completion_approval_pending'
    | string
  title: string
  summary: string
  source_run_id?: string | null
  source_worker_run_id?: string | null
  source_approval_id?: string | null
  blockers?: unknown[]
  todo?: unknown
  outputs?: unknown[]
  suggested_actions: TaskRecoveryAction[]
}

export interface TaskArtifact {
  id: string
  task_id: string
  asset_id: string | null
  relative_path: string
  artifact_role: string
  display_name: string
  mime_type: string | null
  size_bytes: number | null
  sha256: string | null
  promoted_to_asset: boolean
  metadata: Record<string, unknown>
  created_at: string
}

export interface TaskWorkspaceEntry {
  path: string
  name: string
  parent_path: string | null
  is_dir: boolean
  size_bytes: number | null
  mime_type: string | null
  updated_at: string
}

export interface TaskWorkspaceRoot {
  path: string
  name: string
  entries: TaskWorkspaceEntry[]
}

export interface TaskWorkspaceTree {
  task_id: string
  roots: TaskWorkspaceRoot[]
}

export interface TaskWorkspaceFilePreview {
  task_id: string
  path: string
  name: string
  mime_type: string
  size_bytes: number
  sha256: string
  preview_type: 'text' | 'image' | 'binary'
  content_text?: string | null
  data_url?: string | null
  encoding?: string | null
  truncated: boolean
}

export interface TaskApproval {
  id: string
  task_id: string
  agent_run_id: string | null
  tool_execution_id: string | null
  approval_type: string
  status: 'pending' | 'approved' | 'denied'
  request_json: Record<string, unknown>
  decision_json: Record<string, unknown>
  requested_at: string | null
  resolved_at: string | null
  created_at: string
  resume_agent_run_id?: string | null
  resume_status?: AgentRunStatus | null
  resume_error?: string | null
}

// ── WebSocket event union ──────────────────────────────────────────────────────

export interface WsEventBase {
  seq?: number
}

export interface ToolCallPayload {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface WsRunStarted extends WsEventBase {
  type: 'run.started'
  run_id: string
  conversation_id: string
}
export interface WsRunSnapshot extends WsEventBase {
  type: 'run.snapshot'
  run_id: string
  conversation_id: string
  status: AgentRunStatus
  last_seq: number
  response_message_id: string | null
  error: string | null
}
export interface WsRunTurnStarted extends WsEventBase {
  type: 'run.turn.started'
  run_id: string
  turn_id: string
  round_index: number
}
export interface WsRunThinkingDelta extends WsEventBase {
  type: 'run.thinking.delta'
  run_id: string
  round_index: number
  delta: string
}
export interface WsRunContentDelta extends WsEventBase {
  type: 'run.content.delta'
  run_id: string
  round_index: number
  delta: string
}
export interface WsRunAssistantMessage extends WsEventBase {
  type: 'run.assistant.message'
  run_id: string
  round_index: number
  content_text: string
}
export interface WsRunToolCalled extends WsEventBase {
  type: 'run.tool.called'
  run_id: string
  round_index: number
  tool_call: ToolCallPayload
}
export interface WsRunToolResult extends WsEventBase {
  type: 'run.tool.result'
  run_id: string
  round_index: number
  tool_call_id: string
  tool_name: string
  tool_result: unknown
}
export interface WsRunTurnCompleted extends WsEventBase {
  type: 'run.turn.completed'
  run_id: string
  turn_id: string
  round_index: number
  phase: string
}
export interface WsRunMessageCompleted extends WsEventBase {
  type: 'run.message.completed'
  run_id: string
  message: Message
}
export interface WsRunCompleted extends WsEventBase {
  type: 'run.completed'
  run_id: string
  response_message_id: string
}
export interface WsRunFailed extends WsEventBase {
  type: 'run.failed'
  run_id: string
  error: string
}
export interface WsRunBlocked extends WsEventBase {
  type: 'run.blocked'
  run_id: string
  error?: string
}
export interface WsRunCancelled extends WsEventBase {
  type: 'run.cancelled'
  run_id: string
  reason?: string
}
export interface WsRunStalled extends WsEventBase {
  type: 'run.stalled'
  run_id: string
  reason?: string
  timeout_seconds?: number
}
export interface WsTaskCreated extends WsEventBase {
  type: 'task.created'
  run_id: string
  task: Task
}
export interface WsTaskApprovalRequested extends WsEventBase {
  type: 'task.approval.requested'
  run_id: string
  task_id: string
  approval: TaskApproval
}
export interface WsTaskApprovalResolved extends WsEventBase {
  type: 'task.approval.resolved'
  run_id: string
  task_id: string
  approval: TaskApproval
}
export interface WsTaskArtifactRegistered extends WsEventBase {
  type: 'task.artifact.registered'
  run_id: string
  task_id: string
  artifact: TaskArtifact
}
export interface WsTaskStatusUpdated extends WsEventBase {
  type: 'task.status.updated'
  run_id: string
  task_id: string
  task: Task
}
export interface WorkerTodoItemPayload {
  id: string
  status: string
  text: string
  position?: number
  evidence?: unknown
  reason?: string
  recommended_action?: string
}
export interface WorkerTodoProgressPayload {
  pending?: number
  in_progress?: number
  completed?: number
  blocked?: number
  skipped?: number
  total?: number
}
export interface WorkerTodoUpdatePayload {
  ok?: boolean
  item?: WorkerTodoItemPayload
  next_item?: WorkerTodoItemPayload | null
  done?: boolean
  progress?: WorkerTodoProgressPayload
  error_type?: string
  message?: string
}
export interface WorkerResultPayload {
  status?: string
  summary?: string
  todo?: unknown
  changed_files?: unknown[]
  outputs?: unknown[]
  verification?: unknown[]
  blockers?: unknown[]
  handoff_to_socrates?: string
}
export interface WsTaskWorkerStarted extends WsEventBase {
  type: 'task.worker.started'
  run_id: string
  task_id: string
  worker_run_id: string | null
}
export interface WsTaskWorkerProgress extends WsEventBase {
  type: 'task.worker.progress'
  run_id: string
  task_id: string
  worker_run_id: string | null
  status?: string
  summary?: string | null
  todo?: unknown
}
export interface WsTaskWorkerToolCalled extends WsEventBase {
  type: 'task.worker.tool.called'
  run_id: string
  task_id: string
  worker_run_id: string | null
  round_index: number
  tool_call: ToolCallPayload
}
export interface WsTaskWorkerToolResult extends WsEventBase {
  type: 'task.worker.tool.result'
  run_id: string
  task_id: string
  worker_run_id: string | null
  round_index: number
  tool_call_id: string
  tool_name: string
  tool_result: unknown
}
export interface WsTaskWorkerTodoUpdated extends WsEventBase {
  type: 'task.worker.todo.updated'
  run_id: string
  task_id: string
  worker_run_id: string | null
  round_index: number
  tool_call_id: string
  todo: WorkerTodoUpdatePayload
}
export interface WsTaskWorkerWarning extends WsEventBase {
  type: 'task.worker.warning'
  run_id: string
  task_id: string
  worker_run_id: string | null
  round_index: number
  message: string
}
export interface WsTaskWorkerTerminal extends WsEventBase {
  type: 'task.worker.completed' | 'task.worker.blocked' | 'task.worker.failed' | 'task.worker.cancelled' | 'task.worker.stalled'
  run_id: string
  task_id: string
  worker_run_id: string | null
  result: WorkerResultPayload
}
export interface WsRunHeartbeat extends WsEventBase {
  type: 'run.heartbeat'
  run_id: string
  ts: string
}

export type WsEvent =
  | WsRunSnapshot
  | WsRunStarted
  | WsRunTurnStarted
  | WsRunThinkingDelta
  | WsRunContentDelta
  | WsRunAssistantMessage
  | WsRunToolCalled
  | WsRunToolResult
  | WsRunTurnCompleted
  | WsRunMessageCompleted
  | WsRunCompleted
  | WsRunFailed
  | WsRunBlocked
  | WsRunCancelled
  | WsRunStalled
  | WsTaskCreated
  | WsTaskApprovalRequested
  | WsTaskApprovalResolved
  | WsTaskArtifactRegistered
  | WsTaskStatusUpdated
  | WsTaskWorkerStarted
  | WsTaskWorkerProgress
  | WsTaskWorkerToolCalled
  | WsTaskWorkerToolResult
  | WsTaskWorkerTodoUpdated
  | WsTaskWorkerWarning
  | WsTaskWorkerTerminal
  | WsRunHeartbeat
