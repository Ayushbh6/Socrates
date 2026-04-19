// Shared TypeScript types mirroring CONTRACTS.md

export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export type InputMode = 'text' | 'voice'
export type MessageRole = 'user' | 'assistant'
export type MessageStatus = 'queued' | 'completed' | 'failed'
export type AgentRunStatus = 'queued' | 'running' | 'completed' | 'failed'

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
  venv_path: string
  result_summary: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
  failed_at: string | null
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
}

// ── WebSocket event union ──────────────────────────────────────────────────────

export interface WsRunStarted {
  type: 'run.started'
  run_id: string
  conversation_id: string
}
export interface WsRunTurnStarted {
  type: 'run.turn.started'
  run_id: string
  turn_id: string
  round_index: number
}
export interface WsRunThinkingDelta {
  type: 'run.thinking.delta'
  run_id: string
  round_index: number
  delta: string
}
export interface WsRunContentDelta {
  type: 'run.content.delta'
  run_id: string
  round_index: number
  delta: string
}
export interface WsRunTurnCompleted {
  type: 'run.turn.completed'
  run_id: string
  turn_id: string
  round_index: number
  phase: string
}
export interface WsRunMessageCompleted {
  type: 'run.message.completed'
  run_id: string
  message: Message
}
export interface WsRunCompleted {
  type: 'run.completed'
  run_id: string
  response_message_id: string
}
export interface WsRunFailed {
  type: 'run.failed'
  run_id: string
  error: string
}
export interface WsTaskCreated {
  type: 'task.created'
  run_id: string
  task: Task
}
export interface WsTaskApprovalRequested {
  type: 'task.approval.requested'
  run_id: string
  task_id: string
  approval: TaskApproval
}
export interface WsTaskApprovalResolved {
  type: 'task.approval.resolved'
  run_id: string
  task_id: string
  approval: TaskApproval
}
export interface WsTaskArtifactRegistered {
  type: 'task.artifact.registered'
  run_id: string
  task_id: string
  artifact: TaskArtifact
}

export type WsEvent =
  | WsRunStarted
  | WsRunTurnStarted
  | WsRunThinkingDelta
  | WsRunContentDelta
  | WsRunTurnCompleted
  | WsRunMessageCompleted
  | WsRunCompleted
  | WsRunFailed
  | WsTaskCreated
  | WsTaskApprovalRequested
  | WsTaskApprovalResolved
  | WsTaskArtifactRegistered
