import type {
  ToolCallPayload,
  WorkerTodoItemPayload,
  WorkerTodoProgressPayload,
  WorkerTodoUpdatePayload,
  WsEvent,
} from '@/types/api'

export type WorkerTraceStatus = 'idle' | 'running' | 'completed' | 'blocked' | 'failed' | 'cancelled' | 'stalled'
export type WorkerToolStatus = 'running' | 'completed' | 'failed'

export interface WorkerTraceToolRow {
  toolCallId: string
  toolName: string
  label: string
  status: WorkerToolStatus
  roundIndex: number
  arguments: Record<string, unknown> | null
  resultSummary: string | null
  rawResult: unknown
  seq: number
}

export interface WorkerTraceRun {
  workerRunId: string
  parentRunId: string
  taskId: string
  status: WorkerTraceStatus
  summary: string | null
  currentItem: WorkerTodoItemPayload | null
  nextItem: WorkerTodoItemPayload | null
  progress: WorkerTodoProgressPayload | null
  tools: WorkerTraceToolRow[]
  warnings: string[]
  result: Record<string, unknown> | null
  lastSeq: number
}

export interface WorkerTraceState {
  runs: Record<string, WorkerTraceRun>
  activeWorkerRunId: string | null
  dismissedWorkerRunIds: Set<string>
}

const WORKER_EVENT_TYPES = new Set([
  'task.worker.started',
  'task.worker.progress',
  'task.worker.tool.called',
  'task.worker.tool.result',
  'task.worker.todo.updated',
  'task.worker.warning',
  'task.worker.completed',
  'task.worker.blocked',
  'task.worker.failed',
  'task.worker.cancelled',
  'task.worker.stalled',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function fallbackWorkerRunId(event: Extract<WsEvent, { run_id: string }>) {
  return `worker:${event.run_id}`
}

function workerRunIdFromEvent(event: Extract<WsEvent, { run_id: string }>) {
  if ('worker_run_id' in event && typeof event.worker_run_id === 'string' && event.worker_run_id.trim()) {
    return event.worker_run_id
  }
  return fallbackWorkerRunId(event)
}

export function createWorkerTraceState(): WorkerTraceState {
  return {
    runs: {},
    activeWorkerRunId: null,
    dismissedWorkerRunIds: new Set<string>(),
  }
}

export function isWorkerTraceEvent(event: WsEvent): event is Extract<WsEvent, { type: `task.worker.${string}` }> {
  return WORKER_EVENT_TYPES.has(event.type)
}

function createWorkerRunFromEvent(event: Extract<WsEvent, { run_id: string }>): WorkerTraceRun {
  const workerRunId = workerRunIdFromEvent(event)
  return {
    workerRunId,
    parentRunId: event.run_id,
    taskId: 'task_id' in event ? event.task_id : '',
    status: 'idle',
    summary: null,
    currentItem: null,
    nextItem: null,
    progress: null,
    tools: [],
    warnings: [],
    result: null,
    lastSeq: 0,
  }
}

function humanizeWorkerToolLabel(toolCall: ToolCallPayload) {
  const args = toolCall.arguments
  const path = getString(args.path)
  const status = getString(args.status)
  const todoId = getString(args.todo_id)
  const argv = Array.isArray(args.argv) ? args.argv.filter((item): item is string => typeof item === 'string') : []

  switch (toolCall.name) {
    case 'update_current_todo_item':
      return status ? `Todo ${status.replaceAll('_', ' ')}` : 'Update current todo'
    case 'skip_todo_item':
      return todoId ? `Skip ${todoId}` : 'Skip todo item'
    case 'write_file':
      return path ? `Write ${path}` : 'Write file'
    case 'edit_file':
      return path ? `Edit ${path}` : 'Edit file'
    case 'apply_patch':
      return 'Apply patch'
    case 'read_file':
      return path ? `Read ${path}` : 'Read file'
    case 'execute_command':
      return argv.length > 0 ? `Run ${argv.join(' ')}` : 'Run command'
    default:
      return toolCall.name.replaceAll('_', ' ')
  }
}

function summarizeWorkerToolResult(toolName: string, rawResult: unknown) {
  if (!isRecord(rawResult)) {
    return getString(rawResult)
  }
  if (rawResult.ok === false) {
    return getString(rawResult.message) ?? getString(rawResult.error_type) ?? 'Tool failed'
  }
  if (toolName === 'update_current_todo_item' || toolName === 'skip_todo_item') {
    const item = isRecord(rawResult.item) ? rawResult.item : null
    const status = getString(item?.status)
    const id = getString(item?.id)
    if (id && status) return `${id} marked ${status.replaceAll('_', ' ')}`
    return 'Todo updated'
  }
  const path = getString(rawResult.path)
  if (path) return `${toolName.replaceAll('_', ' ')} ${path}`
  return getString(rawResult.summary) ?? 'Completed'
}

function upsertTool(tools: WorkerTraceToolRow[], nextTool: WorkerTraceToolRow) {
  const existingIndex = tools.findIndex((tool) => tool.toolCallId === nextTool.toolCallId)
  if (existingIndex === -1) {
    return [...tools, nextTool].sort((left, right) => left.seq - right.seq)
  }
  const existing = tools[existingIndex]
  const merged: WorkerTraceToolRow = {
    ...existing,
    ...nextTool,
    seq: existing.seq,
    label: nextTool.arguments ? nextTool.label : existing.label,
    arguments: nextTool.arguments ?? existing.arguments,
    resultSummary: nextTool.resultSummary ?? existing.resultSummary,
    rawResult: nextTool.rawResult ?? existing.rawResult,
  }
  const updated = tools.slice()
  updated[existingIndex] = merged
  return updated
}

function statusFromTerminalType(type: string): WorkerTraceStatus {
  if (type === 'task.worker.completed') return 'completed'
  if (type === 'task.worker.blocked') return 'blocked'
  if (type === 'task.worker.cancelled') return 'cancelled'
  if (type === 'task.worker.stalled') return 'stalled'
  return 'failed'
}

function visibleCurrentItemFromTodo(todo: WorkerTodoUpdatePayload) {
  if (todo.done) return null
  if (todo.item?.status === 'in_progress' || todo.item?.status === 'blocked') return todo.item
  return todo.next_item ?? null
}

export function applyWorkerTraceEvent(current: WorkerTraceState | undefined, event: WsEvent): WorkerTraceState {
  const state = current ?? createWorkerTraceState()
  if (!isWorkerTraceEvent(event)) {
    return state
  }

  const workerRunId = workerRunIdFromEvent(event)
  const previousRun = state.runs[workerRunId] ?? createWorkerRunFromEvent(event)
  const seq = typeof event.seq === 'number' ? event.seq : previousRun.lastSeq + 1
  if (seq <= previousRun.lastSeq && event.seq !== undefined) {
    return state
  }

  let run: WorkerTraceRun = { ...previousRun, lastSeq: Math.max(previousRun.lastSeq, seq) }

  if (event.type === 'task.worker.started') {
    run = { ...run, status: 'running', summary: 'Worker started.' }
  } else if (event.type === 'task.worker.progress') {
    run = {
      ...run,
      status: event.status === 'completed' || event.status === 'blocked' || event.status === 'failed' || event.status === 'cancelled' || event.status === 'stalled'
        ? event.status
        : run.status === 'idle'
          ? 'running'
          : run.status,
      summary: event.summary ?? run.summary,
      progress: isRecord(event.todo) && isRecord(event.todo.progress) ? event.todo.progress : run.progress,
    }
  } else if (event.type === 'task.worker.tool.called') {
    run = {
      ...run,
      status: run.status === 'idle' ? 'running' : run.status,
      tools: upsertTool(run.tools, {
        toolCallId: event.tool_call.id,
        toolName: event.tool_call.name,
        label: humanizeWorkerToolLabel(event.tool_call),
        status: 'running',
        roundIndex: event.round_index,
        arguments: event.tool_call.arguments,
        resultSummary: null,
        rawResult: null,
        seq,
      }),
    }
  } else if (event.type === 'task.worker.tool.result') {
    const failed = isRecord(event.tool_result) && event.tool_result.ok === false
    run = {
      ...run,
      tools: upsertTool(run.tools, {
        toolCallId: event.tool_call_id,
        toolName: event.tool_name,
        label: event.tool_name.replaceAll('_', ' '),
        status: failed ? 'failed' : 'completed',
        roundIndex: event.round_index,
        arguments: null,
        resultSummary: summarizeWorkerToolResult(event.tool_name, event.tool_result),
        rawResult: event.tool_result,
        seq,
      }),
    }
  } else if (event.type === 'task.worker.todo.updated') {
    run = {
      ...run,
      currentItem: visibleCurrentItemFromTodo(event.todo),
      nextItem: event.todo.next_item ?? null,
      progress: event.todo.progress ?? run.progress,
    }
  } else if (event.type === 'task.worker.warning') {
    run = { ...run, warnings: [...run.warnings, event.message] }
  } else {
    run = {
      ...run,
      status: statusFromTerminalType(event.type),
      summary: event.result.summary ?? event.result.handoff_to_socrates ?? run.summary,
      result: event.result as Record<string, unknown>,
      currentItem: null,
    }
  }

  const dismissedWorkerRunIds = new Set(state.dismissedWorkerRunIds)
  const shouldActivate = run.status === 'running' || !dismissedWorkerRunIds.has(workerRunId)
  return {
    ...state,
    runs: { ...state.runs, [workerRunId]: run },
    activeWorkerRunId: shouldActivate ? workerRunId : state.activeWorkerRunId,
  }
}

export function dismissWorkerTrace(current: WorkerTraceState, workerRunId: string): WorkerTraceState {
  const dismissedWorkerRunIds = new Set(current.dismissedWorkerRunIds)
  dismissedWorkerRunIds.add(workerRunId)
  return {
    ...current,
    activeWorkerRunId: current.activeWorkerRunId === workerRunId ? null : current.activeWorkerRunId,
    dismissedWorkerRunIds,
  }
}

export function isTerminalWorkerTraceStatus(status: WorkerTraceStatus | null | undefined) {
  return status === 'completed' || status === 'blocked' || status === 'failed' || status === 'cancelled' || status === 'stalled'
}

export function isTerminalWorkerTraceRun(run: WorkerTraceRun | null | undefined) {
  return isTerminalWorkerTraceStatus(run?.status)
}

export function getActiveWorkerTraceRun(state: WorkerTraceState): WorkerTraceRun | null {
  if (!state.activeWorkerRunId) return null
  return state.runs[state.activeWorkerRunId] ?? null
}

export function getWorkerTraceSummary(run: WorkerTraceRun) {
  if (run.currentItem) {
    return `${run.currentItem.id}: ${run.currentItem.text}`
  }
  if (run.summary) {
    return run.summary
  }
  const latestTool = run.tools[run.tools.length - 1]
  if (latestTool) {
    return latestTool.resultSummary ?? latestTool.label
  }
  return run.status === 'running' ? 'Worker is starting.' : 'Worker trace captured.'
}

export function getWorkerProgressLabel(progress: WorkerTodoProgressPayload | null) {
  if (!progress) return null
  const completed = typeof progress.completed === 'number' ? progress.completed : 0
  const skipped = typeof progress.skipped === 'number' ? progress.skipped : 0
  const total = typeof progress.total === 'number'
    ? progress.total
    : Object.values(progress).reduce((sum, value) => sum + (typeof value === 'number' ? value : 0), 0)
  if (!total) return null
  return `${completed + skipped}/${total} resolved`
}
