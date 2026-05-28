import type { ApiError, ApiResponse } from "@socrates/contracts"
import { SocratesError, normalizeError } from "@socrates/shared"

export const ok = <T>(data: T): ApiResponse<T> => ({ ok: true, data })

export const apiError = (
  code: string,
  message: string,
  options: { details?: unknown; requestId?: string; recoverable?: boolean } = {},
): ApiError => ({
  code,
  message,
  ...(options.details === undefined ? {} : { details: options.details }),
  ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  ...(options.recoverable === undefined ? {} : { recoverable: options.recoverable }),
})

export const fail = (error: ApiError): ApiResponse<never> => ({ ok: false, error })

export const toApiError = (error: unknown): ApiError => {
  const normalized = normalizeError(error)
  return apiError(normalized.code, normalized.message, { details: normalized.details, recoverable: normalized.recoverable })
}

export const notFound = (entity: string): SocratesError =>
  new SocratesError(`${entity}_not_found`, `${entity} not found`, { recoverable: true })
