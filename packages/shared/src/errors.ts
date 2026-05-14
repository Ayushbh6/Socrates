export type ErrorDetails = Record<string, unknown> | unknown[] | string | number | boolean | null

export class SocratesError extends Error {
  readonly code: string
  readonly details: ErrorDetails | undefined
  readonly recoverable: boolean

  constructor(code: string, message: string, options: { details?: ErrorDetails | undefined; recoverable?: boolean } = {}) {
    super(message)
    this.name = "SocratesError"
    this.code = code
    this.details = options.details
    this.recoverable = options.recoverable ?? true
  }
}

export const normalizeError = (error: unknown): SocratesError => {
  if (error instanceof SocratesError) {
    return error
  }

  if (error instanceof Error) {
    return new SocratesError(
      "internal_error",
      error.message,
      error.stack ? { details: { stack: error.stack }, recoverable: false } : { recoverable: false },
    )
  }

  return new SocratesError("internal_error", "Unknown error", {
    details: { value: error },
    recoverable: false,
  })
}
