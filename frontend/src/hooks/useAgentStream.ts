import { useEffect, useRef, useCallback } from 'react'
import {
  getStreamResumeSeq,
  hasTerminalRunState,
  resolveAgentStreamBase,
  shouldReconnectAgentStream,
} from '../lib/agentStream'
import type { WsEvent } from '../types/api'

const WS_BASE = resolveAgentStreamBase(window.location, import.meta.env)

export type AgentStreamConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

interface UseAgentStreamOptions {
  runId: string | null
  afterSeq?: number
  onEvent: (event: WsEvent) => void
  onConnectionChange?: (state: AgentStreamConnectionState) => void
}

export function useAgentStream({
  runId,
  afterSeq = 0,
  onEvent,
  onConnectionChange,
}: UseAgentStreamOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const onEventRef = useRef(onEvent)
  const onConnectionChangeRef = useRef(onConnectionChange)
  const afterSeqRef = useRef(afterSeq)
  const terminalStateSeenRef = useRef(false)

  // Keep refs current without re-subscribing
  useEffect(() => { onEventRef.current = onEvent }, [onEvent])
  useEffect(() => { onConnectionChangeRef.current = onConnectionChange }, [onConnectionChange])
  useEffect(() => { afterSeqRef.current = afterSeq }, [afterSeq])
  useEffect(() => { terminalStateSeenRef.current = false }, [runId])

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onmessage = null
      wsRef.current.onclose = null
      wsRef.current.onerror = null
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!runId) {
      disconnect()
      onConnectionChangeRef.current?.('idle')
      return
    }

    let cancelled = false
    let reconnectTimer: number | null = null
    let reconnectAttempt = 0

    const clearReconnectTimer = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
    }

    // Terminal cleanup: the run is definitively done (either by a terminal
    // event arriving or by React tearing down the hook). We close the socket,
    // cancel any pending reconnect attempts, and surface 'closed' exactly
    // once. Calling this from `onmessage` the moment a terminal event arrives
    // -- rather than waiting for `onclose` -- is what prevents the UI from
    // briefly flashing 'reconnecting' between the terminal frame and the
    // backend closing the socket, and it also short-circuits any reconnect
    // timer that may already have been scheduled from an earlier blip.
    const finalize = () => {
      if (cancelled) {
        return
      }
      cancelled = true
      clearReconnectTimer()
      disconnect()
      onConnectionChangeRef.current?.('closed')
    }

    const connect = (resume: boolean) => {
      if (cancelled) {
        return
      }

      disconnect()
      onConnectionChangeRef.current?.(resume ? 'reconnecting' : 'connecting')

      const url = new URL(`${WS_BASE}/agent-runs/${runId}/stream`)
      if (afterSeqRef.current > 0) {
        url.searchParams.set('after_seq', String(afterSeqRef.current))
      }

      const ws = new WebSocket(url.toString())
      wsRef.current = ws

      ws.onopen = () => {
        reconnectAttempt = 0
        onConnectionChangeRef.current?.('open')
      }

      ws.onmessage = (e) => {
        let event: WsEvent
        try {
          event = JSON.parse(e.data) as WsEvent
        } catch {
          return
        }

        const resumeSeq = getStreamResumeSeq(event)
        if (resumeSeq > afterSeqRef.current) {
          afterSeqRef.current = resumeSeq
        }
        const isTerminal = hasTerminalRunState(event)
        if (isTerminal) {
          terminalStateSeenRef.current = true
        }

        onEventRef.current(event)

        if (isTerminal) {
          finalize()
        }
      }

      ws.onclose = (e) => {
        if (wsRef.current === ws) {
          wsRef.current = null
        }

        if (cancelled) {
          return
        }

        if (!shouldReconnectAgentStream({
          closeCode: e.code,
          terminalStateSeen: terminalStateSeenRef.current,
        })) {
          onConnectionChangeRef.current?.('closed')
          return
        }

        const delay = Math.min(250 * 2 ** reconnectAttempt, 2000)
        reconnectAttempt += 1
        reconnectTimer = window.setTimeout(() => connect(true), delay)
      }

      ws.onerror = () => {
        // onclose handles reconnect and state transitions.
      }
    }

    connect(false)

    return () => {
      finalize()
    }
  }, [runId, disconnect])

  return { disconnect }
}
