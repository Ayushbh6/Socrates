import type { WsEvent } from '@/types/api'

interface StreamLocationLike {
  protocol: string
  host: string
}

interface StreamEnvLike {
  DEV: boolean
  VITE_API_PROXY_TARGET?: string
}

function trimTrailingSlash(value: string) {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function toWebSocketOrigin(target: string) {
  const normalizedTarget = trimTrailingSlash(target.trim())
  const url = new URL(normalizedTarget)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = trimTrailingSlash(url.pathname)
  url.search = ''
  url.hash = ''
  return trimTrailingSlash(url.toString())
}

// In dev the browser talks to the backend directly over WebSocket (the Vite
// HTTP proxy is not involved), so the URL we build here MUST match the
// address the backend is actually bound to. We require an explicit
// `VITE_API_PROXY_TARGET` rather than silently defaulting to
// `http://localhost:8000`, because on macOS `localhost` can resolve to IPv6
// `::1` first and the backend typically only listens on IPv4
// `127.0.0.1:8000` — that mismatch reproduces as a stream that is stuck in
// "Reconnecting to live stream" forever. Failing loudly here surfaces the
// misconfiguration on page load instead.
export function resolveAgentStreamBase(
  locationLike: StreamLocationLike,
  env: StreamEnvLike,
) {
  if (env.DEV) {
    const target = env.VITE_API_PROXY_TARGET?.trim()
    if (!target) {
      throw new Error(
        'VITE_API_PROXY_TARGET is not set. Set it in frontend/.env.local (or .env) ' +
          'to the backend URL, e.g. VITE_API_PROXY_TARGET=http://127.0.0.1:8000. ' +
          'It must match the address uvicorn binds to; do not use "localhost" on ' +
          'macOS because it may resolve to IPv6 ::1 and refuse WebSocket connections.',
      )
    }
    return `${toWebSocketOrigin(target)}/api/v1`
  }

  const protocol = locationLike.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${locationLike.host}/api/v1`
}

export function getStreamResumeSeq(event: WsEvent) {
  if (event.type === 'run.snapshot') {
    return event.last_seq
  }

  return typeof event.seq === 'number' ? event.seq : 0
}

export function hasTerminalRunState(event: WsEvent) {
  return (
    event.type === 'run.completed' ||
    event.type === 'run.failed' ||
    event.type === 'run.cancelled' ||
    event.type === 'run.stalled' ||
    (
      event.type === 'run.snapshot' &&
      (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled' || event.status === 'stalled')
    )
  )
}

export function shouldReconnectAgentStream(params: {
  closeCode: number
  terminalStateSeen: boolean
}) {
  if (params.closeCode === 4404) {
    return false
  }

  return !params.terminalStateSeen
}
