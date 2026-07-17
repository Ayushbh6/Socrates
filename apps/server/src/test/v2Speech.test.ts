import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Fastify, { type FastifyInstance } from "fastify"
import multipart from "@fastify/multipart"
import { afterEach, describe, expect, it, vi } from "vitest"
import type {
  V2Artifact,
  V2CreateSpeechJobRequest,
  V2SpeechJob,
} from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import {
  registerV2SpeechRoutes,
  type V2SpeechArtifactContent,
  type V2SpeechJobUpdate,
  type V2SpeechPersistence,
  type V2SpeechRouteServices,
} from "../routes/v2SpeechRoutes"
import {
  LocalKokoroSynthesizer,
  LocalWhisperTranscriber,
  OpenRouterTranscriber,
  SpeechPackManager,
  V2_SPEECH_PACK_MANIFEST,
  type SpeechPackId,
  type SpeechTranscription,
} from "../services/v2/speech"

const PROJECT_ID = "project_v2_speech"
const FLOW_ID = "flow_v2_speech"
const CREATED_AT = "2026-07-17T12:00:00.000Z"

const multipartFile = (boundary: string, input: { name: string; mimeType: string; data: Buffer }): Buffer =>
  Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.name}"\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
    input.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])

class FakeV2SpeechPersistence implements V2SpeechPersistence {
  readonly artifacts = new Map<string, V2SpeechArtifactContent>()
  readonly jobs = new Map<string, V2SpeechJob>()
  readonly updates: Array<{ jobId: string; update: V2SpeechJobUpdate }> = []
  private nextArtifact = 1
  private nextJob = 1

  requireFlowScope(input: { projectId: string; flowId: string }): void {
    if (input.projectId !== PROJECT_ID || input.flowId !== FLOW_ID) {
      throw new SocratesError("v2_flow_not_found", "Flow not found.")
    }
  }

  createSpeechArtifact(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    kind: "speech_input" | "speech_output"
    fileName: string
    mimeType: string
    data: Buffer
  }): V2Artifact {
    this.requireFlowScope(input)
    const id = `v2artifact_${this.nextArtifact++}`
    const artifact: V2Artifact = {
      id,
      flowId: input.flowId,
      projectId: input.projectId,
      ...(input.goalId ? { goalId: input.goalId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      kind: input.kind,
      uri: `.socrates/v2/speech/${input.fileName}`,
      contentHash: crypto.createHash("sha256").update(input.data).digest("hex"),
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
      createdAt: CREATED_AT,
    }
    this.artifacts.set(id, { artifact, data: Buffer.from(input.data) })
    return artifact
  }

  readSpeechArtifact(input: { projectId: string; flowId: string; artifactId: string }): V2SpeechArtifactContent {
    this.requireFlowScope(input)
    const artifact = this.artifacts.get(input.artifactId)
    if (!artifact) throw new SocratesError("v2_artifact_not_found", "Speech artifact not found.")
    return artifact
  }

  createSpeechJob(input: {
    projectId: string
    flowId: string
    request: V2CreateSpeechJobRequest
  }): V2SpeechJob {
    this.requireFlowScope(input)
    const id = `v2speech_${this.nextJob++}`
    const common = {
      id,
      projectId: input.projectId,
      flowId: input.flowId,
      ...(input.request.goalId ? { goalId: input.request.goalId } : {}),
      ...(input.request.turnId ? { turnId: input.request.turnId } : {}),
      ...(input.request.messageId ? { messageId: input.request.messageId } : {}),
      ...(input.request.language ? { language: input.request.language } : {}),
      status: "queued" as const,
      createdAt: CREATED_AT,
    }
    const job: V2SpeechJob = input.request.engine === "local_kokoro"
      ? {
          ...common,
          kind: "synthesis",
          engine: "local_kokoro",
          modelId: "kokoro-82m",
          inputText: input.request.inputText,
          voiceId: input.request.voiceId,
          speed: input.request.speed,
        }
      : input.request.engine === "local_whisper"
        ? {
            ...common,
            kind: "transcription",
            engine: "local_whisper",
            modelId: input.request.modelId,
            inputArtifactId: input.request.inputArtifactId,
          }
        : {
            ...common,
            kind: "transcription",
            engine: "openrouter",
            modelId: input.request.modelId,
            inputArtifactId: input.request.inputArtifactId,
          }
    this.jobs.set(id, job)
    return job
  }

  updateSpeechJob(input: {
    projectId: string
    flowId: string
    jobId: string
    update: V2SpeechJobUpdate
  }): V2SpeechJob {
    this.requireFlowScope(input)
    const current = this.jobs.get(input.jobId)
    if (!current) throw new SocratesError("v2_speech_job_not_found", "Speech job not found.")
    this.updates.push({ jobId: input.jobId, update: input.update })
    const next = {
      ...current,
      ...("status" in input.update ? { status: input.update.status } : {}),
      ...("startedAt" in input.update ? { startedAt: input.update.startedAt } : {}),
      ...("completedAt" in input.update ? { completedAt: input.update.completedAt } : {}),
      ...("durationMs" in input.update ? { durationMs: input.update.durationMs } : {}),
      ...("transcriptText" in input.update ? { transcriptText: input.update.transcriptText } : {}),
      ...("outputArtifactId" in input.update ? { outputArtifactId: input.update.outputArtifactId } : {}),
      ...("error" in input.update ? { errorId: `v2error_${input.jobId}` } : {}),
    } as V2SpeechJob
    this.jobs.set(input.jobId, next)
    return next
  }

  getSpeechJob(input: { projectId: string; flowId: string; jobId: string }): V2SpeechJob {
    this.requireFlowScope(input)
    const job = this.jobs.get(input.jobId)
    if (!job) throw new SocratesError("v2_speech_job_not_found", "Speech job not found.")
    return job
  }
}

type TestRuntime = {
  app: FastifyInstance
  persistence: FakeV2SpeechPersistence
  packs: {
    installed: Set<SpeechPackId>
    install: ReturnType<typeof vi.fn>
    remove: ReturnType<typeof vi.fn>
    status: (id: SpeechPackId) => { id: SpeechPackId; installed: boolean; verified: boolean; path: string }
  }
  localTranscribe: ReturnType<typeof vi.fn>
  hostedTranscribe: ReturnType<typeof vi.fn>
  synthesize: ReturnType<typeof vi.fn>
}

const runtimes: TestRuntime[] = []

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map(({ app }) => app.close()))
})

const createRuntime = async (overrides: Partial<V2SpeechRouteServices> = {}): Promise<TestRuntime> => {
  const persistence = new FakeV2SpeechPersistence()
  const installed = new Set<SpeechPackId>()
  const packs = {
    installed,
    status: (id: SpeechPackId) => ({
      id,
      installed: installed.has(id),
      verified: installed.has(id),
      path: `/models/${id}`,
    }),
    install: vi.fn(async (id: SpeechPackId) => {
      installed.add(id)
      return `/models/${id}`
    }),
    remove: vi.fn((id: SpeechPackId) => {
      installed.delete(id)
    }),
  }
  const localTranscribe = vi.fn(async (): Promise<SpeechTranscription> => ({
    text: "A precise local transcript.",
    providerId: "local_whisper",
    modelId: "small.en",
  }))
  const hostedTranscribe = vi.fn(async (): Promise<SpeechTranscription> => ({
    text: "A precise hosted transcript.",
    providerId: "openrouter",
    modelId: "nvidia/parakeet-tdt-0.6b-v3",
    durationSeconds: 1.25,
    usage: { totalTokens: 17, costUsd: 0.001 },
  }))
  const synthesize = vi.fn(async (input: { outputPath: string; text: string }) => {
    fs.writeFileSync(input.outputPath, Buffer.from("RIFF-local-kokoro-audio"))
    return { outputPath: input.outputPath, sampleRate: 24_000 as const, sourceTextHash: "hash" }
  })
  const app = Fastify({ logger: false })
  await app.register(multipart, { limits: { files: 2, fileSize: 50 * 1024 * 1024 } })
  await registerV2SpeechRoutes(app, {
    persistence,
    packs,
    localWhisper: { transcribe: localTranscribe },
    openRouter: { transcribe: hostedTranscribe },
    kokoro: { synthesize },
    now: () => CREATED_AT,
    ...overrides,
  })
  const runtime = { app, persistence, packs, localTranscribe, hostedTranscribe, synthesize }
  runtimes.push(runtime)
  return runtime
}

const uploadAudio = async (
  runtime: TestRuntime,
  input: { name?: string; mimeType?: string; data?: Buffer } = {},
): Promise<V2Artifact> => {
  const boundary = "socrates-v2-speech-boundary"
  const response = await runtime.app.inject({
    method: "POST",
    url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/artifacts`,
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipartFile(boundary, {
      name: input.name ?? "recording.wav",
      mimeType: input.mimeType ?? "audio/wav",
      data: input.data ?? Buffer.from("RIFF-test-audio"),
    }),
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { data: { artifact: V2Artifact } }).data.artifact
}

describe("V2 speech HTTP routes", () => {
  it("exposes only explicit, verified speech pack lifecycle operations", async () => {
    const runtime = await createRuntime()
    const list = await runtime.app.inject({ method: "GET", url: "/api/v2/speech/packs" })
    expect(list.statusCode).toBe(200)
    expect((list.json() as { data: { packs: Array<{ id: string }> } }).data.packs.map((pack) => pack.id)).toEqual([
      "whisper-base.en",
      "whisper-small.en",
      "kokoro-en-v0_19",
    ])

    const installed = await runtime.app.inject({ method: "POST", url: "/api/v2/speech/packs/whisper-small.en/install" })
    expect(installed.statusCode).toBe(200)
    expect(installed.json()).toMatchObject({ data: { pack: { id: "whisper-small.en", verified: true } } })
    expect(runtime.packs.install).toHaveBeenCalledWith("whisper-small.en")

    const removed = await runtime.app.inject({ method: "DELETE", url: "/api/v2/speech/packs/whisper-small.en" })
    expect(removed.statusCode).toBe(200)
    expect(removed.json()).toMatchObject({ data: { removedPackId: "whisper-small.en", pack: { verified: false } } })

    const unavailable = await runtime.app.inject({ method: "POST", url: "/api/v2/speech/packs/whisper-tiny.en/install" })
    expect(unavailable.statusCode).toBe(404)
    expect(unavailable.json()).toMatchObject({ ok: false, error: { code: "v2_speech_pack_not_found" } })
  })

  it("stores uploaded recordings through the V2 artifact adapter", async () => {
    const runtime = await createRuntime()
    const artifact = await uploadAudio(runtime)
    expect(artifact).toMatchObject({
      flowId: FLOW_ID,
      projectId: PROJECT_ID,
      kind: "speech_input",
      mimeType: "audio/wav",
      sizeBytes: 15,
    })
    expect(runtime.persistence.artifacts.get(artifact.id)?.data?.toString()).toBe("RIFF-test-audio")

    const boundary = "unsupported-audio-boundary"
    const rejected = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/artifacts`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartFile(boundary, { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("not audio") }),
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.json()).toMatchObject({ ok: false, error: { code: "v2_audio_type_not_supported" } })
  })

  it("runs an allowlisted OpenRouter model and records hosted usage without calling local Whisper", async () => {
    const runtime = await createRuntime()
    const artifact = await uploadAudio(runtime, { name: "recording.webm", mimeType: "audio/webm" })
    const response = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/jobs`,
      payload: {
        kind: "transcription",
        engine: "openrouter",
        modelId: "nvidia/parakeet-tdt-0.6b-v3",
        inputArtifactId: artifact.id,
        language: "en",
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: { job: { engine: "openrouter", status: "completed", transcriptText: "A precise hosted transcript." } },
    })
    expect(runtime.hostedTranscribe).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "nvidia/parakeet-tdt-0.6b-v3",
      format: "audio/webm",
      language: "en",
    }))
    expect(runtime.localTranscribe).not.toHaveBeenCalled()
    expect(runtime.persistence.updates.at(-1)?.update).toMatchObject({
      status: "completed",
      usage: { totalTokens: 17, costUsd: 0.001 },
    })
  })

  it("rejects non-allowlisted hosted models before creating a job", async () => {
    const runtime = await createRuntime()
    const artifact = await uploadAudio(runtime)
    const response = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/jobs`,
      payload: {
        kind: "transcription",
        engine: "openrouter",
        modelId: "openai/whisper-1",
        inputArtifactId: artifact.id,
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ ok: false, error: { code: "invalid_request" } })
    expect(runtime.persistence.jobs.size).toBe(0)
    expect(runtime.hostedTranscribe).not.toHaveBeenCalled()
    expect(runtime.localTranscribe).not.toHaveBeenCalled()
  })

  it("persists a failed hosted job and never falls back to the local engine", async () => {
    const runtime = await createRuntime()
    const artifact = await uploadAudio(runtime)
    runtime.hostedTranscribe.mockRejectedValueOnce(new SocratesError("v2_stt_failed", "Hosted service unavailable."))
    const response = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/jobs`,
      payload: {
        kind: "transcription",
        engine: "openrouter",
        modelId: "microsoft/mai-transcribe-1.5",
        inputArtifactId: artifact.id,
      },
    })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toMatchObject({ ok: false, error: { code: "v2_stt_failed" } })
    expect(runtime.localTranscribe).not.toHaveBeenCalled()
    expect([...runtime.persistence.jobs.values()][0]).toMatchObject({ status: "failed", errorId: expect.any(String) })
  })

  it("returns an explicit local-format error and never calls OpenRouter", async () => {
    const runtime = await createRuntime()
    const artifact = await uploadAudio(runtime, { name: "recording.webm", mimeType: "audio/webm" })
    const response = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/jobs`,
      payload: {
        kind: "transcription",
        engine: "local_whisper",
        modelId: "small.en",
        inputArtifactId: artifact.id,
      },
    })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toMatchObject({ ok: false, error: { code: "v2_local_stt_wav_required" } })
    expect(runtime.localTranscribe).not.toHaveBeenCalled()
    expect(runtime.hostedTranscribe).not.toHaveBeenCalled()
    expect([...runtime.persistence.jobs.values()][0]).toMatchObject({ status: "failed" })
  })

  it("runs local Whisper only for normalized WAV artifacts", async () => {
    const runtime = await createRuntime()
    const artifact = await uploadAudio(runtime)
    const response = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/jobs`,
      payload: {
        kind: "transcription",
        engine: "local_whisper",
        modelId: "base.en",
        inputArtifactId: artifact.id,
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: { job: { engine: "local_whisper", status: "completed", transcriptText: "A precise local transcript." } },
    })
    const call = runtime.localTranscribe.mock.calls[0]?.[0] as { modelId: string; wavPath: string }
    expect(call.modelId).toBe("base.en")
    expect(path.extname(call.wavPath)).toBe(".wav")
    expect(runtime.hostedTranscribe).not.toHaveBeenCalled()
  })

  it("synthesizes Kokoro audio into a V2 output artifact and serves it", async () => {
    const runtime = await createRuntime()
    const response = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/jobs`,
      payload: {
        kind: "synthesis",
        engine: "local_kokoro",
        modelId: "kokoro-82m",
        inputText: "This is the natural read-aloud version.",
        voiceId: "speaker-3",
        speed: 1.05,
      },
    })
    expect(response.statusCode).toBe(200)
    const job = (response.json() as { data: { job: V2SpeechJob } }).data.job
    expect(job).toMatchObject({ engine: "local_kokoro", status: "completed", outputArtifactId: expect.any(String) })
    expect(runtime.synthesize).toHaveBeenCalledWith(expect.objectContaining({ speakerId: 3, speed: 1.05 }))

    const outputArtifactId = "outputArtifactId" in job ? job.outputArtifactId : undefined
    expect(outputArtifactId).toBeTruthy()
    const audio = await runtime.app.inject({
      method: "GET",
      url: `/api/v2/projects/${PROJECT_ID}/flows/${FLOW_ID}/speech/artifacts/${outputArtifactId}/content`,
    })
    expect(audio.statusCode).toBe(200)
    expect(audio.headers["content-type"]).toContain("audio/wav")
    expect(audio.rawPayload.toString()).toBe("RIFF-local-kokoro-audio")
  })
})

describe("V2 speech engine boundaries", () => {
  it("sends the official OpenRouter transcription shape only for an exact allowlisted model", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      text: "Hosted response",
      usage: { seconds: 2.5, total_tokens: 11, cost: 0.002 },
    }), { status: 200, headers: { "content-type": "application/json" } }))
    const transcriber = new OpenRouterTranscriber({ getApiKey: () => "openrouter-key" }, request)
    const result = await transcriber.transcribe({
      modelId: "mistralai/voxtral-mini-transcribe",
      audio: Buffer.from("audio"),
      format: "audio/x-wav",
      language: "en",
    })
    expect(result).toMatchObject({
      text: "Hosted response",
      providerId: "openrouter",
      modelId: "mistralai/voxtral-mini-transcribe",
      durationSeconds: 2.5,
      usage: { totalTokens: 11, costUsd: 0.002 },
    })
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://openrouter.ai/api/v1/audio/transcriptions")
    expect(init).toMatchObject({ method: "POST", headers: { authorization: "Bearer openrouter-key" } })
    expect(JSON.parse(String(init.body))).toEqual({
      input_audio: { data: Buffer.from("audio").toString("base64"), format: "wav" },
      model: "mistralai/voxtral-mini-transcribe",
      language: "en",
    })

    await expect(transcriber.transcribe({
      modelId: "openai/whisper-1",
      audio: Buffer.from("audio"),
      format: "wav",
    })).rejects.toMatchObject({ code: "v2_stt_model_not_allowed" })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("fails explicitly when hosted credentials or local runtimes are missing", async () => {
    const request = vi.fn()
    const hosted = new OpenRouterTranscriber({ getApiKey: () => undefined }, request as unknown as typeof fetch)
    await expect(hosted.transcribe({
      modelId: "nvidia/parakeet-tdt-0.6b-v3",
      audio: Buffer.from("audio"),
      format: "wav",
    })).rejects.toMatchObject({ code: "openrouter_credential_missing" })
    expect(request).not.toHaveBeenCalled()

    const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-speech-missing-"))
    const missingModelPath = path.join(missingRoot, "ggml-small.en.bin")
    const missingRecordingPath = path.join(missingRoot, "recording.wav")
    fs.writeFileSync(missingModelPath, "model")
    fs.writeFileSync(missingRecordingPath, "RIFF-recording")
    const whisper = new LocalWhisperTranscriber({
      binaryPath: path.join(missingRoot, "whisper-cli"),
      modelPath: () => missingModelPath,
      nativeRuntime: null,
    })
    await expect(whisper.transcribe({
      modelId: "small.en",
      wavPath: missingRecordingPath,
    })).rejects.toMatchObject({ code: "v2_whisper_runtime_missing" })

    const kokoro = new LocalKokoroSynthesizer({
      binaryPath: path.join(missingRoot, "sherpa-onnx-offline-tts"),
      modelDirectory: path.join(missingRoot, "kokoro"),
      nativeRuntime: null,
    })
    await expect(kokoro.synthesize({
      text: "Read this aloud.",
      outputPath: path.join(missingRoot, "out.wav"),
    })).rejects.toMatchObject({ code: "v2_kokoro_runtime_missing" })
    fs.rmSync(missingRoot, { recursive: true, force: true })
  })

  it("runs Whisper through the bundled native Node runtime without an external CLI", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-whisper-native-"))
    const modelPath = path.join(root, "ggml-base.en.bin")
    const recordingPath = path.join(root, "recording.wav")
    fs.writeFileSync(modelPath, "model")
    fs.writeFileSync(recordingPath, "RIFF-recording")
    const stop = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    const transcribeFile = vi.fn(() => ({
      stop,
      promise: Promise.resolve({
        result: "  A native local transcript.  ",
        segments: [{ text: "A native local transcript.", t0: 0, t1: 10 }],
        isAborted: false,
      }),
    }))
    const initWhisper = vi.fn(async () => ({ transcribeFile, release }))
    const whisper = new LocalWhisperTranscriber({
      binaryPath: path.join(root, "missing-whisper-cli"),
      modelPath: () => modelPath,
      nativeRuntime: { initWhisper } as never,
    })

    await expect(whisper.transcribe({ modelId: "base.en", wavPath: recordingPath })).resolves.toEqual({
      text: "A native local transcript.",
      providerId: "local_whisper",
      modelId: "base.en",
    })
    expect(initWhisper).toHaveBeenCalledWith({
      filePath: modelPath,
      useGpu: process.platform === "darwin" && process.arch === "arm64",
      useFlashAttn: false,
    })
    expect(transcribeFile).toHaveBeenCalledWith(recordingPath, expect.objectContaining({
      language: "en",
      temperature: 0,
      maxThreads: expect.any(Number),
    }))
    expect(stop).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledTimes(1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("honors an explicit Whisper CLI override and retains CLI fallback for a native load failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-whisper-cli-"))
    const binaryPath = path.join(root, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli")
    const modelPath = path.join(root, "ggml-small.en.bin")
    const recordingPath = path.join(root, "recording.wav")
    for (const filePath of [binaryPath, modelPath, recordingPath]) fs.writeFileSync(filePath, "fixture")
    const cliRunner = vi.fn(async (_command: string, args: string[]) => {
      const outputIndex = args.indexOf("-of")
      fs.writeFileSync(`${args[outputIndex + 1]}.txt`, "CLI local transcript.\n")
    })
    const nativeRuntime = { initWhisper: vi.fn(async () => { throw new Error("native addon unavailable") }) }

    const explicitCli = new LocalWhisperTranscriber({
      binaryPath,
      modelPath: () => modelPath,
      nativeRuntime: nativeRuntime as never,
      preferCli: true,
      cliRunner,
    })
    await expect(explicitCli.transcribe({ modelId: "small.en", wavPath: recordingPath })).resolves.toMatchObject({
      text: "CLI local transcript.",
      providerId: "local_whisper",
    })
    expect(nativeRuntime.initWhisper).not.toHaveBeenCalled()

    const fallbackCli = new LocalWhisperTranscriber({
      binaryPath,
      modelPath: () => modelPath,
      nativeRuntime: nativeRuntime as never,
      cliRunner,
    })
    await expect(fallbackCli.transcribe({ modelId: "small.en", wavPath: recordingPath })).resolves.toMatchObject({
      text: "CLI local transcript.",
      providerId: "local_whisper",
    })
    expect(nativeRuntime.initWhisper).toHaveBeenCalledTimes(1)
    expect(cliRunner).toHaveBeenCalledTimes(2)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("runs Kokoro through the bundled native Node runtime without an external CLI", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-kokoro-native-"))
    const modelDirectory = path.join(root, "kokoro")
    fs.mkdirSync(path.join(modelDirectory, "espeak-ng-data"), { recursive: true })
    for (const fileName of ["model.onnx", "voices.bin", "tokens.txt"]) {
      fs.writeFileSync(path.join(modelDirectory, fileName), fileName)
    }
    const generateAsync = vi.fn(async () => ({ samples: new Float32Array([0, 0.25, -0.25]), sampleRate: 24_000 }))
    const createAsync = vi.fn(async () => ({ generateAsync }))
    class GenerationConfig {
      constructor(readonly input: unknown) {}
    }
    const nativeRuntime = {
      OfflineTts: { createAsync },
      GenerationConfig,
      writeWave: vi.fn((fileName: string) => fs.writeFileSync(fileName, "RIFF-native-kokoro")),
    }
    const synthesizer = new LocalKokoroSynthesizer({
      binaryPath: path.join(root, "missing-cli"),
      modelDirectory,
      nativeRuntime: nativeRuntime as never,
    })
    const firstOutput = path.join(root, "first.wav")
    const secondOutput = path.join(root, "second.wav")
    await expect(synthesizer.synthesize({ text: "A calm local voice.", outputPath: firstOutput, speakerId: 6, speed: 1.1 })).resolves.toMatchObject({
      outputPath: firstOutput,
      sampleRate: 24_000,
    })
    await synthesizer.synthesize({ text: "The model stays warm.", outputPath: secondOutput })
    expect(createAsync).toHaveBeenCalledTimes(1)
    expect(generateAsync).toHaveBeenCalledTimes(2)
    expect(nativeRuntime.writeWave).toHaveBeenCalledTimes(2)
    expect(fs.readFileSync(firstOutput, "utf8")).toBe("RIFF-native-kokoro")
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("reports, reuses, and removes an explicitly installed verified pack", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-speech-pack-"))
    const entry = V2_SPEECH_PACK_MANIFEST["whisper-base.en"]
    const packDirectory = path.join(home, "models", "speech", entry.id, entry.version)
    fs.mkdirSync(packDirectory, { recursive: true })
    fs.writeFileSync(path.join(packDirectory, entry.installedFile), "verified-by-install-time-checksum")
    fs.writeFileSync(path.join(packDirectory, "receipt.json"), JSON.stringify({
      id: entry.id,
      version: entry.version,
      sha256: entry.sha256,
    }))
    const request = vi.fn()
    const manager = new SpeechPackManager(home, request as unknown as typeof fetch)
    expect(manager.status(entry.id)).toMatchObject({ installed: true, verified: true })
    await expect(manager.install(entry.id)).resolves.toBe(path.join(packDirectory, entry.installedFile))
    expect(request).not.toHaveBeenCalled()
    manager.remove(entry.id)
    expect(manager.status(entry.id)).toMatchObject({ installed: false, verified: false })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it("downloads a pack once, verifies bytes and checksum, and removes corrupt staging data", async () => {
    const payload = Buffer.from("small deterministic whisper model fixture")
    const fixtureEntry = {
      ...V2_SPEECH_PACK_MANIFEST["whisper-base.en"],
      version: "fixture-v1",
      url: "https://models.invalid/whisper-fixture.bin",
      expectedBytes: payload.byteLength,
      sha256: crypto.createHash("sha256").update(payload).digest("hex"),
    }
    const manifest = {
      ...V2_SPEECH_PACK_MANIFEST,
      "whisper-base.en": fixtureEntry,
    }
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-speech-install-"))
    const request = vi.fn(async () => new Response(payload, { status: 200 }))
    const manager = new SpeechPackManager(home, request, manifest)
    const [first, second] = await Promise.all([
      manager.install("whisper-base.en"),
      manager.install("whisper-base.en"),
    ])
    expect(first).toBe(second)
    expect(request).toHaveBeenCalledTimes(1)
    expect(fs.readFileSync(first)).toEqual(payload)
    expect(manager.status("whisper-base.en")).toMatchObject({ installed: true, verified: true })

    const corruptHome = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-speech-corrupt-"))
    const corruptManager = new SpeechPackManager(
      corruptHome,
      vi.fn(async () => new Response(Buffer.from("tampered"), { status: 200 })),
      manifest,
    )
    await expect(corruptManager.install("whisper-base.en")).rejects.toMatchObject({
      code: "v2_speech_pack_integrity_failed",
    })
    expect(corruptManager.status("whisper-base.en")).toMatchObject({ installed: false, verified: false })
    const speechRoot = corruptManager.root()
    expect(fs.existsSync(speechRoot) ? fs.readdirSync(speechRoot).filter((name) => name.includes(".installing-")) : []).toEqual([])

    fs.rmSync(home, { recursive: true, force: true })
    fs.rmSync(corruptHome, { recursive: true, force: true })
  })
})
