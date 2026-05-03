import { describe, expect, it } from 'vitest'

import {
  applyRunActivityEvent,
  createRunActivityState,
  getRunActivitySummary,
  humanizeToolLabel,
  hydrateRunActivity,
  parseToolResultPayload,
  summarizeToolResult,
} from './runActivity'
import type { AgentRunEvent, WsRunAssistantMessage, WsRunToolCalled, WsRunToolResult } from '@/types/api'

describe('runActivity helpers', () => {
  it('humanizes tool labels using repo tool arguments', () => {
    expect(humanizeToolLabel('read_file', { scope: 'project', path: 'trend_following.pdf' })).toBe(
      'Read trend_following.pdf',
    )
    expect(humanizeToolLabel('search_files', { query: 'trend', path: '.' })).toBe(
      'Searched resources for "trend"',
    )
    expect(humanizeToolLabel('execute_command', { argv: ['npm', 'test'] })).toBe('Ran npm test')
  })

  it('parses serialized tool payloads and summarizes them', () => {
    const raw =
      '{"ok":true,"tool_name":"read_file","data":{"path":"trend_following.pdf","content":"abc","more_available":false}}'

    expect(parseToolResultPayload(raw)).toEqual({
      ok: true,
      tool_name: 'read_file',
      data: { path: 'trend_following.pdf', content: 'abc', more_available: false },
      error_type: undefined,
      message: undefined,
      retryable: undefined,
      suggestion: undefined,
    })
    expect(summarizeToolResult('read_file', raw)).toBe('Read trend_following.pdf (3 chars)')
  })

  it('pairs tool call and tool result into one evolving tool row and dedupes seq', () => {
    const called: WsRunToolCalled = {
      type: 'run.tool.called',
      run_id: 'run-1',
      round_index: 0,
      seq: 3,
      tool_call: {
        id: 'call-1',
        name: 'read_file',
        arguments: { scope: 'project', path: 'trend_following.pdf' },
      },
    }
    const result: WsRunToolResult = {
      type: 'run.tool.result',
      run_id: 'run-1',
      round_index: 0,
      seq: 4,
      tool_call_id: 'call-1',
      tool_name: 'read_file',
      tool_result:
        '{"ok":true,"tool_name":"read_file","data":{"path":"trend_following.pdf","content":"summary","more_available":false}}',
    }

    let state = createRunActivityState('run-1')
    state = applyRunActivityEvent(state, called)
    state = applyRunActivityEvent(state, result)
    state = applyRunActivityEvent(state, result)

    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'call-1',
      label: 'Read trend_following.pdf',
      status: 'completed',
      resultSummary: 'Read trend_following.pdf (7 chars)',
    })
    expect(state.seenSeqs).toBeInstanceOf(Set)
    expect([...state.seenSeqs].sort((a, b) => a - b)).toEqual([3, 4])
  })

  it('dedupes sequence numbers in O(1) via a Set without mutating prior state', () => {
    const narration = (seq: number): WsRunAssistantMessage => ({
      type: 'run.assistant.message',
      run_id: 'run-set',
      round_index: 0,
      seq,
      content_text: `msg-${seq}`,
    })

    let state = createRunActivityState('run-set')
    const previousSeenSeqs = state.seenSeqs
    for (let seq = 1; seq <= 5_000; seq += 1) {
      state = applyRunActivityEvent(state, narration(seq))
    }

    expect(state.seenSeqs.size).toBe(5_000)
    expect(state.seenSeqs.has(1)).toBe(true)
    expect(state.seenSeqs.has(5_000)).toBe(true)
    expect(state.seenSeqs.has(5_001)).toBe(false)
    expect(state.seenSeqs).not.toBe(previousSeenSeqs)
    expect(previousSeenSeqs.size).toBe(0)

    const afterDedup = applyRunActivityEvent(state, narration(2_500))
    expect(afterDedup).toBe(state)
  })

  it('captures assistant narration and terminal status in summary', () => {
    const narration: WsRunAssistantMessage = {
      type: 'run.assistant.message',
      run_id: 'run-2',
      round_index: 0,
      seq: 2,
      content_text: 'I will inspect the PDF first.',
    }

    let state = createRunActivityState('run-2')
    state = applyRunActivityEvent(state, narration)
    expect(getRunActivitySummary(state)).toBe('I will inspect the PDF first.')

    state = applyRunActivityEvent(state, {
      type: 'run.completed',
      run_id: 'run-2',
      response_message_id: 'message-1',
      seq: 3,
    })
    expect(getRunActivitySummary(state)).toBe('1 note')
  })

  it('captures worker handoff progress as a compact activity row', () => {
    let state = createRunActivityState('run-worker-parent')

    state = applyRunActivityEvent(state, {
      type: 'task.worker.started',
      run_id: 'run-worker-parent',
      task_id: 'task-1',
      worker_run_id: 'worker-1',
      seq: 2,
    })
    state = applyRunActivityEvent(state, {
      type: 'task.worker.todo.updated',
      run_id: 'run-worker-parent',
      task_id: 'task-1',
      worker_run_id: 'worker-1',
      round_index: 0,
      tool_call_id: 'todo-call-1',
      todo: {
        ok: true,
        item: { id: 'T1', text: 'Write the report', status: 'in_progress' },
        done: false,
        progress: { completed: 0, total: 1 },
      },
      seq: 3,
    })

    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({
      kind: 'worker',
      workerRunId: 'worker-1',
      status: 'running',
      summary: 'T1: Write the report',
      progressLabel: '0/1 resolved',
    })
    expect(getRunActivitySummary(state)).toBe('T1: Write the report')
  })

  it('hydrates a completed run from persisted trace records', () => {
    const records: AgentRunEvent[] = [
      {
        id: 'evt-1',
        agent_run_id: 'run-3',
        agent_run_turn_id: 'turn-1',
        sequence_no: 2,
        event_type: 'run.assistant.message',
        status: 'ok',
        content_text: 'I will inspect the PDF first.',
        thinking_text: null,
        tool_call_ref: null,
        created_at: '2026-04-20T10:00:00Z',
        payload: {
          type: 'run.assistant.message',
          run_id: 'run-3',
          round_index: 0,
          content_text: 'I will inspect the PDF first.',
        },
      },
      {
        id: 'evt-2',
        agent_run_id: 'run-3',
        agent_run_turn_id: 'turn-1',
        sequence_no: 3,
        event_type: 'run.tool.called',
        status: 'ok',
        content_text: null,
        thinking_text: null,
        tool_call_ref: 'call-1',
        created_at: '2026-04-20T10:00:01Z',
        payload: {
          type: 'run.tool.called',
          run_id: 'run-3',
          round_index: 0,
          tool_call: {
            id: 'call-1',
            name: 'read_file',
            arguments: { scope: 'project', path: 'trend_following.pdf' },
          },
        },
      },
      {
        id: 'evt-3',
        agent_run_id: 'run-3',
        agent_run_turn_id: 'turn-1',
        sequence_no: 4,
        event_type: 'run.tool.result',
        status: 'ok',
        content_text: null,
        thinking_text: null,
        tool_call_ref: 'call-1',
        created_at: '2026-04-20T10:00:02Z',
        payload: {
          type: 'run.tool.result',
          run_id: 'run-3',
          round_index: 0,
          tool_call_id: 'call-1',
          tool_name: 'read_file',
          tool_result:
            '{"ok":true,"tool_name":"read_file","data":{"path":"trend_following.pdf","content":"abc","more_available":false}}',
        },
      },
      {
        id: 'evt-4',
        agent_run_id: 'run-3',
        agent_run_turn_id: 'turn-1',
        sequence_no: 5,
        event_type: 'run.completed',
        status: 'ok',
        content_text: null,
        thinking_text: null,
        tool_call_ref: null,
        created_at: '2026-04-20T10:00:03Z',
        payload: {
          type: 'run.completed',
          run_id: 'run-3',
          response_message_id: 'message-2',
        },
      },
    ]

    const state = hydrateRunActivity('run-3', records)
    expect(state.hydrated).toBe(true)
    expect(state.terminal).toBe(true)
    expect(state.items).toHaveLength(2)
    expect(state.items[0]).toMatchObject({ kind: 'narration', text: 'I will inspect the PDF first.' })
    expect(state.items[1]).toMatchObject({
      kind: 'tool',
      label: 'Read trend_following.pdf',
      status: 'completed',
    })
  })
})
