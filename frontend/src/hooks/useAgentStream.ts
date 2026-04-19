import { useEffect, useRef, useCallback } from 'react'
import type { WsEvent } from '../types/api'

const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss' : 'ws'
const WS_BASE = `${WS_PROTOCOL}://${window.location.host}/api/v1`

interface UseAgentStreamOptions {
  runId: string | null
  onEvent: (event: WsEvent) => void
  onClose?: () => void
}

export function useAgentStream({ runId, onEvent, onClose }: UseAgentStreamOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const onEventRef = useRef(onEvent)
  const onCloseRef = useRef(onClose)

  // Keep refs current without re-subscribing
  useEffect(() => { onEventRef.current = onEvent }, [onEvent])
  useEffect(() => { onCloseRef.current = onClose }, [onClose])

  const disconnect = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onmessage = null
      wsRef.current.onclose = null
      wsRef.current.close()
      wsRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!runId) return
    disconnect()

    const ws = new WebSocket(`${WS_BASE}/agent-runs/${runId}/stream`)
    wsRef.current = ws

    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data) as WsEvent
        onEventRef.current(event)
      } catch {
        // malformed frame — ignore
      }
    }

    ws.onclose = (e) => {
      // 4404 = run not found
      if (e.code !== 1000 && e.code !== 4404) {
        console.warn(`[AgentStream] closed with code ${e.code}`)
      }
      onCloseRef.current?.()
    }

    ws.onerror = () => {
      // onclose fires after onerror, handled there
    }

    return disconnect
  }, [runId, disconnect])

  return { disconnect }
}
