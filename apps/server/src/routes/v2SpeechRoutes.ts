import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { FastifyInstance } from "fastify"
import "@fastify/multipart"
import { z } from "zod"
import {
  V2_LOCAL_KOKORO_MODEL_ID,
  V2_OPENROUTER_STT_MODEL_IDS,
  type V2Artifact,
  type V2CreateSpeechJobRequest,
  type V2SpeechJob,
  v2ArtifactSchema,
  v2CreateSpeechJobRequestSchema,
  v2CreateSpeechJobResponseSchema,
  v2SpeechJobSchema,
} from "@socrates/contracts"
import { SocratesError, normalizeError } from "@socrates/shared"
import { fail, ok, toApiError } from "../http"
import {
  V2_SPEECH_PACK_MANIFEST,
  type LocalKokoroSynthesizer,
  type LocalWhisperTranscriber,
  type OpenRouterTranscriber,
  type SpeechPackId,
  type SpeechPackManager,
  type SpeechTranscription,
} from "../services/v2/speech"

const MAX_SPEECH_UPLOAD_BYTES = 50 * 1024 * 1024
const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  "audio/flac",
  "audio/m4a",
  "audio/mp3",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/webm",
  "audio/x-m4a",
  "audio/x-wav",
])

const flowParamsSchema = z
  .object({ projectId: z.string().min(1), flowId: z.string().min(1) })
  .strict()
const artifactParamsSchema = flowParamsSchema.extend({ artifactId: z.string().min(1) }).strict()
const jobParamsSchema = flowParamsSchema.extend({ jobId: z.string().min(1) }).strict()
const speechPackParamsSchema = z.object({ packId: z.string().min(1) }).strict()

type Awaitable<T> = T | Promise<T>

export type V2SpeechArtifactContent = {
  artifact: V2Artifact
  data?: Buffer
  path?: string
}

export type V2SpeechJobUpdate =
  | { status: "running"; startedAt: string }
  | {
      status: "completed"
      completedAt: string
      durationMs: number
      transcriptText: string
      usage?: SpeechTranscription["usage"]
      providerRaw?: unknown
    }
  | {
      status: "completed"
      completedAt: string
      durationMs: number
      outputArtifactId: string
    }
  | {
      status: "failed"
      completedAt: string
      error: { code: string; message: string; details?: unknown; recoverable: boolean }
    }

/**
 * The speech HTTP layer has no database dependency and cannot write a Classic
 * conversation row. The V2 Flow store supplies this narrow persistence adapter.
 */
export interface V2SpeechPersistence {
  requireFlowScope(input: { projectId: string; flowId: string }): Awaitable<void>
  createSpeechArtifact(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    kind: "speech_input" | "speech_output"
    fileName: string
    mimeType: string
    data: Buffer
  }): Awaitable<V2Artifact>
  readSpeechArtifact(input: { projectId: string; flowId: string; artifactId: string }): Awaitable<V2SpeechArtifactContent>
  createSpeechJob(input: {
    projectId: string
    flowId: string
    request: V2CreateSpeechJobRequest
  }): Awaitable<V2SpeechJob>
  updateSpeechJob(input: {
    projectId: string
    flowId: string
    jobId: string
    update: V2SpeechJobUpdate
  }): Awaitable<V2SpeechJob>
  getSpeechJob(input: { projectId: string; flowId: string; jobId: string }): Awaitable<V2SpeechJob>
}

type SpeechPackService = Pick<SpeechPackManager, "status" | "install" | "remove">
type LocalWhisperService = Pick<LocalWhisperTranscriber, "transcribe">
type OpenRouterService = Pick<OpenRouterTranscriber, "transcribe">
type KokoroService = Pick<LocalKokoroSynthesizer, "synthesize">

export type V2SpeechRouteServices = {
  persistence: V2SpeechPersistence
  packs: SpeechPackService
  localWhisper: LocalWhisperService
  openRouter: OpenRouterService
  kokoro: KokoroService
  now?: () => string
  maxUploadBytes?: number
}

const parse = <T>(schema: z.ZodType<T>, value: unknown, code: string): T => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SocratesError(code, "Request did not match the V2 speech contract.", {
      details: parsed.error.flatten(),
      recoverable: true,
    })
  }
  return parsed.data
}

const parseSpeechPackId = (value: unknown): SpeechPackId => {
  const { packId } = parse(speechPackParamsSchema, value, "invalid_route_params")
  if (!Object.prototype.hasOwnProperty.call(V2_SPEECH_PACK_MANIFEST, packId)) {
    throw new SocratesError("v2_speech_pack_not_found", "That speech pack is not available.", {
      details: { packId, availablePackIds: Object.keys(V2_SPEECH_PACK_MANIFEST) },
      recoverable: true,
    })
  }
  return packId as SpeechPackId
}

const routeError = (error: unknown) => {
  if (error && typeof error === "object" && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
    return {
      statusCode: 413,
      response: fail({
        code: "v2_audio_too_large",
        message: "The recording exceeds the speech upload limit.",
        recoverable: true,
      }),
    }
  }
  const api = toApiError(error)
  const statusCode =
    api.code === "invalid_request" ||
    api.code === "invalid_route_params" ||
    api.code === "v2_audio_file_required" ||
    api.code === "v2_audio_empty" ||
    api.code === "v2_audio_type_not_supported" ||
    api.code === "v2_audio_too_large" ||
    api.code === "v2_local_stt_wav_required" ||
    api.code === "v2_kokoro_voice_invalid" ||
    api.code === "v2_stt_model_not_allowed" ||
    api.code === "v2_tts_text_required"
      ? 400
      : api.code.endsWith("_not_found") || api.code === "v2_audio_missing"
        ? 404
        : api.code === "v2_speech_pack_busy"
          ? 409
          : api.code === "v2_stt_failed" || api.code === "v2_speech_pack_download_failed"
            ? 502
            : api.code.startsWith("v2_speech_runtime_") ||
                api.code.startsWith("v2_whisper_") ||
                api.code.startsWith("v2_kokoro_") ||
                api.code === "openrouter_credential_missing"
              ? 503
              : 500
  return { statusCode, response: fail(api) }
}

const readArtifactBytes = (content: V2SpeechArtifactContent): Buffer => {
  if (content.data) return content.data
  if (content.path) {
    try {
      return fs.readFileSync(content.path)
    } catch {
      throw new SocratesError("v2_audio_missing", "The stored speech artifact could not be read.", {
        details: { artifactId: content.artifact.id },
        recoverable: true,
      })
    }
  }
  throw new SocratesError("v2_audio_missing", "The stored speech artifact has no readable content.", {
    details: { artifactId: content.artifact.id },
    recoverable: true,
  })
}

const artifactAudioFormat = (artifact: V2Artifact): string => {
  if (artifact.mimeType) return artifact.mimeType
  const candidate = artifact.path ?? artifact.uri ?? ""
  const extension = path.extname(candidate).replace(/^\./, "")
  return extension || "application/octet-stream"
}

const isWavArtifact = (artifact: V2Artifact): boolean => {
  const format = artifactAudioFormat(artifact).toLowerCase()
  return format === "wav" || format === "audio/wav" || format === "audio/x-wav" || format === "audio/wave"
}

const safeUploadName = (value: string): string => {
  const base = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, "").trim()
  return base.slice(0, 240) || "recording"
}

const withTemporaryWav = async <T>(data: Buffer, operation: (wavPath: string) => Promise<T>): Promise<T> => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-stt-"))
  const wavPath = path.join(directory, "input.wav")
  try {
    fs.writeFileSync(wavPath, data, { flag: "wx", mode: 0o600 })
    return await operation(wavPath)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const parseKokoroSpeaker = (voiceId: string): number => {
  const match = /^(?:speaker-)?(\d{1,2})$/.exec(voiceId)
  const speakerId = match?.[1] === undefined ? Number.NaN : Number(match[1])
  if (!Number.isInteger(speakerId) || speakerId < 0 || speakerId > 10) {
    throw new SocratesError("v2_kokoro_voice_invalid", "Kokoro voiceId must be a speaker number from 0 to 10.", {
      details: { voiceId },
      recoverable: true,
    })
  }
  return speakerId
}

const failCreatedJob = async (
  services: V2SpeechRouteServices,
  scope: { projectId: string; flowId: string },
  job: V2SpeechJob,
  error: unknown,
  now: () => string,
): Promise<void> => {
  const normalized = normalizeError(error)
  try {
    await services.persistence.updateSpeechJob({
      ...scope,
      jobId: job.id,
      update: {
        status: "failed",
        completedAt: now(),
        error: {
          code: normalized.code,
          message: normalized.message,
          ...(normalized.details === undefined ? {} : { details: normalized.details }),
          recoverable: normalized.recoverable,
        },
      },
    })
  } catch {
    // Preserve the speech engine error as the response. Persistence can report
    // its own failure through V2 recovery/telemetry without masking root cause.
  }
}

const executeSpeechJob = async (
  services: V2SpeechRouteServices,
  scope: { projectId: string; flowId: string },
  request: V2CreateSpeechJobRequest,
  job: V2SpeechJob,
  now: () => string,
): Promise<V2SpeechJob> => {
  const startedAt = Date.now()
  await services.persistence.updateSpeechJob({ ...scope, jobId: job.id, update: { status: "running", startedAt: now() } })

  if (request.kind === "transcription") {
    const artifactContent = await services.persistence.readSpeechArtifact({
      ...scope,
      artifactId: request.inputArtifactId,
    })
    const audio = readArtifactBytes(artifactContent)
    let result: SpeechTranscription
    if (request.engine === "local_whisper") {
      if (!isWavArtifact(artifactContent.artifact)) {
        throw new SocratesError("v2_local_stt_wav_required", "Local Whisper requires mono WAV input. Recordings must be normalized before transcription.", {
          details: { artifactId: request.inputArtifactId, mimeType: artifactContent.artifact.mimeType },
          recoverable: true,
        })
      }
      result = await withTemporaryWav(audio, (wavPath) =>
        services.localWhisper.transcribe({
          modelId: request.modelId,
          wavPath,
          ...(request.language ? { language: request.language } : {}),
        }),
      )
    } else {
      result = await services.openRouter.transcribe({
        modelId: request.modelId,
        audio,
        format: artifactAudioFormat(artifactContent.artifact),
        ...(request.language ? { language: request.language } : {}),
      })
    }
    return v2SpeechJobSchema.parse(await services.persistence.updateSpeechJob({
      ...scope,
      jobId: job.id,
      update: {
        status: "completed",
        completedAt: now(),
        durationMs: Math.max(0, Math.round((result.durationSeconds ?? (Date.now() - startedAt) / 1_000) * 1_000)),
        transcriptText: result.text,
        ...(result.usage ? { usage: result.usage } : {}),
        ...(result.raw === undefined ? {} : { providerRaw: result.raw }),
      },
    }))
  }

  if (request.modelId !== V2_LOCAL_KOKORO_MODEL_ID) {
    throw new SocratesError("v2_tts_model_not_allowed", "That speech synthesizer is not enabled for Socrates Flow.", {
      recoverable: true,
    })
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-tts-"))
  const outputPath = path.join(directory, "speech.wav")
  try {
    await services.kokoro.synthesize({
      text: request.inputText,
      outputPath,
      speakerId: parseKokoroSpeaker(request.voiceId),
      speed: request.speed,
    })
    const audio = fs.readFileSync(outputPath)
    const artifact = v2ArtifactSchema.parse(await services.persistence.createSpeechArtifact({
      ...scope,
      ...(request.goalId ? { goalId: request.goalId } : {}),
      ...(request.turnId ? { turnId: request.turnId } : {}),
      kind: "speech_output",
      fileName: `socrates-${job.id}.wav`,
      mimeType: "audio/wav",
      data: audio,
    }))
    return v2SpeechJobSchema.parse(await services.persistence.updateSpeechJob({
      ...scope,
      jobId: job.id,
      update: {
        status: "completed",
        completedAt: now(),
        durationMs: Math.max(0, Date.now() - startedAt),
        outputArtifactId: artifact.id,
      },
    }))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

export const registerV2SpeechRoutes = async (
  app: FastifyInstance,
  services: V2SpeechRouteServices,
): Promise<void> => {
  const now = services.now ?? (() => new Date().toISOString())
  const maxUploadBytes = services.maxUploadBytes ?? MAX_SPEECH_UPLOAD_BYTES

  app.get("/api/v2/speech/packs", async (_request, reply) => {
    try {
      return ok({
        packs: Object.keys(V2_SPEECH_PACK_MANIFEST).map((packId) =>
          services.packs.status(packId as SpeechPackId),
        ),
      })
    } catch (error) {
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/v2/speech/packs/:packId", async (request, reply) => {
    try {
      return ok({ pack: services.packs.status(parseSpeechPackId(request.params)) })
    } catch (error) {
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/v2/speech/packs/:packId/install", async (request, reply) => {
    try {
      const packId = parseSpeechPackId(request.params)
      await services.packs.install(packId)
      return ok({ pack: services.packs.status(packId) })
    } catch (error) {
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.delete("/api/v2/speech/packs/:packId", async (request, reply) => {
    try {
      const packId = parseSpeechPackId(request.params)
      services.packs.remove(packId)
      return ok({ removedPackId: packId, pack: services.packs.status(packId) })
    } catch (error) {
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/v2/projects/:projectId/flows/:flowId/speech/artifacts", async (request, reply) => {
    try {
      const scope = parse(flowParamsSchema, request.params, "invalid_route_params")
      await services.persistence.requireFlowScope(scope)
      const upload = await request.file({ limits: { files: 1, fileSize: maxUploadBytes } })
      if (!upload) {
        throw new SocratesError("v2_audio_file_required", "Upload one audio recording.", { recoverable: true })
      }
      const mimeType = upload.mimetype.toLowerCase()
      if (!SUPPORTED_AUDIO_MIME_TYPES.has(mimeType)) {
        throw new SocratesError("v2_audio_type_not_supported", "That audio format is not supported for transcription.", {
          details: { mimeType, supportedMimeTypes: [...SUPPORTED_AUDIO_MIME_TYPES] },
          recoverable: true,
        })
      }
      const data = await upload.toBuffer()
      if (data.byteLength === 0) {
        throw new SocratesError("v2_audio_empty", "The recording is empty.", { recoverable: true })
      }
      if (data.byteLength > maxUploadBytes) {
        throw new SocratesError("v2_audio_too_large", "The recording exceeds the speech upload limit.", {
          details: { maxBytes: maxUploadBytes, receivedBytes: data.byteLength },
          recoverable: true,
        })
      }
      const artifact = v2ArtifactSchema.parse(await services.persistence.createSpeechArtifact({
        ...scope,
        kind: "speech_input",
        fileName: safeUploadName(upload.filename),
        mimeType,
        data,
      }))
      return ok({ artifact })
    } catch (error) {
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/v2/projects/:projectId/flows/:flowId/speech/jobs", async (request, reply) => {
    const scopeResult = flowParamsSchema.safeParse(request.params)
    let job: V2SpeechJob | undefined
    try {
      const scope = parse(flowParamsSchema, request.params, "invalid_route_params")
      await services.persistence.requireFlowScope(scope)
      const input = parse(v2CreateSpeechJobRequestSchema, request.body, "invalid_request") as V2CreateSpeechJobRequest
      job = v2SpeechJobSchema.parse(await services.persistence.createSpeechJob({ ...scope, request: input }))
      const completed = await executeSpeechJob(services, scope, input, job, now)
      return ok(v2CreateSpeechJobResponseSchema.parse({ job: completed }))
    } catch (error) {
      if (job && scopeResult.success) await failCreatedJob(services, scopeResult.data, job, error, now)
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/v2/projects/:projectId/flows/:flowId/speech/jobs/:jobId", async (request, reply) => {
    try {
      const { jobId, ...scope } = parse(jobParamsSchema, request.params, "invalid_route_params")
      await services.persistence.requireFlowScope(scope)
      return ok({ job: v2SpeechJobSchema.parse(await services.persistence.getSpeechJob({ ...scope, jobId })) })
    } catch (error) {
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/v2/projects/:projectId/flows/:flowId/speech/artifacts/:artifactId/content", async (request, reply) => {
    try {
      const { artifactId, ...scope } = parse(artifactParamsSchema, request.params, "invalid_route_params")
      await services.persistence.requireFlowScope(scope)
      const content = await services.persistence.readSpeechArtifact({ ...scope, artifactId })
      const data = readArtifactBytes(content)
      return reply
        .type(content.artifact.mimeType ?? "application/octet-stream")
        .header("content-disposition", "inline; filename=\"socrates-speech.wav\"")
        .send(data)
    } catch (error) {
      const { statusCode, response } = routeError(error)
      return reply.code(statusCode).send(response)
    }
  })
}

export const V2_SPEECH_HOSTED_MODEL_ALLOWLIST = V2_OPENROUTER_STT_MODEL_IDS
