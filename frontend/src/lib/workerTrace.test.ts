import { describe, expect, it } from 'vitest'

import {
  applyWorkerTraceEvent,
  createWorkerTraceState,
  dismissWorkerTrace,
  getActiveWorkerTraceRun,
  getWorkerProgressLabel,
  isTerminalWorkerTraceRun,
  isTerminalWorkerTraceStatus,
} from './workerTrace'
import type { WsTaskWorkerStarted, WsTaskWorkerTodoUpdated, WsTaskWorkerToolCalled, WsTaskWorkerToolResult } from '@/types/api'

describe('workerTrace reducer', () => {
  it('groups worker events by worker_run_id and tracks todo progress', () => {
    let state = createWorkerTraceState()
    const started: WsTaskWorkerStarted = {
      type: 'task.worker.started',
      run_id: 'parent-run',
      task_id: 'task-1',
      worker_run_id: 'worker-1',
      seq: 10,
    }
    const todo: WsTaskWorkerTodoUpdated = {
      type: 'task.worker.todo.updated',
      run_id: 'parent-run',
      task_id: 'task-1',
      worker_run_id: 'worker-1',
      round_index: 0,
      tool_call_id: 'todo-call',
      seq: 11,
      todo: {
        ok: true,
        item: { id: 'T1', text: 'Create output', status: 'in_progress', position: 1 },
        next_item: null,
        done: false,
        progress: { pending: 1, in_progress: 1, completed: 0, blocked: 0, skipped: 0, total: 2 },
      },
    }

    state = applyWorkerTraceEvent(state, started)
    state = applyWorkerTraceEvent(state, todo)

    const active = getActiveWorkerTraceRun(state)
    expect(active?.workerRunId).toBe('worker-1')
    expect(active?.status).toBe('running')
    expect(active?.currentItem?.id).toBe('T1')
    expect(getWorkerProgressLabel(active?.progress ?? null)).toBe('0/2 resolved')
  })

  it('merges worker tool call and result rows', () => {
    let state = createWorkerTraceState()
    const called: WsTaskWorkerToolCalled = {
      type: 'task.worker.tool.called',
      run_id: 'parent-run',
      task_id: 'task-1',
      worker_run_id: 'worker-1',
      round_index: 1,
      seq: 20,
      tool_call: {
        id: 'write-call',
        name: 'write_file',
        arguments: { scope: 'task', path: 'outputs/report.md' },
      },
    }
    const result: WsTaskWorkerToolResult = {
      type: 'task.worker.tool.result',
      run_id: 'parent-run',
      task_id: 'task-1',
      worker_run_id: 'worker-1',
      round_index: 1,
      seq: 21,
      tool_call_id: 'write-call',
      tool_name: 'write_file',
      tool_result: { ok: true, path: 'outputs/report.md', scope: 'task' },
    }

    state = applyWorkerTraceEvent(state, called)
    state = applyWorkerTraceEvent(state, result)

    const active = getActiveWorkerTraceRun(state)
    expect(active?.tools).toHaveLength(1)
    expect(active?.tools[0]).toMatchObject({
      toolCallId: 'write-call',
      label: 'Write outputs/report.md',
      status: 'completed',
      resultSummary: 'write file outputs/report.md',
    })
  })

  it('marks terminal status and supports dismissal', () => {
    let state = createWorkerTraceState()
    state = applyWorkerTraceEvent(state, {
      type: 'task.worker.completed',
      run_id: 'parent-run',
      task_id: 'task-1',
      worker_run_id: 'worker-1',
      seq: 30,
      result: { status: 'completed', summary: 'Worker finished.' },
    })

    expect(getActiveWorkerTraceRun(state)?.status).toBe('completed')
    expect(getActiveWorkerTraceRun(state)?.summary).toBe('Worker finished.')

    state = dismissWorkerTrace(state, 'worker-1')
    expect(getActiveWorkerTraceRun(state)).toBeNull()
  })

  it('detects terminal worker statuses without requiring dismissal', () => {
    let state = createWorkerTraceState()
    state = applyWorkerTraceEvent(state, {
      type: 'task.worker.blocked',
      run_id: 'parent-run',
      task_id: 'task-1',
      worker_run_id: 'worker-1',
      seq: 40,
      result: { status: 'blocked', summary: 'Needs Socrates follow-up.' },
    })

    const active = getActiveWorkerTraceRun(state)
    expect(isTerminalWorkerTraceStatus('completed')).toBe(true)
    expect(isTerminalWorkerTraceStatus('blocked')).toBe(true)
    expect(isTerminalWorkerTraceStatus('failed')).toBe(true)
    expect(isTerminalWorkerTraceStatus('running')).toBe(false)
    expect(isTerminalWorkerTraceRun(active)).toBe(true)
    expect(active?.workerRunId).toBe('worker-1')
  })
})
