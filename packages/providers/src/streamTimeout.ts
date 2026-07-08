import { SocratesError } from "@socrates/shared"
import type { ModelRequest } from "./types"

const DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS = 120_000

export const createStreamTimeout = (
  request: Pick<ModelRequest, "abortSignal" | "providerId" | "modelId">,
): {
  signal: AbortSignal
  timeoutError: SocratesError | undefined
  refresh: () => void
  dispose: () => void
} => {
  const timeoutMs = Number(process.env.SOCRATES_MODEL_STREAM_IDLE_TIMEOUT_MS ?? DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS)
  const controller = new AbortController()
  let timeoutError: SocratesError | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const abortFromParent = () => controller.abort(request.abortSignal?.reason)
  const refresh = () => {
    if (timer) {
      clearTimeout(timer)
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || controller.signal.aborted) {
      return
    }
    timer = setTimeout(() => {
      timeoutError = new SocratesError("model_stream_idle_timeout", "Model provider stream timed out without new output.", {
        details: { providerId: request.providerId, modelId: request.modelId, idleTimeoutMs: timeoutMs },
        recoverable: true,
      })
      controller.abort(timeoutError)
    }, timeoutMs)
  }

  if (request.abortSignal?.aborted) {
    abortFromParent()
  } else {
    request.abortSignal?.addEventListener("abort", abortFromParent, { once: true })
    refresh()
  }

  return {
    signal: controller.signal,
    get timeoutError() {
      return timeoutError
    },
    refresh,
    dispose: () => {
      if (timer) {
        clearTimeout(timer)
      }
      request.abortSignal?.removeEventListener("abort", abortFromParent)
    },
  }
}
