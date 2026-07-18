import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import "@fastify/multipart"
import { conversationTranscriptionResponseSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { z } from "zod"
import { fail, ok, toApiError } from "../http"
import {
  V2_OPENROUTER_STT_MODELS,
  type LocalWhisperTranscriber,
  type OpenRouterTranscriber,
  type SpeechTranscription,
} from "../services/v2/speech"

const MAX_SPEECH_UPLOAD_BYTES = 50 * 1024 * 1024
const paramsSchema = z
  .object({ projectId: z.string().min(1), conversationId: z.string().min(1) })
  .strict()
const localQuerySchema = z
  .object({ engine: z.literal("local_whisper"), modelId: z.enum(["base.en", "small.en"]) })
  .strict()
const hostedQuerySchema = z
  .object({ engine: z.literal("openrouter"), modelId: z.enum(V2_OPENROUTER_STT_MODELS) })
  .strict()
const querySchema = z.discriminatedUnion("engine", [localQuerySchema, hostedQuerySchema])
const SUPPORTED_WAV_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/wave"])

type Awaitable<T> = T | Promise<T>

export type ClassicSpeechRouteServices = {
  requireConversationScope(input: { projectId: string; conversationId: string }): Awaitable<void>
  localWhisper: Pick<LocalWhisperTranscriber, "transcribe">
  openRouter: Pick<OpenRouterTranscriber, "transcribe">
  maxUploadBytes?: number
}

const parse = <T>(schema: z.ZodType<T>, value: unknown, code: string): T => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SocratesError(code, "Request did not match the conversation speech contract.", {
      details: parsed.error.flatten(),
      recoverable: true,
    })
  }
  return parsed.data
}

const withTemporaryWav = async <T>(data: Buffer, operation: (wavPath: string) => Promise<T>): Promise<T> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-classic-stt-"))
  const wavPath = path.join(directory, "input.wav")
  try {
    fs.writeFileSync(wavPath, data, { flag: "wx", mode: 0o600 })
    return await operation(wavPath)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const routeError = (error: unknown) => {
  if (error && typeof error === "object" && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
    return {
      statusCode: 413,
      response: fail({
        code: "speech_audio_too_large",
        message: "The recording exceeds the speech upload limit.",
        recoverable: true,
      }),
    }
  }

  const api = toApiError(error)
  const statusCode =
    api.code === "invalid_route_params" ||
    api.code === "invalid_request" ||
    api.code === "speech_audio_file_required" ||
    api.code === "speech_audio_empty" ||
    api.code === "speech_audio_type_not_supported" ||
    api.code === "v2_stt_model_not_allowed"
      ? 400
      : api.code.endsWith("_not_found")
        ? 404
        : api.code === "v2_stt_failed"
          ? 502
          : api.code === "openrouter_credential_missing" ||
              api.code.startsWith("v2_speech_runtime_") ||
              api.code.startsWith("v2_whisper_")
            ? 503
            : 500
  return { statusCode, response: fail(api) }
}

export const registerClassicSpeechRoutes = async (
  app: FastifyInstance,
  services: ClassicSpeechRouteServices,
): Promise<void> => {
  const maxUploadBytes = services.maxUploadBytes ?? MAX_SPEECH_UPLOAD_BYTES

  app.post("/api/projects/:projectId/conversations/:conversationId/speech/transcribe", async (request, reply) => {
    try {
      const scope = parse(paramsSchema, request.params, "invalid_route_params")
      const preference = parse(querySchema, request.query, "invalid_request")
      await services.requireConversationScope(scope)

      const upload = await request.file({ limits: { fileSize: maxUploadBytes, files: 1 } })
      if (!upload) {
        throw new SocratesError("speech_audio_file_required", "Record some speech before transcribing.", { recoverable: true })
      }
      if (!SUPPORTED_WAV_TYPES.has(upload.mimetype.toLowerCase())) {
        throw new SocratesError("speech_audio_type_not_supported", "Voice recordings must be normalized WAV audio.", {
          details: { mimeType: upload.mimetype },
          recoverable: true,
        })
      }

      const audio = await upload.toBuffer()
      if (audio.length === 0) {
        throw new SocratesError("speech_audio_empty", "The recording contained no audio.", { recoverable: true })
      }

      let result: SpeechTranscription
      if (preference.engine === "local_whisper") {
        result = await withTemporaryWav(audio, (wavPath) =>
          services.localWhisper.transcribe({ modelId: preference.modelId, wavPath }),
        )
      } else {
        result = await services.openRouter.transcribe({
          modelId: preference.modelId,
          audio,
          format: upload.mimetype,
        })
      }

      return ok(conversationTranscriptionResponseSchema.parse({
        transcriptText: result.text.trim(),
        engine: preference.engine,
        modelId: preference.modelId,
        ...(result.durationSeconds === undefined ? {} : { durationSeconds: result.durationSeconds }),
      }))
    } catch (error) {
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })
}
