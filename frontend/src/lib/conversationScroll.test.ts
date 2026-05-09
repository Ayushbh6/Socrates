import { describe, expect, it } from 'vitest'

import { applyAssistantTurnEvent, createAssistantTurn } from './assistantTurns'
import { createConversationScrollSignature } from './conversationScroll'
import type { ConversationTimelineEntry, OptimisticUserMessage } from './conversationTimeline'
import type { Asset, Message } from '@/types/api'

const asset: Asset = {
  id: 'asset-1',
  project_id: 'project-1',
  created_by_task_id: null,
  kind: 'document',
  source_type: 'upload',
  original_name: 'notes.pdf',
  mime_type: 'application/pdf',
  storage_path: 'uploads/notes.pdf',
  size_bytes: 123,
  sha256: 'abc',
  created_at: '2026-04-20T10:00:00Z',
  deleted_at: null,
  metadata: {},
}

const userMessage: OptimisticUserMessage = {
  id: 'user-1',
  role: 'user',
  content_text: 'Summarize this.',
  thinking_text: null,
  status: 'completed',
  assets: [],
  sequence_no: 1,
  agent_run_id: 'run-1',
}

const assistantMessage: Message = {
  id: 'assistant-1',
  project_id: 'project-1',
  conversation_id: 'conversation-1',
  agent_run_id: 'run-1',
  task_id: null,
  execution_mode: 'chat',
  role: 'assistant',
  input_mode: 'text',
  content_text: 'Final answer.',
  thinking_text: 'Reasoning.',
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

function entriesForTurn(turn = createAssistantTurn({ runId: 'run-1', conversationId: 'conversation-1' })) {
  return [
    { kind: 'user', key: userMessage.id, message: userMessage },
    { kind: 'assistant', key: `assistant:${turn.runId}`, turn },
  ] satisfies ConversationTimelineEntry[]
}

describe('conversation scroll signature', () => {
  it('changes when assistant content grows', () => {
    const initial = createAssistantTurn({
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'running',
    })
    const withContent = applyAssistantTurnEvent(initial, {
      type: 'run.content.delta',
      run_id: 'run-1',
      round_index: 0,
      seq: 1,
      delta: 'Partial answer.',
    })

    expect(createConversationScrollSignature(entriesForTurn(withContent))).not.toBe(
      createConversationScrollSignature(entriesForTurn(initial)),
    )
  })

  it('changes when thinking text becomes visible and grows', () => {
    const initial = createAssistantTurn({
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'running',
      thinkingEnabled: true,
    })
    const withThinking = applyAssistantTurnEvent(initial, {
      type: 'run.thinking.delta',
      run_id: 'run-1',
      round_index: 0,
      seq: 1,
      delta: 'Reasoning step.',
    })

    expect(createConversationScrollSignature(entriesForTurn(withThinking))).not.toBe(
      createConversationScrollSignature(entriesForTurn(initial)),
    )
  })

  it('ignores activity summary and progress churn while the activity panel remains visible', () => {
    let turn = createAssistantTurn({
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'running',
    })
    turn = applyAssistantTurnEvent(turn, {
      type: 'task.worker.started',
      run_id: 'run-1',
      seq: 1,
      worker_run_id: 'worker-1',
      task_id: 'task-1',
    })
    const before = createConversationScrollSignature(entriesForTurn(turn))

    const updated = applyAssistantTurnEvent(turn, {
      type: 'task.worker.todo.updated',
      run_id: 'run-1',
      seq: 2,
      worker_run_id: 'worker-1',
      task_id: 'task-1',
      round_index: 0,
      tool_call_id: 'todo-call-1',
      todo: {
        ok: true,
        item: { id: 'T1', text: 'Read the PDF carefully', status: 'in_progress' },
        next_item: null,
        done: false,
        progress: { pending: 1, in_progress: 1, completed: 0, blocked: 0, skipped: 0, total: 2 },
      },
    })

    expect(createConversationScrollSignature(entriesForTurn(updated))).toBe(before)
  })

  it('changes when the activity panel first appears or disappears', () => {
    const completedWithoutActivity = createAssistantTurn({
      runId: 'run-1',
      conversationId: 'conversation-1',
      status: 'completed',
    })
    const hiddenActivity = {
      ...completedWithoutActivity,
      activityAvailable: false,
    }

    expect(createConversationScrollSignature(entriesForTurn(completedWithoutActivity))).not.toBe(
      createConversationScrollSignature(entriesForTurn(hiddenActivity)),
    )
  })

  it('includes rendered user and legacy assistant content but not unrelated metadata', () => {
    const userWithAsset = { ...userMessage, assets: [asset] }
    const legacyMessage = {
      ...assistantMessage,
      id: 'legacy-1',
      agent_run_id: null,
      content_text: 'Legacy answer.',
    }
    const entries = [
      { kind: 'user', key: userWithAsset.id, message: userWithAsset },
      { kind: 'legacy-assistant', key: 'legacy:legacy-1', message: legacyMessage },
    ] satisfies ConversationTimelineEntry[]

    const signature = createConversationScrollSignature(entries)

    expect(signature).toContain('user:user-1:user-1')
    expect(signature).toContain('legacy-assistant:legacy:legacy-1:legacy-1')
    expect(signature).toContain('asset-1')
  })
})
