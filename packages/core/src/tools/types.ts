import type {
  BashToolInput,
  BashToolOutput,
  EditToolInput,
  EditToolOutput,
  ListProjectResourcesToolInput,
  ListProjectResourcesToolOutput,
  ModelToolDefinition,
  ReadToolInput,
  ReadToolOutput,
  RuntimeConfig,
  SearchToolInput,
  SearchToolOutput,
  ToolName,
  ToolPermission,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
} from "@socrates/contracts"
import type { SocratesError } from "@socrates/shared"

export type ToolExecutorContext = {
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  toolCallId?: string
  workspacePath: string
  runtimeConfig: RuntimeConfig
  abortSignal?: AbortSignal
  onOutput?: (output: { stream: "stdout" | "stderr" | "log" | "result"; text?: string; data?: unknown }) => void
}

export type ToolExecutors = {
  read: (input: ReadToolInput, context: ToolExecutorContext) => Promise<ReadToolOutput>
  search: (input: SearchToolInput, context: ToolExecutorContext) => Promise<SearchToolOutput>
  edit: (input: EditToolInput, context: ToolExecutorContext) => Promise<EditToolOutput>
  bash: (input: BashToolInput, context: ToolExecutorContext) => Promise<BashToolOutput>
  trace_retrieve: (input: TraceRetrieveToolInput, context: ToolExecutorContext) => Promise<TraceRetrieveToolOutput>
  list_project_resources: (
    input: ListProjectResourcesToolInput,
    context: ToolExecutorContext,
  ) => Promise<ListProjectResourcesToolOutput>
}

export type ApprovalRequest = {
  approvalId: string
  toolCallId: string
  toolName: ToolName
  actionKind: "shell_command" | "file_write" | "patch_apply" | "git_commit" | "git_push" | "other"
  title: string
  description?: string
  actionPreview: string
  risk: "low" | "medium" | "high"
}

export type ApprovalDecision = {
  decision: "approved" | "rejected"
  reason?: string
}

export type ToolRuntimeContext = Omit<ToolExecutorContext, "onOutput"> & {
  executors: ToolExecutors
  requestApproval: (request: ApprovalRequest) => Promise<ApprovalDecision>
}

export type ToolPolicyDecision =
  | { type: "auto" }
  | { type: "approval_required"; request: Omit<ApprovalRequest, "approvalId" | "toolCallId" | "toolName"> }
  | { type: "denied"; reason: string }

export type SocratesTool<TInput, TOutput> = ModelToolDefinition & {
  name: ToolName
  resultSchema: NonNullable<ModelToolDefinition["resultSchema"]>
  permission: ToolPermission
  executeLane: "parallel" | "mutation"
  category: "file" | "search" | "shell" | "patch" | "trace" | "other"
  resultPreview: (output: TOutput) => string
  summary: (output: TOutput) => string
  metrics?: (output: TOutput) => {
    filesRead?: number
    filesEdited?: number
    commandsRun?: number
    searchesRun?: number
  }
  decidePolicy: (input: TInput, context: ToolRuntimeContext) => ToolPolicyDecision
  execute: (
    input: TInput,
    context: ToolRuntimeContext & {
      onOutput: NonNullable<ToolExecutorContext["onOutput"]>
    },
  ) => Promise<TOutput>
}

export type ToolLifecycleEvent =
  | {
      type: "tool.call.started"
      toolCallId: string
      toolName: ToolName
      category: SocratesTool<unknown, unknown>["category"]
      displayName: string
      argsPreview?: string
      input?: unknown
      requiresApproval: boolean
    }
  | {
      type: "tool.call.output"
      toolCallId: string
      stream: "stdout" | "stderr" | "log" | "result"
      text?: string
      data?: unknown
    }
  | {
      type: "tool.call.completed"
      toolCallId: string
      toolName: ToolName
      output: unknown
      summary: string
      resultPreview?: string
      metrics?: {
        filesRead?: number
        filesEdited?: number
        commandsRun?: number
        searchesRun?: number
      }
      durationMs?: number
    }
  | { type: "tool.call.failed"; toolCallId: string; toolName: ToolName; error: SocratesError }
  | { type: "approval.requested"; request: ApprovalRequest }
  | { type: "approval.resolved"; approvalId: string; toolCallId: string; decision: "approved" | "rejected" }
