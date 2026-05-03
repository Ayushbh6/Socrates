import { describe, expect, it } from 'vitest'

import {
  applyAssistantTurnEvent,
  attachPersistedAssistantMessage,
  createAssistantTurn,
  replaceAssistantTurnActivity,
  shouldShowAssistantTurnActivity,
  shouldShowAssistantTurnFailure,
} from './assistantTurns'
import type { Message, WsRunFailed, WsRunHeartbeat, WsRunMessageCompleted, WsRunSnapshot } from '@/types/api'

const assistantMessage: Message = {
  id: 'assistant-1',
  project_id: 'project-1',
  conversation_id: 'conversation-1',
  agent_run_id: 'run-1',
  task_id: null,
  execution_mode: 'chat',
  role: 'assistant',
  input_mode: 'text',
  content_text: 'Final persisted answer.',
  thinking_text: 'Reasoned through the question.',
  status: 'completed',
  sequence_no: 2,
  provider: 'openrouter',
  model: 'openrouter/qwen/qwen3.6-plus',
  created_at: '2026-04-20T10:00:02Z',
  updated_at: '2026-04-20T10:00:02Z',
  failed_at: null,
  metadata: {},
  assets: [],
}

describe('assistant turn helpers', () => {
  it('hydrates a turn from snapshot and persists the final message into the same turn', () => {
    let state = createAssistantTurn({
      runId: 'run-1',
      conversationId: 'conversation-1',
      triggerMessageId: 'user-1',
      status: 'queued',
      thinkingEnabled: true,
    })

    const snapshot: WsRunSnapshot = {
      type: 'run.snapshot',
      run_id: 'run-1',
      conversation_id: 'conversation-1',
      status: 'running',
      last_seq: 3,
      response_message_id: null,
      error: null,
    }
    state = applyAssistantTurnEvent(state, snapshot)
    state = applyAssistantTurnEvent(state, {
      type: 'run.content.delta',
      run_id: 'run-1',
      round_index: 0,
      seq: 4,
      delta: 'Partial answer.',
    })

    const completed: WsRunMessageCompleted = {
      type: 'run.message.completed',
      run_id: 'run-1',
      seq: 5,
      message: assistantMessage,
    }
    state = applyAssistantTurnEvent(state, completed)
    state = applyAssistantTurnEvent(state, {
      type: 'run.completed',
      run_id: 'run-1',
      response_message_id: assistantMessage.id,
      seq: 6,
    })

    expect(state.status).toBe('completed')
    expect(state.persistedMessage?.id).toBe('assistant-1')
    expect(state.partialContent).toBe('')
    expect(state.activity.terminal).toBe(true)
    expect(shouldShowAssistantTurnFailure(state)).toBe(false)
  })

  it('shows a failure placeholder only for true failed runs without persisted content', () => {
    let failedTurn = createAssistantTurn({
      runId: 'run-2',
      conversationId: 'conversation-1',
      status: 'running',
    })

    const failedEvent: WsRunFailed = {
      type: 'run.failed',
      run_id: 'run-2',
      seq: 2,
      error: 'Provider disconnected.',
    }
    failedTurn = applyAssistantTurnEvent(failedTurn, failedEvent)

    expect(failedTurn.status).toBe('failed')
    expect(shouldShowAssistantTurnFailure(failedTurn)).toBe(true)

    const persisted = attachPersistedAssistantMessage(failedTurn, {
      ...assistantMessage,
      id: 'assistant-2',
      agent_run_id: 'run-2',
    })
    expect(shouldShowAssistantTurnFailure(persisted)).toBe(false)
  })

  it('shows a collapsed activity shell for completed runs until hydration proves no activity exists', () => {
    const completedTurn = attachPersistedAssistantMessage(
      createAssistantTurn({
        runId: 'run-3',
        conversationId: 'conversation-1',
        status: 'completed',
      }),
      {
        ...assistantMessage,
        id: 'assistant-3',
        agent_run_id: 'run-3',
      },
    )

    expect(completedTurn.activityAvailable).toBeNull()
    expect(shouldShowAssistantTurnActivity(completedTurn)).toBe(true)

    const hydratedWithoutActivity = replaceAssistantTurnActivity(completedTurn, {
      runId: 'run-3',
      conversationId: 'conversation-1',
      activity: {
        ...completedTurn.activity,
        hydrated: true,
        terminal: true,
        items: [],
      },
    })

    expect(hydratedWithoutActivity.activityAvailable).toBe(false)
    expect(shouldShowAssistantTurnActivity(hydratedWithoutActivity)).toBe(false)
  })

  it('treats heartbeat frames as no-ops so they do not churn state or accumulate deltas', () => {
    let state = createAssistantTurn({
      runId: 'run-4',
      conversationId: 'conversation-1',
      status: 'running',
    })
    state = applyAssistantTurnEvent(state, {
      type: 'run.content.delta',
      run_id: 'run-4',
      round_index: 0,
      seq: 7,
      delta: 'Partial content.',
    })
    const snapshotBefore = state

    const heartbeat: WsRunHeartbeat = {
      type: 'run.heartbeat',
      run_id: 'run-4',
      ts: '2026-04-21T10:00:00.000Z',
    }
    const afterHeartbeat = applyAssistantTurnEvent(snapshotBefore, heartbeat)

    expect(afterHeartbeat).toBe(snapshotBefore)
    expect(afterHeartbeat.partialContent).toBe('Partial content.')
    expect(afterHeartbeat.lastSeq).toBe(7)
    expect(afterHeartbeat.status).toBe('running')
  })

  it('keeps streamed content visible if the run completes before message hydration', () => {
    let state = createAssistantTurn({
      runId: 'run-5',
      conversationId: 'conversation-1',
      status: 'running',
    })

    state = applyAssistantTurnEvent(state, {
      type: 'run.content.delta',
      run_id: 'run-5',
      round_index: 0,
      seq: 2,
      delta: 'Live answer.',
    })
    state = applyAssistantTurnEvent(state, {
      type: 'run.completed',
      run_id: 'run-5',
      response_message_id: 'assistant-5',
      seq: 3,
    })

    expect(state.status).toBe('completed')
    expect(state.persistedMessage).toBeNull()
    expect(state.partialContent).toBe('Live answer.')
    expect(shouldShowAssistantTurnFailure(state)).toBe(false)
  })
})
