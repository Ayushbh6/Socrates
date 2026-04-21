import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import {
  findPersistedAssistantMessageForRun,
  reconcileRunMessagesFromServer,
  recoverClosedRun,
} from './runStreamRecovery'
import type { AgentRun, Message } from '@/types/api'

const sampleMessages: Message[] = [
  {
    id: 'user-1',
    project_id: 'project-1',
    conversation_id: 'conversation-1',
    agent_run_id: null,
    task_id: null,
    execution_mode: 'chat',
    role: 'user',
    input_mode: 'text',
    content_text: 'Explain the chart.',
    thinking_text: null,
    status: 'completed',
    sequence_no: 1,
    provider: null,
    model: null,
    created_at: '2026-04-20T10:00:00Z',
    updated_at: '2026-04-20T10:00:00Z',
    failed_at: null,
    metadata: {},
    assets: [],
  },
  {
    id: 'assistant-1',
    project_id: 'project-1',
    conversation_id: 'conversation-1',
    agent_run_id: 'run-1',
    task_id: null,
    execution_mode: 'chat',
    role: 'assistant',
    input_mode: 'text',
    content_text: 'This chart shows the equity curve.',
    thinking_text: null,
    status: 'completed',
    sequence_no: 2,
    provider: 'openrouter',
    model: 'openrouter/qwen/qwen3.6-plus',
    created_at: '2026-04-20T10:00:05Z',
    updated_at: '2026-04-20T10:00:05Z',
    failed_at: null,
    metadata: {},
    assets: [],
  },
]

const completedRun: AgentRun = {
  id: 'run-1',
  project_id: 'project-1',
  conversation_id: 'conversation-1',
  task_id: null,
  trigger_message_id: 'user-1',
  response_message_id: 'assistant-1',
  status: 'completed',
  execution_mode: 'chat',
  provider: 'openrouter',
  model: 'openrouter/qwen/qwen3.6-plus',
  input_mode: 'text',
  system_prompt_text: null,
  query_text: 'Explain the chart.',
  request_json: {},
  final_response_json: {},
  final_parsed_json: {},
  aggregated_metadata_json: {},
  usage_input_tokens: null,
  usage_output_tokens: null,
  usage_completion_tokens: null,
  usage_total_tokens: null,
  elapsed_ms: 1200,
  started_at: '2026-04-20T10:00:00Z',
  completed_at: '2026-04-20T10:00:05Z',
  error_message: null,
  created_at: '2026-04-20T10:00:00Z',
  event_count: 10,
  turn_count: 1,
}

describe('run stream recovery helpers', () => {
  it('finds the persisted assistant for a run', () => {
    expect(findPersistedAssistantMessageForRun(sampleMessages, 'run-1')).toMatchObject({
      id: 'assistant-1',
      agent_run_id: 'run-1',
    })
  })

  it('reconciles messages from the server instead of trusting cached data', async () => {
    const queryClient = new QueryClient()
    queryClient.setQueryData<Message[]>(['messages', 'conversation-1'], [sampleMessages[0]])

    const result = await reconcileRunMessagesFromServer({
      conversationId: 'conversation-1',
      runId: 'run-1',
      queryClient,
      fetchMessages: vi.fn().mockResolvedValue([sampleMessages[1], sampleMessages[0]]),
    })

    expect(result.persistedAssistant).toMatchObject({ id: 'assistant-1' })
    expect(queryClient.getQueryData<Message[]>(['messages', 'conversation-1'])).toEqual(sampleMessages)
  })

  it('waits for a completed run to surface its persisted assistant before failing over', async () => {
    const queryClient = new QueryClient()
    const fetchRun = vi
      .fn<() => Promise<AgentRun>>()
      .mockResolvedValueOnce({ ...completedRun, status: 'running', completed_at: null, response_message_id: null })
      .mockResolvedValueOnce(completedRun)
    const fetchMessages = vi
      .fn<(conversationId: string) => Promise<Message[]>>()
      .mockResolvedValueOnce([sampleMessages[0]])
      .mockResolvedValueOnce(sampleMessages)

    const result = await recoverClosedRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      queryClient,
      fetchRun,
      fetchMessages,
      attempts: 2,
      delayMs: 0,
      sleep: vi.fn().mockResolvedValue(undefined),
    })

    expect(fetchRun).toHaveBeenCalledTimes(2)
    expect(fetchMessages).toHaveBeenCalledTimes(2)
    expect(result.run?.status).toBe('completed')
    expect(result.persistedAssistant).toMatchObject({ id: 'assistant-1' })
  })

  it('returns a failed run without inventing a persisted assistant', async () => {
    const queryClient = new QueryClient()

    const result = await recoverClosedRun({
      conversationId: 'conversation-1',
      runId: 'run-1',
      queryClient,
      fetchRun: vi.fn().mockResolvedValue({
        ...completedRun,
        status: 'failed',
        response_message_id: null,
        completed_at: null,
        error_message: 'Provider disconnected.',
      }),
      fetchMessages: vi.fn().mockResolvedValue([sampleMessages[0]]),
      attempts: 1,
      delayMs: 0,
      sleep: vi.fn().mockResolvedValue(undefined),
    })

    expect(result.run?.status).toBe('failed')
    expect(result.persistedAssistant).toBeNull()
  })
})
