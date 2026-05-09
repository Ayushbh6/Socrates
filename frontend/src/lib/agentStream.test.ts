import { describe, expect, it } from 'vitest'

import {
  getStreamResumeSeq,
  hasTerminalRunState,
  resolveAgentStreamBase,
  shouldReconnectAgentStream,
  toWebSocketOrigin,
} from './agentStream'

describe('agent stream helpers', () => {
  it('derives a direct backend websocket base in dev', () => {
    expect(
      resolveAgentStreamBase(
        { protocol: 'http:', host: 'localhost:5173' },
        { DEV: true, VITE_API_PROXY_TARGET: 'http://127.0.0.1:8000' },
      ),
    ).toBe('ws://127.0.0.1:8000/api/v1')
  })

  it('throws in dev when VITE_API_PROXY_TARGET is missing or blank', () => {
    expect(() =>
      resolveAgentStreamBase(
        { protocol: 'http:', host: 'localhost:5173' },
        { DEV: true },
      ),
    ).toThrow(/VITE_API_PROXY_TARGET is not set/)

    expect(() =>
      resolveAgentStreamBase(
        { protocol: 'http:', host: 'localhost:5173' },
        { DEV: true, VITE_API_PROXY_TARGET: '   ' },
      ),
    ).toThrow(/VITE_API_PROXY_TARGET is not set/)
  })

  it('uses same-origin websocket base outside dev without needing the env var', () => {
    expect(
      resolveAgentStreamBase(
        { protocol: 'https:', host: 'app.example.com' },
        { DEV: false },
      ),
    ).toBe('wss://app.example.com/api/v1')
  })

  it('normalizes websocket origins and strips trailing slash', () => {
    expect(toWebSocketOrigin('https://example.com/')).toBe('wss://example.com')
    expect(toWebSocketOrigin('http://localhost:8000/base/')).toBe('ws://localhost:8000/base')
  })

  it('tracks the correct resume sequence for snapshots and incremental frames', () => {
    expect(
      getStreamResumeSeq({
        type: 'run.snapshot',
        run_id: 'run-1',
        conversation_id: 'conversation-1',
        status: 'running',
        last_seq: 7,
        response_message_id: null,
        error: null,
      }),
    ).toBe(7)

    expect(
      getStreamResumeSeq({
        type: 'run.content.delta',
        run_id: 'run-1',
        round_index: 0,
        seq: 8,
        delta: 'Hello',
      }),
    ).toBe(8)
  })

  it('treats completed, failed, blocked, cancelled, and stalled run states as terminal', () => {
    expect(
      hasTerminalRunState({
        type: 'run.snapshot',
        run_id: 'run-1',
        conversation_id: 'conversation-1',
        status: 'completed',
        last_seq: 7,
        response_message_id: 'message-1',
        error: null,
      }),
    ).toBe(true)

    expect(
      hasTerminalRunState({
        type: 'run.failed',
        run_id: 'run-1',
        error: 'Provider disconnected',
      }),
    ).toBe(true)

    expect(
      hasTerminalRunState({
        type: 'run.blocked',
        run_id: 'run-1',
        error: 'Worker blocked.',
      }),
    ).toBe(true)

    expect(
      hasTerminalRunState({
        type: 'run.cancelled',
        run_id: 'run-1',
        reason: 'user_cancelled',
      }),
    ).toBe(true)

    expect(
      hasTerminalRunState({
        type: 'run.snapshot',
        run_id: 'run-1',
        conversation_id: 'conversation-1',
        status: 'stalled',
        last_seq: 9,
        response_message_id: null,
        error: 'Run stalled with no progress.',
      }),
    ).toBe(true)

    expect(
      hasTerminalRunState({
        type: 'run.tool.called',
        run_id: 'run-1',
        round_index: 0,
        tool_call: {
          id: 'call-1',
          name: 'read_file',
          arguments: { path: 'trend_following.pdf' },
        },
      }),
    ).toBe(false)
  })

  it('stops reconnecting after terminal state or not-found closure', () => {
    expect(shouldReconnectAgentStream({ closeCode: 1000, terminalStateSeen: false })).toBe(true)
    expect(shouldReconnectAgentStream({ closeCode: 1000, terminalStateSeen: true })).toBe(false)
    expect(shouldReconnectAgentStream({ closeCode: 4404, terminalStateSeen: false })).toBe(false)
  })
})
