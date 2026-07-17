import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { pipeline } from "node:stream/promises"
import { Readable, Transform } from "node:stream"
import type { ProviderCredentialResolver } from "@socrates/providers"
import { SocratesError } from "@socrates/shared"

export const V2_OPENROUTER_STT_MODELS = [
  "nvidia/parakeet-tdt-0.6b-v3",
  "microsoft/mai-transcribe-1.5",
  "mistralai/voxtral-mini-transcribe",
] as const

export type V2OpenRouterSttModel = (typeof V2_OPENROUTER_STT_MODELS)[number]
export type V2WhisperModel = "base.en" | "small.en"

export type SpeechTranscription = {
  text: string
  providerId: "local_whisper" | "openrouter"
  modelId: string
  durationSeconds?: number
  usage?: {
    inputTokens?: number
    outputTokens?: number
    totalTokens?: number
    costUsd?: number
  }
  raw?: unknown
}

type SherpaGeneratedAudio = { samples: Float32Array | number[]; sampleRate: number }
type SherpaOfflineTts = {
  generateAsync(input: {
    text: string
    enableExternalBuffer?: boolean
    generationConfig: unknown
    onProgress?: (progress: { samples: Float32Array | number[]; progress: number }) => number
  }): Promise<SherpaGeneratedAudio>
}
type SherpaKokoroRuntime = {
  OfflineTts: { createAsync(config: unknown): Promise<SherpaOfflineTts> }
  GenerationConfig: new (config: { sid: number; speed: number; silenceScale: number }) => unknown
  writeWave(fileName: string, audio: SherpaGeneratedAudio): void
}

type NativeWhisperResult = {
  result: string
  segments: Array<{ text: string; t0: number; t1: number }>
  isAborted: boolean
}
type NativeWhisperContext = {
  transcribeFile(filePath: string, options?: {
    language?: string
    temperature?: number
    maxThreads?: number
  }): {
    stop: () => Promise<void>
    promise: Promise<NativeWhisperResult>
  }
  release(): Promise<void>
}
type NativeWhisperRuntime = {
  initWhisper(options: {
    filePath: string
    useGpu?: boolean
    useFlashAttn?: boolean
  }): Promise<NativeWhisperContext>
}

type SpeechProcessRunner = (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
) => Promise<void>

const requireFromHere = createRequire(import.meta.url)

const openRouterSttModelSet = new Set<string>(V2_OPENROUTER_STT_MODELS)

export const isAllowedOpenRouterSttModel = (modelId: string): modelId is V2OpenRouterSttModel =>
  openRouterSttModelSet.has(modelId)

export class OpenRouterTranscriber {
  constructor(
    private readonly credentials: ProviderCredentialResolver,
    private readonly request: typeof fetch = fetch,
  ) {}

  async transcribe(input: {
    modelId: string
    audio: Buffer
    format: string
    language?: string
    signal?: AbortSignal
  }): Promise<SpeechTranscription> {
    if (!isAllowedOpenRouterSttModel(input.modelId)) {
      throw new SocratesError("v2_stt_model_not_allowed", "That hosted transcriber is not enabled for Socrates Flow.", {
        details: { modelId: input.modelId, allowedModelIds: V2_OPENROUTER_STT_MODELS },
        recoverable: true,
      })
    }
    const apiKey = this.credentials.getApiKey("openrouter")
    if (!apiKey) {
      throw new SocratesError("openrouter_credential_missing", "OpenRouter is not configured for hosted transcription.", {
        recoverable: true,
      })
    }

    const response = await this.request("https://openrouter.ai/api/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "x-title": "Socrates Flow",
      },
      body: JSON.stringify({
        input_audio: { data: input.audio.toString("base64"), format: normalizeAudioFormat(input.format) },
        model: input.modelId,
        ...(input.language ? { language: input.language } : {}),
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    })

    const raw = await response.json().catch(() => undefined) as
      | {
          text?: unknown
          usage?: {
            seconds?: unknown
            input_tokens?: unknown
            output_tokens?: unknown
            total_tokens?: unknown
            cost?: unknown
          }
          error?: { message?: unknown }
        }
      | undefined
    if (!response.ok || typeof raw?.text !== "string" || !raw.text.trim()) {
      throw new SocratesError("v2_stt_failed", response.ok ? "The hosted transcriber returned no text." : "Hosted transcription failed.", {
        details: {
          status: response.status,
          providerMessage: typeof raw?.error?.message === "string" ? raw.error.message : undefined,
        },
        recoverable: true,
      })
    }
    const usage = raw.usage
    return {
      text: raw.text.trim(),
      providerId: "openrouter",
      modelId: input.modelId,
      ...(typeof usage?.seconds === "number" ? { durationSeconds: usage.seconds } : {}),
      ...(usage
        ? {
            usage: {
              ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
              ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
              ...(typeof usage.total_tokens === "number" ? { totalTokens: usage.total_tokens } : {}),
              ...(typeof usage.cost === "number" ? { costUsd: usage.cost } : {}),
            },
          }
        : {}),
      raw,
    }
  }
}

export class LocalWhisperTranscriber {
  constructor(
    private readonly options: {
      binaryPath: string
      modelPath: (model: V2WhisperModel) => string
      timeoutMs?: number
      nativeRuntime?: NativeWhisperRuntime | null
      preferCli?: boolean
      cliRunner?: SpeechProcessRunner
    },
  ) {}

  async transcribe(input: {
    modelId: V2WhisperModel
    wavPath: string
    language?: string
    signal?: AbortSignal
  }): Promise<SpeechTranscription> {
    const binaryPath = path.resolve(this.options.binaryPath)
    const modelPath = path.resolve(this.options.modelPath(input.modelId))
    const wavPath = path.resolve(input.wavPath)
    requireReadableFile(modelPath, "v2_whisper_model_missing", `The Whisper ${input.modelId} model pack is not installed.`)
    requireReadableFile(wavPath, "v2_audio_missing", "The recorded audio file could not be found.")

    if (this.options.preferCli) {
      requireReadableFile(binaryPath, "v2_whisper_runtime_missing", "The configured local Whisper CLI is not installed.")
      return this.transcribeWithCli({ ...input, wavPath, binaryPath, modelPath })
    }

    const nativeRuntime = this.resolveNativeRuntime()
    if (nativeRuntime) {
      try {
        return await this.transcribeWithNativeRuntime(nativeRuntime, { ...input, wavPath, modelPath })
      } catch (error) {
        if (!(error instanceof SocratesError) || error.code !== "v2_whisper_runtime_missing" || !isReadableFile(binaryPath)) {
          throw error
        }
      }
    }

    if (!isReadableFile(binaryPath)) {
      throw new SocratesError("v2_whisper_runtime_missing", "The bundled local Whisper runtime is not installed.", {
        details: { nativePackage: "@fugood/whisper.node", binaryPath },
        recoverable: true,
      })
    }
    return this.transcribeWithCli({ ...input, wavPath, binaryPath, modelPath })
  }

  private resolveNativeRuntime(): NativeWhisperRuntime | undefined {
    if (this.options.nativeRuntime !== undefined) return this.options.nativeRuntime ?? undefined
    try {
      return requireFromHere("@fugood/whisper.node") as NativeWhisperRuntime
    } catch {
      return undefined
    }
  }

  private async transcribeWithNativeRuntime(runtime: NativeWhisperRuntime, input: {
    modelId: V2WhisperModel
    wavPath: string
    modelPath: string
    language?: string
    signal?: AbortSignal
  }): Promise<SpeechTranscription> {
    const timeoutMs = this.options.timeoutMs ?? 120_000
    let context: NativeWhisperContext | undefined
    let operation: ReturnType<NativeWhisperContext["transcribeFile"]> | undefined
    try {
      try {
        context = await raceSpeechOperation(runtime.initWhisper({
          filePath: input.modelPath,
          useGpu: process.platform === "darwin" && process.arch === "arm64",
          useFlashAttn: false,
        }), input.signal, timeoutMs)
      } catch (error) {
        if (error instanceof SocratesError) throw error
        throw new SocratesError("v2_whisper_runtime_missing", "The bundled local Whisper runtime could not load.", {
          details: { message: error instanceof Error ? error.message : String(error) },
          recoverable: true,
        })
      }

      operation = context.transcribeFile(input.wavPath, {
        language: input.language ?? "en",
        temperature: 0,
        maxThreads: Math.max(1, Math.min(8, os.availableParallelism?.() ?? os.cpus().length)),
      })
      const result = await raceSpeechOperation(operation.promise, input.signal, timeoutMs)
      const text = result.result.trim() || result.segments.map((segment) => segment.text.trim()).filter(Boolean).join(" ")
      if (!text) {
        throw new SocratesError("v2_stt_failed", "Local Whisper returned an empty transcript.", { recoverable: true })
      }
      return { text, providerId: "local_whisper", modelId: input.modelId }
    } catch (error) {
      if (operation) await settleSpeechCleanup(operation.stop())
      if (error instanceof SocratesError) throw error
      throw new SocratesError("v2_speech_runtime_failed", "The bundled local Whisper runtime did not complete.", {
        details: { message: error instanceof Error ? error.message : String(error) },
        recoverable: true,
      })
    } finally {
      if (context) await settleSpeechCleanup(context.release())
    }
  }

  private async transcribeWithCli(input: {
    modelId: V2WhisperModel
    wavPath: string
    binaryPath: string
    modelPath: string
    language?: string
    signal?: AbortSignal
  }): Promise<SpeechTranscription> {
    const runner = this.options.cliRunner ?? runProcess

    const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-whisper-"))
    const outputPrefix = path.join(outputDirectory, "transcript")
    try {
      await runner(
        input.binaryPath,
        [
          "-m",
          input.modelPath,
          "-f",
          input.wavPath,
          "-otxt",
          "-of",
          outputPrefix,
          "-np",
          ...(input.language ? ["-l", input.language] : []),
        ],
        { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: this.options.timeoutMs ?? 120_000 },
      )
      const transcriptPath = `${outputPrefix}.txt`
      requireReadableFile(transcriptPath, "v2_stt_failed", "Local Whisper did not produce a transcript.")
      const text = fs.readFileSync(transcriptPath, "utf8").trim()
      if (!text) {
        throw new SocratesError("v2_stt_failed", "Local Whisper returned an empty transcript.", { recoverable: true })
      }
      return { text, providerId: "local_whisper", modelId: input.modelId }
    } finally {
      fs.rmSync(outputDirectory, { recursive: true, force: true })
    }
  }
}

export class LocalKokoroSynthesizer {
  private nativeTts: Promise<SherpaOfflineTts> | undefined

  constructor(
    private readonly options: {
      binaryPath: string
      modelDirectory: string
      timeoutMs?: number
      nativeRuntime?: SherpaKokoroRuntime | null
    },
  ) {}

  async synthesize(input: {
    text: string
    outputPath: string
    speakerId?: number
    speed?: number
    signal?: AbortSignal
  }): Promise<{ outputPath: string; sampleRate: 24_000; sourceTextHash: string }> {
    const text = input.text.trim()
    if (!text) {
      throw new SocratesError("v2_tts_text_required", "There is no response text to read aloud.", { recoverable: true })
    }
    const modelDirectory = path.resolve(this.options.modelDirectory)
    const nativeRuntime = this.resolveNativeRuntime()
    const binaryPath = path.resolve(this.options.binaryPath)
    if (!nativeRuntime) {
      requireReadableFile(binaryPath, "v2_kokoro_runtime_missing", "The local Kokoro runtime is not installed.")
    }
    for (const relative of ["model.onnx", "voices.bin", "tokens.txt"]) {
      requireReadableFile(path.join(modelDirectory, relative), "v2_kokoro_model_missing", "The Kokoro model pack is incomplete.")
    }
    if (!fs.existsSync(path.join(modelDirectory, "espeak-ng-data"))) {
      throw new SocratesError("v2_kokoro_model_missing", "The Kokoro language data is missing.", { recoverable: true })
    }

    fs.mkdirSync(path.dirname(path.resolve(input.outputPath)), { recursive: true })
    if (nativeRuntime) {
      await this.synthesizeWithNativeRuntime(nativeRuntime, {
        text,
        modelDirectory,
        outputPath: path.resolve(input.outputPath),
        speakerId: Math.max(0, Math.min(10, input.speakerId ?? 3)),
        speed: Math.max(0.5, Math.min(2, input.speed ?? 1)),
        ...(input.signal ? { signal: input.signal } : {}),
      })
    } else {
      await runProcess(
        binaryPath,
        [
          `--kokoro-model=${path.join(modelDirectory, "model.onnx")}`,
          `--kokoro-voices=${path.join(modelDirectory, "voices.bin")}`,
          `--kokoro-tokens=${path.join(modelDirectory, "tokens.txt")}`,
          `--kokoro-data-dir=${path.join(modelDirectory, "espeak-ng-data")}`,
          "--num-threads=2",
          `--sid=${Math.max(0, Math.min(10, input.speakerId ?? 3))}`,
          `--speed=${Math.max(0.5, Math.min(2, input.speed ?? 1))}`,
          `--output-filename=${path.resolve(input.outputPath)}`,
          text,
        ],
        { ...(input.signal ? { signal: input.signal } : {}), timeoutMs: this.options.timeoutMs ?? 180_000 },
      )
    }
    requireReadableFile(path.resolve(input.outputPath), "v2_tts_failed", "Kokoro did not produce an audio file.")
    return {
      outputPath: path.resolve(input.outputPath),
      sampleRate: 24_000,
      sourceTextHash: crypto.createHash("sha256").update(text).digest("hex"),
    }
  }

  private resolveNativeRuntime(): SherpaKokoroRuntime | undefined {
    if (this.options.nativeRuntime !== undefined) return this.options.nativeRuntime ?? undefined
    try {
      return requireFromHere("sherpa-onnx-node") as SherpaKokoroRuntime
    } catch {
      return undefined
    }
  }

  private async synthesizeWithNativeRuntime(runtime: SherpaKokoroRuntime, input: {
    text: string
    modelDirectory: string
    outputPath: string
    speakerId: number
    speed: number
    signal?: AbortSignal
  }): Promise<void> {
    try {
      this.nativeTts ??= runtime.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: path.join(input.modelDirectory, "model.onnx"),
            voices: path.join(input.modelDirectory, "voices.bin"),
            tokens: path.join(input.modelDirectory, "tokens.txt"),
            dataDir: path.join(input.modelDirectory, "espeak-ng-data"),
          },
          debug: false,
          numThreads: 2,
          provider: "cpu",
        },
        maxNumSentences: 1,
      })
      const tts = await raceSpeechOperation(this.nativeTts, input.signal, this.options.timeoutMs ?? 180_000)
      const generationConfig = new runtime.GenerationConfig({
        sid: input.speakerId,
        speed: input.speed,
        silenceScale: 0.2,
      })
      const audio = await raceSpeechOperation(tts.generateAsync({
        text: input.text,
        enableExternalBuffer: true,
        generationConfig,
        onProgress: () => input.signal?.aborted ? 0 : 1,
      }), input.signal, this.options.timeoutMs ?? 180_000)
      runtime.writeWave(input.outputPath, audio)
    } catch (error) {
      if (error instanceof SocratesError) throw error
      throw new SocratesError("v2_speech_runtime_failed", "The local Kokoro runtime did not complete.", {
        details: { message: error instanceof Error ? error.message : String(error) },
        recoverable: true,
      })
    }
  }
}

export type SpeechPackId = "whisper-base.en" | "whisper-small.en" | "kokoro-en-v0_19"

export type SpeechPackManifestEntry = {
  id: SpeechPackId
  version: string
  url: string
  archive: "file" | "tar.bz2"
  expectedBytes: number
  sha256: string
  installedFile: string
}

export const V2_SPEECH_PACK_MANIFEST: Record<SpeechPackId, SpeechPackManifestEntry> = {
  "whisper-base.en": {
    id: "whisper-base.en",
    version: "ggml-main",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    archive: "file",
    expectedBytes: 147_964_211,
    sha256: "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002",
    installedFile: "ggml-base.en.bin",
  },
  "whisper-small.en": {
    id: "whisper-small.en",
    version: "ggml-main",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin",
    archive: "file",
    expectedBytes: 487_614_201,
    sha256: "c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d",
    installedFile: "ggml-small.en.bin",
  },
  "kokoro-en-v0_19": {
    id: "kokoro-en-v0_19",
    version: "v0_19",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2",
    archive: "tar.bz2",
    expectedBytes: 319_625_534,
    sha256: "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7",
    installedFile: "kokoro-en-v0_19/model.onnx",
  },
}

export class SpeechPackManager {
  private readonly installs = new Map<SpeechPackId, Promise<string>>()

  constructor(
    private readonly socratesHome: string,
    private readonly request: typeof fetch = fetch,
    private readonly manifest: Record<SpeechPackId, SpeechPackManifestEntry> = V2_SPEECH_PACK_MANIFEST,
  ) {}

  root(): string {
    return path.join(this.socratesHome, "models", "speech")
  }

  status(id: SpeechPackId): { id: SpeechPackId; installed: boolean; path: string; verified: boolean } {
    const entry = this.manifest[id]
    const directory = this.packDirectory(entry)
    const installedPath = path.join(directory, entry.installedFile)
    const receiptPath = path.join(directory, "receipt.json")
    let verified = false
    try {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8")) as { sha256?: unknown; version?: unknown }
      verified = receipt.sha256 === entry.sha256 && receipt.version === entry.version && fs.statSync(installedPath).isFile()
    } catch {
      verified = false
    }
    return { id, installed: verified, verified, path: installedPath }
  }

  install(id: SpeechPackId, signal?: AbortSignal): Promise<string> {
    const existing = this.installs.get(id)
    if (existing) return existing
    const operation = this.installOnce(this.manifest[id], signal).finally(() => this.installs.delete(id))
    this.installs.set(id, operation)
    return operation
  }

  remove(id: SpeechPackId): void {
    if (this.installs.has(id)) {
      throw new SocratesError("v2_speech_pack_busy", "The speech pack is still installing.", { recoverable: true })
    }
    fs.rmSync(this.packDirectory(this.manifest[id]), { recursive: true, force: true })
  }

  private async installOnce(entry: SpeechPackManifestEntry, signal?: AbortSignal): Promise<string> {
    const current = this.status(entry.id)
    if (current.verified) return current.path
    const directory = this.packDirectory(entry)
    const parent = path.dirname(directory)
    const tempDirectory = `${directory}.installing-${crypto.randomUUID()}`
    fs.mkdirSync(tempDirectory, { recursive: true })
    const downloadPath = path.join(tempDirectory, entry.archive === "file" ? entry.installedFile : "pack.tar.bz2")
    try {
      const response = await this.request(entry.url, { ...(signal ? { signal } : {}) })
      if (!response.ok || !response.body) {
        throw new SocratesError("v2_speech_pack_download_failed", `Could not download ${entry.id}.`, {
          details: { status: response.status },
          recoverable: true,
        })
      }
      const hash = crypto.createHash("sha256")
      let bytes = 0
      const verifier = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      await pipeline(Readable.fromWeb(response.body as never), verifier, fs.createWriteStream(downloadPath, { flags: "wx" }))
      const digest = hash.digest("hex")
      if (bytes !== entry.expectedBytes || digest !== entry.sha256) {
        throw new SocratesError("v2_speech_pack_integrity_failed", `The downloaded ${entry.id} pack failed integrity verification.`, {
          details: { expectedBytes: entry.expectedBytes, receivedBytes: bytes, expectedSha256: entry.sha256, receivedSha256: digest },
          recoverable: true,
        })
      }
      if (entry.archive === "tar.bz2") {
        await runProcess("tar", ["-xjf", downloadPath, "-C", tempDirectory], {
          ...(signal ? { signal } : {}),
          timeoutMs: 120_000,
        })
        fs.rmSync(downloadPath, { force: true })
      }
      const installedPath = path.join(tempDirectory, entry.installedFile)
      requireReadableFile(installedPath, "v2_speech_pack_invalid", `The ${entry.id} pack did not contain the expected files.`)
      fs.writeFileSync(
        path.join(tempDirectory, "receipt.json"),
        `${JSON.stringify({ id: entry.id, version: entry.version, sha256: entry.sha256, installedAt: new Date().toISOString() }, null, 2)}\n`,
        { flag: "wx" },
      )
      fs.mkdirSync(parent, { recursive: true })
      fs.rmSync(directory, { recursive: true, force: true })
      fs.renameSync(tempDirectory, directory)
      return path.join(directory, entry.installedFile)
    } catch (error) {
      fs.rmSync(tempDirectory, { recursive: true, force: true })
      throw error
    }
  }

  private packDirectory(entry: SpeechPackManifestEntry): string {
    return path.join(this.root(), entry.id, entry.version)
  }
}

const normalizeAudioFormat = (value: string): string => {
  const normalized = value.toLowerCase().replace(/^audio\//, "")
  if (normalized === "x-wav" || normalized === "wave") return "wav"
  if (normalized === "mpeg") return "mp3"
  if (normalized === "mp4") return "m4a"
  return normalized
}

const isReadableFile = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

const requireReadableFile = (filePath: string, code: string, message: string): void => {
  if (isReadableFile(filePath)) return
  throw new SocratesError(code, message, { details: { path: filePath }, recoverable: true })
}

const settleSpeechCleanup = async (operation: Promise<unknown>): Promise<void> => {
  await raceSpeechOperation(operation, undefined, 5_000).catch(() => undefined)
}

const raceSpeechOperation = <T>(operation: Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      callback()
    }
    const abort = () => finish(() => reject(new SocratesError(
      "v2_speech_cancelled",
      "The local speech operation was cancelled.",
      { recoverable: true },
    )))
    const timeout = setTimeout(() => finish(() => reject(new SocratesError(
      "v2_speech_runtime_timeout",
      "The local speech runtime exceeded its time limit.",
      { details: { timeoutMs }, recoverable: true },
    ))), timeoutMs)
    timeout.unref?.()
    if (signal?.aborted) {
      abort()
      return
    }
    signal?.addEventListener("abort", abort, { once: true })
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    )
  })

const runProcess = async (
  command: string,
  args: string[],
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<void> =>
  new Promise((resolve, reject) => {
    let stderr = ""
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true })
    const timeout = setTimeout(() => child.kill(), options.timeoutMs)
    const abort = () => child.kill()
    options.signal?.addEventListener("abort", abort, { once: true })
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_000) stderr += chunk.toString("utf8")
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
      reject(new SocratesError("v2_speech_runtime_failed", "The local speech runtime could not start.", {
        details: { command, message: error.message },
        recoverable: true,
      }))
    })
    child.once("exit", (code, signal) => {
      clearTimeout(timeout)
      options.signal?.removeEventListener("abort", abort)
      if (code === 0) {
        resolve()
        return
      }
      reject(new SocratesError("v2_speech_runtime_failed", "The local speech runtime did not complete.", {
        details: { command, code, signal, stderr: stderr.trim() || undefined },
        recoverable: true,
      }))
    })
  })
