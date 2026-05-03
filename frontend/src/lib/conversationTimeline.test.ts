import { describe, expect, it } from 'vitest'

import { createAssistantTurn } from './assistantTurns'
import { buildConversationTimeline } from './conversationTimeline'
import type { Message } from '@/types/api'

const userMessage: Message = {
  id: 'user-1',
  project_id: 'project-1',
  conversation_id: 'conversation-1',
  agent_run_id: 'run-1',
  task_id: null,
  execution_mode: 'chat',
  role: 'user',
  input_mode: 'text',
  content_text: 'Explain the image.',
  thinking_text: null,
  status: 'completed',
  sequence_no: 1,
  provider: 'openrouter',
  model: 'openrouter/qwen/qwen3.6-plus',
  created_at: '2026-04-20T10:00:00Z',
  updated_at: '2026-04-20T10:00:00Z',
  failed_at: null,
  metadata: {},
  assets: [],
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
  content_text: 'It is a trend-following chart.',
  thinking_text: null,
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

describe('conversation timeline', () => {
  it('renders one assistant entry for a run even when both live turn state and persisted assistant exist', () => {
    const assistantTurn = createAssistantTurn({
      runId: 'run-1',
      conversationId: 'conversation-1',
      triggerMessageId: 'user-1',
      status: 'running',
      thinkingEnabled: false,
    })

    const entries = buildConversationTimeline(
      [userMessage, assistantMessage],
      [],
      { 'run-1': assistantTurn },
    )

    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant'])
    expect(entries[1].kind === 'assistant' && entries[1].turn.persistedMessage?.id).toBe('assistant-1')
  })

  it('anchors a live run turn after the optimistic user message before persistence catches up', () => {
    const assistantTurn = createAssistantTurn({
      runId: 'run-2',
      conversationId: 'conversation-1',
      triggerMessageId: 'opt-user-1',
      status: 'running',
      thinkingEnabled: true,
    })

    const entries = buildConversationTimeline(
      [],
      [
        {
          id: 'opt-user-1',
          role: 'user',
          content_text: 'Describe the chart.',
          thinking_text: null,
          status: 'queued',
          assets: [],
          sequence_no: 9998,
          agent_run_id: 'run-2',
        },
      ],
      { 'run-2': assistantTurn },
    )

    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant'])
  })

  it('hides system-generated approval resume messages while keeping their assistant turn', () => {
    const resumeUser: Message = {
      ...userMessage,
      id: 'resume-user-1',
      agent_run_id: 'resume-run-1',
      sequence_no: 3,
      content_text: 'The user approved the current plan through the plan approval controls.',
      metadata: { system_generated: true, kind: 'plan_approval_resume' },
    }
    const resumeAssistant: Message = {
      ...assistantMessage,
      id: 'resume-assistant-1',
      agent_run_id: 'resume-run-1',
      sequence_no: 4,
      content_text: 'Continuing after approval.',
    }

    const entries = buildConversationTimeline(
      [resumeUser, resumeAssistant],
      [],
      {},
    )

    expect(entries.map((entry) => entry.kind)).toEqual(['assistant'])
    expect(entries[0].kind === 'assistant' && entries[0].turn.persistedMessage?.id).toBe('resume-assistant-1')
  })
})
