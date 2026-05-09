import {
  applyRunActivityEvent,
  createRunActivityState,
  type RunActivityState,
} from './runActivity'
import type { AgentRun, AgentRunStatus, Message, WsEvent } from '@/types/api'

export type AssistantTurnConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface AssistantTurnState {
  runId: string
  conversationId: string
  triggerMessageId: string | null
  responseMessageId: string | null
  status: AgentRunStatus
  connectionState: AssistantTurnConnectionState
  lastSeq: number
  partialContent: string
  partialThinking: string
  persistedMessage: Message | null
  error: string | null
  thinkingEnabled: boolean
  activity: RunActivityState
  activityHydrating: boolean
  activityAvailable: boolean | null
}

type AssistantTurnEvent =
  | Extract<WsEvent, { run_id: string }>
  | Extract<WsEvent, { type: 'run.snapshot' }>

function syncTerminalActivity(state: RunActivityState, status: AgentRunStatus) {
  if (status === 'completed') {
    return { ...state, terminal: true }
  }
  if (status === 'failed' || status === 'blocked') {
    return { ...state, terminal: true, failed: true }
  }
  if (status === 'cancelled' || status === 'stalled') {
    return { ...state, terminal: true }
  }
  return state
}

export function createAssistantTurn(params: {
  runId: string
  conversationId: string
  triggerMessageId?: string | null
  responseMessageId?: string | null
  status?: AgentRunStatus
  thinkingEnabled?: boolean
}): AssistantTurnState {
  const status = params.status ?? 'queued'
  return {
    runId: params.runId,
    conversationId: params.conversationId,
    triggerMessageId: params.triggerMessageId ?? null,
    responseMessageId: params.responseMessageId ?? null,
    status,
    connectionState: 'idle',
    lastSeq: 0,
    partialContent: '',
    partialThinking: '',
    persistedMessage: null,
    error: null,
    thinkingEnabled: Boolean(params.thinkingEnabled),
    activity: syncTerminalActivity(createRunActivityState(params.runId), status),
    activityHydrating: false,
    activityAvailable: null,
  }
}

export function hydrateAssistantTurnFromRun(
  run: AgentRun,
  current?: AssistantTurnState,
): AssistantTurnState {
  const next = current ?? createAssistantTurn({
    runId: run.id,
    conversationId: run.conversation_id,
    triggerMessageId: run.trigger_message_id,
    responseMessageId: run.response_message_id,
    status: run.status,
    thinkingEnabled: run.request_json?.thinking_level !== 'off',
  })

  return {
    ...next,
    conversationId: run.conversation_id,
    triggerMessageId: run.trigger_message_id,
    responseMessageId: run.response_message_id,
    status: run.status,
    error: run.error_message,
    thinkingEnabled: run.request_json?.thinking_level !== 'off',
    activity: syncTerminalActivity(next.activity, run.status),
    activityAvailable: next.activityAvailable,
  }
}

export function attachPersistedAssistantMessage(
  current: AssistantTurnState | undefined,
  message: Message,
): AssistantTurnState {
  const next =
    current ??
    createAssistantTurn({
      runId: message.agent_run_id ?? message.id,
      conversationId: message.conversation_id,
      responseMessageId: message.id,
      status: 'completed',
      thinkingEnabled: Boolean(message.thinking_text?.trim()),
    })

  return {
    ...next,
    responseMessageId: message.id,
    status: 'completed',
    persistedMessage: message,
    partialContent: message.content_text?.trim() ? '' : next.partialContent,
    partialThinking: message.thinking_text?.trim() ? '' : next.partialThinking,
    error: null,
    activity: { ...next.activity, terminal: true, failed: false },
    activityAvailable: next.activityAvailable,
  }
}

export function setAssistantTurnConnectionState(
  current: AssistantTurnState | undefined,
  params: {
    runId: string
    conversationId: string
    connectionState: AssistantTurnConnectionState
  },
): AssistantTurnState {
  const next =
    current ??
    createAssistantTurn({
      runId: params.runId,
      conversationId: params.conversationId,
    })

  return {
    ...next,
    connectionState: params.connectionState,
  }
}

function updateSeq(current: AssistantTurnState, event: { seq?: number }) {
  return typeof event.seq === 'number' && event.seq > current.lastSeq ? event.seq : current.lastSeq
}

export function applyAssistantTurnEvent(
  current: AssistantTurnState | undefined,
  event: AssistantTurnEvent,
  conversationId?: string,
): AssistantTurnState {
  const runId = event.run_id
  const next =
    current ??
    createAssistantTurn({
      runId,
      conversationId: conversationId ?? ('conversation_id' in event ? event.conversation_id : ''),
    })

  if (event.type === 'run.heartbeat') {
    return next
  }

  if (event.type === 'run.snapshot') {
    return {
      ...next,
      conversationId: event.conversation_id,
      status: event.status,
      responseMessageId: event.response_message_id,
      error: event.error,
      lastSeq: Math.max(next.lastSeq, event.last_seq),
      activity: syncTerminalActivity(next.activity, event.status),
      activityAvailable: next.activityAvailable,
    }
  }

  let updated: AssistantTurnState = {
    ...next,
    lastSeq: updateSeq(next, event),
  }

  if (event.type === 'run.started') {
    updated = { ...updated, conversationId: event.conversation_id, status: 'running' }
  } else if (event.type === 'run.thinking.delta') {
    updated = {
      ...updated,
      status: 'running',
      partialThinking: `${updated.partialThinking}${event.delta}`,
    }
  } else if (event.type === 'run.content.delta') {
    updated = {
      ...updated,
      status: 'running',
      partialContent: `${updated.partialContent}${event.delta}`,
    }
  } else if (event.type === 'run.message.completed') {
    updated = attachPersistedAssistantMessage(updated, event.message)
    updated.lastSeq = updateSeq(updated, event)
  } else if (event.type === 'run.completed') {
    updated = {
      ...updated,
      status: 'completed',
      responseMessageId: event.response_message_id,
      error: null,
      activity: syncTerminalActivity(updated.activity, 'completed'),
    }
  } else if (event.type === 'run.failed') {
    updated = {
      ...updated,
      status: 'failed',
      error: event.error,
      activity: syncTerminalActivity(
        applyRunActivityEvent(updated.activity, event),
        'failed',
      ),
    }
    return updated
  } else if (event.type === 'run.blocked') {
    updated = {
      ...updated,
      status: 'blocked',
      error: event.error ?? 'Run blocked.',
      activity: syncTerminalActivity(
        applyRunActivityEvent(updated.activity, event),
        'blocked',
      ),
    }
    return updated
  } else if (event.type === 'run.cancelled') {
    updated = {
      ...updated,
      status: 'cancelled',
      error: null,
      activity: syncTerminalActivity(
        applyRunActivityEvent(updated.activity, event),
        'cancelled',
      ),
    }
    return updated
  } else if (event.type === 'run.stalled') {
    updated = {
      ...updated,
      status: 'stalled',
      error: 'Run stalled with no progress.',
      activity: syncTerminalActivity(
        applyRunActivityEvent(updated.activity, event),
        'stalled',
      ),
    }
    return updated
  }

  if (
    event.type === 'run.assistant.message' ||
    event.type === 'run.tool.called' ||
    event.type === 'run.tool.result' ||
    event.type === 'run.completed' ||
    event.type === 'task.worker.started' ||
    event.type === 'task.worker.todo.updated' ||
    event.type === 'task.worker.completed' ||
    event.type === 'task.worker.blocked' ||
    event.type === 'task.worker.failed' ||
    event.type === 'task.worker.cancelled' ||
    event.type === 'task.worker.stalled'
  ) {
    updated = {
      ...updated,
      activity: applyRunActivityEvent(updated.activity, event),
      activityAvailable:
        event.type === 'run.completed' ? updated.activityAvailable : true,
    }
  }

  return updated
}

export function setAssistantTurnActivityHydrating(
  current: AssistantTurnState | undefined,
  params: {
    runId: string
    conversationId: string
    hydrating: boolean
  },
): AssistantTurnState {
  const next =
    current ??
    createAssistantTurn({
      runId: params.runId,
      conversationId: params.conversationId,
    })

  return {
    ...next,
    activityHydrating: params.hydrating,
  }
}

export function replaceAssistantTurnActivity(
  current: AssistantTurnState | undefined,
  params: {
    runId: string
    conversationId: string
    activity: RunActivityState
  },
): AssistantTurnState {
  const next =
    current ??
    createAssistantTurn({
      runId: params.runId,
      conversationId: params.conversationId,
    })

  return {
    ...next,
    activity: params.activity,
    activityHydrating: false,
    activityAvailable: params.activity.items.length > 0,
  }
}

export function shouldShowAssistantTurnFailure(state: AssistantTurnState) {
  if (state.persistedMessage) {
    return false
  }
  if (state.status !== 'failed') {
    return false
  }
  return state.partialContent.trim().length === 0
}

export function shouldShowAssistantTurnActivity(state: AssistantTurnState) {
  if (state.status === 'queued' || state.status === 'running') {
    return true
  }
  if (state.activityHydrating) {
    return true
  }
  if (state.activity.items.length > 0) {
    return true
  }
  return state.status === 'completed' && state.activityAvailable !== false
}
