// Base URL for API calls — proxied to http://localhost:8000 in dev via vite.config
import type { ApiErrorDetail } from '@/types/api'

export const API_BASE = '/api/v1'

export class ApiError extends Error {
  status: number
  detail?: string
  code?: string
  data?: unknown

  constructor(status: number, detail?: string, options?: { code?: string; data?: unknown }) {
    super(detail ?? `HTTP ${status}`)
    this.name = 'ApiError'
    this.status = status
    this.detail = detail
    this.code = options?.code
    this.data = options?.data
  }
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers)

  if (!headers.has('Content-Type') && !(init?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json')
  }

  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const rawDetail = (body as { detail?: string | ApiErrorDetail }).detail
    if (typeof rawDetail === 'string') {
      throw new ApiError(res.status, rawDetail, { data: body })
    }

    throw new ApiError(res.status, rawDetail?.message, {
      code: rawDetail?.code,
      data: body,
    })
  }

  return res.json() as Promise<T>
}
