import type {
  AgentRunEvent,
  WsEvent,
  WsRunAssistantMessage,
  WsRunFailed,
  WsRunToolCalled,
  WsRunToolResult,
  WsTaskWorkerStarted,
  WsTaskWorkerTerminal,
  WsTaskWorkerTodoUpdated,
} from '@/types/api'
import { getWorkerProgressLabel, getWorkerTraceSummary, applyWorkerTraceEvent, createWorkerTraceState } from './workerTrace'

export type RunActivityStatus = 'running' | 'completed' | 'failed'

export interface RunActivityNarrationItem {
  kind: 'narration'
  seq: number
  roundIndex: number
  text: string
}

export interface RunActivityToolItem {
  kind: 'tool'
  seq: number
  roundIndex: number
  toolCallId: string
  toolName: string
  label: string
  status: RunActivityStatus
  arguments: Record<string, unknown> | null
  resultSummary: string | null
  rawResult: unknown
}

export interface RunActivityWorkerItem {
  kind: 'worker'
  seq: number
  workerRunId: string
  status: 'running' | 'completed' | 'blocked' | 'failed'
  summary: string
  progressLabel: string | null
}

export type RunActivityItem = RunActivityNarrationItem | RunActivityToolItem | RunActivityWorkerItem

export interface RunActivityState {
  runId: string
  items: RunActivityItem[]
  // Set-backed dedupe table: membership checks and inserts are O(1), which
  // matters for long-running conversations where `seenSeqs` could otherwise
  // grow into the hundreds/thousands and turn every reducer invocation into
  // an O(n) array scan. The state object stays treated as immutable by always
  // creating a fresh Set on mutation.
  seenSeqs: Set<number>
  hydrated: boolean
  terminal: boolean
  failed: boolean
}

type ActivityEvent =
  | WsRunAssistantMessage
  | WsRunToolCalled
  | WsRunToolResult
  | WsRunFailed
  | Extract<WsEvent, { type: 'run.completed' }>
  | WsTaskWorkerStarted
  | WsTaskWorkerTodoUpdated
  | WsTaskWorkerTerminal

interface ParsedToolPayload {
  ok: boolean
  tool_name?: string
  data?: unknown
  error_type?: string
  message?: string
  retryable?: boolean
  suggestion?: string
}

const ACTIVITY_EVENT_TYPES = new Set([
  'run.assistant.message',
  'run.tool.called',
  'run.tool.result',
  'run.completed',
  'run.failed',
  'task.worker.started',
  'task.worker.todo.updated',
  'task.worker.completed',
  'task.worker.blocked',
  'task.worker.failed',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getEventSeq(event: ActivityEvent): number | null {
  return typeof event.seq === 'number' ? event.seq : null
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

export function createRunActivityState(runId: string): RunActivityState {
  return {
    runId,
    items: [],
    seenSeqs: new Set<number>(),
    hydrated: false,
    terminal: false,
    failed: false,
  }
}

export function parseToolResultPayload(raw: unknown): ParsedToolPayload | null {
  const candidate = typeof raw === 'string' ? safeJsonParse(raw) : raw
  if (!isRecord(candidate) || typeof candidate.ok !== 'boolean') {
    return null
  }

  return {
    ok: candidate.ok,
    tool_name: getString(candidate.tool_name) ?? undefined,
    data: candidate.data,
    error_type: getString(candidate.error_type) ?? undefined,
    message: getString(candidate.message) ?? undefined,
    retryable: typeof candidate.retryable === 'boolean' ? candidate.retryable : undefined,
    suggestion: getString(candidate.suggestion) ?? undefined,
  }
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function summarizeReadFileResult(data: unknown): string | null {
  if (!isRecord(data)) return null
  if (data.type === 'image_url') return 'Opened image preview'

  const path = getString(data.path) ?? getString(data.filename)
  const content = getString(data.content)
  const length = typeof data.length === 'number' ? data.length : content?.length ?? null

  if (path && length !== null) {
    return `Read ${path} (${length} chars)`
  }
  if (path) {
    return `Read ${path}`
  }
  if (length !== null) {
    return `Loaded ${length} chars`
  }
  return null
}

function summarizeListFilesResult(data: unknown): string | null {
  if (!isRecord(data) || !Array.isArray(data.entries)) return null
  return `Listed ${data.entries.length} item${data.entries.length === 1 ? '' : 's'}`
}

function summarizeSearchFilesResult(data: unknown): string | null {
  if (!isRecord(data)) return null
  if (typeof data.match_count === 'number') {
    return `Found ${data.match_count} match${data.match_count === 1 ? '' : 'es'}`
  }
  return null
}

function summarizeEditFileResult(data: unknown): string | null {
  if (!isRecord(data)) return null
  const path = getString(data.path)
  const operation = getString(data.operation)
  if (operation && path) {
    return `${operation.replaceAll('_', ' ')} on ${path}`
  }
  if (path) return `Updated ${path}`
  if (operation) return operation.replaceAll('_', ' ')
  return null
}

function summarizeExecuteCommandResult(data: unknown): string | null {
  if (!isRecord(data)) return null
  const exitCode = typeof data.exit_code === 'number' ? data.exit_code : null
  const argv = Array.isArray(data.argv) ? data.argv.filter((item): item is string => typeof item === 'string') : []
  if (argv.length > 0 && exitCode !== null) {
    return `${argv.join(' ')} exited ${exitCode}`
  }
  if (argv.length > 0) {
    return argv.join(' ')
  }
  if (exitCode !== null) {
    return `Command exited ${exitCode}`
  }
  return null
}

function summarizeCreateTaskResult(data: unknown): string | null {
  if (!isRecord(data) || !isRecord(data.task)) return null
  const title = getString(data.task.title)
  return title ? `Created task "${title}"` : 'Created task'
}

function summarizeWriteProjectNoteResult(data: unknown): string | null {
  if (!isRecord(data)) return null
  const filename = getString(data.filename)
  if (filename) return `Wrote ${filename}`
  return 'Wrote project note'
}

export function summarizeToolResult(toolName: string, raw: unknown): string | null {
  const parsed = parseToolResultPayload(raw)
  if (!parsed) {
    return getString(raw)
  }
  if (!parsed.ok) {
    return parsed.message ?? parsed.error_type ?? 'Tool failed'
  }

  switch (toolName) {
    case 'read_file':
      return summarizeReadFileResult(parsed.data) ?? 'Read resource'
    case 'list_files':
      return summarizeListFilesResult(parsed.data) ?? 'Listed files'
    case 'search_files':
      return summarizeSearchFilesResult(parsed.data) ?? 'Searched files'
    case 'edit_file':
      return summarizeEditFileResult(parsed.data) ?? 'Edited file'
    case 'execute_command':
      return summarizeExecuteCommandResult(parsed.data) ?? 'Executed command'
    case 'create_task':
      return summarizeCreateTaskResult(parsed.data) ?? 'Created task'
    case 'write_project_note':
      return summarizeWriteProjectNoteResult(parsed.data) ?? 'Wrote project note'
    case 'get_system_time':
      return 'Fetched system time'
    default:
      return parsed.message ?? 'Completed'
  }
}

export function humanizeToolLabel(toolName: string, args: Record<string, unknown> | null): string {
  const path = getString(args?.path)
  const query = getString(args?.query)
  const operation = getString(args?.operation)
  const argv = Array.isArray(args?.argv) ? args.argv.filter((item): item is string => typeof item === 'string') : []

  switch (toolName) {
    case 'read_file':
      return path ? `Read ${path}` : 'Read resource'
    case 'search_files':
      return query ? `Searched resources for "${query}"` : 'Searched resources'
    case 'list_files':
      return path && path !== '.' ? `Listed files in ${path}` : 'Listed project files'
    case 'edit_file':
      if (path && operation) return `${operation.replaceAll('_', ' ')} ${path}`
      if (path) return `Edited ${path}`
      return 'Edited file'
    case 'execute_command':
      return argv.length > 0 ? `Ran ${argv.join(' ')}` : 'Ran command'
    case 'create_task':
      return 'Created task'
    case 'write_project_note':
      return 'Wrote project note'
    case 'get_system_time':
      return 'Checked system time'
    default:
      return toolName.replaceAll('_', ' ')
  }
}

function insertOrUpdateToolItem(
  items: RunActivityItem[],
  nextItem: RunActivityToolItem,
): RunActivityItem[] {
  const existingIndex = items.findIndex(
    (item) => item.kind === 'tool' && item.toolCallId === nextItem.toolCallId,
  )
  if (existingIndex === -1) {
    return [...items, nextItem].sort((left, right) => left.seq - right.seq)
  }

  const existing = items[existingIndex]
  if (existing.kind !== 'tool') {
    return items
  }

  const mergedArguments = nextItem.arguments ?? existing.arguments
  const merged: RunActivityToolItem = {
    ...existing,
    ...nextItem,
    seq: existing.seq,
    label: humanizeToolLabel(nextItem.toolName, mergedArguments),
    arguments: mergedArguments,
    resultSummary: nextItem.resultSummary ?? existing.resultSummary,
    rawResult: nextItem.rawResult ?? existing.rawResult,
  }
  const updated = items.slice()
  updated[existingIndex] = merged
  return updated
}

function insertOrUpdateWorkerItem(
  items: RunActivityItem[],
  nextItem: RunActivityWorkerItem,
): RunActivityItem[] {
  const existingIndex = items.findIndex(
    (item) => item.kind === 'worker' && item.workerRunId === nextItem.workerRunId,
  )
  if (existingIndex === -1) {
    return [...items, nextItem].sort((left, right) => left.seq - right.seq)
  }
  const existing = items[existingIndex]
  if (existing.kind !== 'worker') return items
  const updated = items.slice()
  updated[existingIndex] = { ...existing, ...nextItem, seq: existing.seq }
  return updated
}

function workerItemFromEvent(event: ActivityEvent, seq: number): RunActivityWorkerItem | null {
  if (!event.type.startsWith('task.worker.')) return null
  const state = applyWorkerTraceEvent(createWorkerTraceState(), event)
  const workerRun = state.activeWorkerRunId ? state.runs[state.activeWorkerRunId] : null
  if (!workerRun) return null
  return {
    kind: 'worker',
    seq,
    workerRunId: workerRun.workerRunId,
    status: workerRun.status === 'idle' ? 'running' : workerRun.status,
    summary: getWorkerTraceSummary(workerRun),
    progressLabel: getWorkerProgressLabel(workerRun.progress),
  }
}

export function applyRunActivityEvent(
  current: RunActivityState | undefined,
  event: ActivityEvent,
  options?: { hydrated?: boolean },
): RunActivityState {
  const next = current ?? createRunActivityState(event.run_id)
  const seq = getEventSeq(event)

  if (seq !== null && next.seenSeqs.has(seq)) {
    if (!next.hydrated && options?.hydrated) {
      return { ...next, hydrated: true }
    }
    return next
  }

  let items = next.items
  let terminal = next.terminal
  let failed = next.failed

  if (event.type === 'run.assistant.message') {
    const text = event.content_text.trim()
    if (text && seq !== null) {
      const narrationItem: RunActivityNarrationItem = {
        kind: 'narration',
        seq,
        roundIndex: event.round_index,
        text,
      }
      items = [...items, narrationItem].sort(
        (left, right) => left.seq - right.seq,
      )
    }
  } else if (event.type === 'run.tool.called') {
    const calledItem: RunActivityToolItem = {
      kind: 'tool',
      seq: seq ?? Number.MAX_SAFE_INTEGER,
      roundIndex: event.round_index,
      toolCallId: event.tool_call.id,
      toolName: event.tool_call.name,
      label: humanizeToolLabel(event.tool_call.name, event.tool_call.arguments),
      status: 'running',
      arguments: event.tool_call.arguments,
      resultSummary: null,
      rawResult: null,
    }
    items = insertOrUpdateToolItem(items, calledItem)
  } else if (event.type === 'run.tool.result') {
    const parsed = parseToolResultPayload(event.tool_result)
    const toolStatus: RunActivityStatus = parsed?.ok === false ? 'failed' : 'completed'
    const resultItem: RunActivityToolItem = {
      kind: 'tool',
      seq: seq ?? Number.MAX_SAFE_INTEGER,
      roundIndex: event.round_index,
      toolCallId: event.tool_call_id,
      toolName: event.tool_name,
      label: humanizeToolLabel(event.tool_name, null),
      status: toolStatus,
      arguments: null,
      resultSummary: summarizeToolResult(event.tool_name, event.tool_result),
      rawResult: event.tool_result,
    }
    items = insertOrUpdateToolItem(items, resultItem)
  } else if (event.type === 'run.completed') {
    terminal = true
  } else if (event.type === 'run.failed') {
    terminal = true
    failed = true
    items = items.map((item) => {
      if (item.kind !== 'tool' || item.status !== 'running') {
        return item
      }
      return {
        ...item,
        status: 'failed',
        resultSummary: item.resultSummary ?? event.error,
      }
    })
  } else if (event.type.startsWith('task.worker.')) {
    const workerItem = workerItemFromEvent(event, seq ?? Number.MAX_SAFE_INTEGER)
    if (workerItem) {
      items = insertOrUpdateWorkerItem(items, workerItem)
    }
  }

  let seenSeqs = next.seenSeqs
  if (seq !== null) {
    seenSeqs = new Set(next.seenSeqs)
    seenSeqs.add(seq)
  }

  return {
    runId: next.runId,
    items,
    seenSeqs,
    hydrated: options?.hydrated ?? next.hydrated,
    terminal,
    failed,
  }
}

export function hydrateRunActivity(
  runId: string,
  events: AgentRunEvent[],
  seed?: RunActivityState,
): RunActivityState {
  let state = seed ?? createRunActivityState(runId)
  for (const record of events) {
    const event = toActivityEvent(record)
    if (!event || event.run_id !== runId) {
      continue
    }
    state = applyRunActivityEvent(state, event)
  }
  return { ...state, hydrated: true }
}

export function toActivityEvent(record: AgentRunEvent): ActivityEvent | null {
  if (!ACTIVITY_EVENT_TYPES.has(record.event_type) || !isRecord(record.payload)) {
    return null
  }

  const type = getString(record.payload.type)
  const runId = getString(record.payload.run_id)
  if (!type || !runId || type !== record.event_type) {
    return null
  }

  if (type === 'run.assistant.message') {
    const contentText = getString(record.payload.content_text)
    const roundIndex = typeof record.payload.round_index === 'number' ? record.payload.round_index : 0
    if (!contentText) return null
    return { type, run_id: runId, round_index: roundIndex, content_text: contentText, seq: record.sequence_no }
  }

  if (type === 'run.tool.called') {
    const toolCall = isRecord(record.payload.tool_call) ? record.payload.tool_call : null
    const id = getString(toolCall?.id)
    const name = getString(toolCall?.name)
    const args = isRecord(toolCall?.arguments) ? toolCall.arguments : null
    const roundIndex = typeof record.payload.round_index === 'number' ? record.payload.round_index : 0
    if (!id || !name || !args) return null
    return {
      type,
      run_id: runId,
      round_index: roundIndex,
      tool_call: { id, name, arguments: args },
      seq: record.sequence_no,
    }
  }

  if (type === 'run.tool.result') {
    const toolCallId = getString(record.payload.tool_call_id)
    const toolName = getString(record.payload.tool_name)
    const roundIndex = typeof record.payload.round_index === 'number' ? record.payload.round_index : 0
    if (!toolCallId || !toolName) return null
    return {
      type,
      run_id: runId,
      round_index: roundIndex,
      tool_call_id: toolCallId,
      tool_name: toolName,
      tool_result: record.payload.tool_result,
      seq: record.sequence_no,
    }
  }

  if (type === 'run.completed') {
    const responseMessageId = getString(record.payload.response_message_id) ?? ''
    return { type, run_id: runId, response_message_id: responseMessageId, seq: record.sequence_no }
  }

  if (type === 'run.failed') {
    return {
      type,
      run_id: runId,
      error: getString(record.payload.error) ?? 'Run failed.',
      seq: record.sequence_no,
    }
  }

  if (type === 'task.worker.started') {
    const workerRunId = getString(record.payload.worker_run_id)
    const taskId = getString(record.payload.task_id)
    if (!workerRunId || !taskId) return null
    return { type, run_id: runId, task_id: taskId, worker_run_id: workerRunId, seq: record.sequence_no }
  }

  if (type === 'task.worker.todo.updated') {
    const workerRunId = getString(record.payload.worker_run_id)
    const taskId = getString(record.payload.task_id)
    const toolCallId = getString(record.payload.tool_call_id)
    const roundIndex = typeof record.payload.round_index === 'number' ? record.payload.round_index : 0
    const todo = isRecord(record.payload.todo) ? record.payload.todo : null
    if (!workerRunId || !taskId || !toolCallId || !todo) return null
    return { type, run_id: runId, task_id: taskId, worker_run_id: workerRunId, round_index: roundIndex, tool_call_id: toolCallId, todo, seq: record.sequence_no }
  }

  if (type === 'task.worker.completed' || type === 'task.worker.blocked' || type === 'task.worker.failed') {
    const workerRunId = getString(record.payload.worker_run_id)
    const taskId = getString(record.payload.task_id)
    const result = isRecord(record.payload.result) ? record.payload.result : {}
    if (!workerRunId || !taskId) return null
    return { type, run_id: runId, task_id: taskId, worker_run_id: workerRunId, result, seq: record.sequence_no }
  }

  return null
}

export function getRunActivitySummary(state: RunActivityState): string {
  if (state.items.length === 0) {
    return state.terminal ? 'No intermediate activity captured.' : 'Socrates is preparing the next step.'
  }

  const toolCount = state.items.filter((item) => item.kind === 'tool').length
  const narrationCount = state.items.filter((item) => item.kind === 'narration').length
  const workerCount = state.items.filter((item) => item.kind === 'worker').length
  const latest = state.items[state.items.length - 1]

  if (!state.terminal) {
    if (latest.kind === 'tool') return latest.label
    if (latest.kind === 'worker') return latest.summary
    return latest.text
  }

  const parts: string[] = []
  if (toolCount > 0) parts.push(`${toolCount} tool step${toolCount === 1 ? '' : 's'}`)
  if (workerCount > 0) parts.push(`${workerCount} worker handoff${workerCount === 1 ? '' : 's'}`)
  if (narrationCount > 0) parts.push(`${narrationCount} note${narrationCount === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
