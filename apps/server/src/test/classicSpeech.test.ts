import fs from "node:fs"
import Fastify from "fastify"
import multipart from "@fastify/multipart"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerClassicSpeechRoutes } from "../routes/classicSpeechRoutes"

const boundary = "socrates-classic-speech-test"

const wavMultipart = (data: Buffer): Buffer => Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
  data,
  Buffer.from(`\r\n--${boundary}--\r\n`),
])

describe("Classic conversation speech transcription", () => {
  const apps: ReturnType<typeof Fastify>[] = []

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()))
  })

  it("transcribes temporary WAV audio without requiring V2 flow persistence", async () => {
    const app = Fastify()
    apps.push(app)
    await app.register(multipart)
    const requireConversationScope = vi.fn()
    const localTranscribe = vi.fn(async ({ wavPath }: { wavPath: string }) => {
      expect(fs.existsSync(wavPath)).toBe(true)
      return {
        text: "A spoken Classic draft",
        providerId: "local_whisper" as const,
        modelId: "small.en",
        durationSeconds: 1.25,
      }
    })
    await registerClassicSpeechRoutes(app, {
      requireConversationScope,
      localWhisper: { transcribe: localTranscribe },
      openRouter: { transcribe: vi.fn() },
    })

    const response = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/conversations/conversation-1/speech/transcribe?engine=local_whisper&modelId=small.en",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: wavMultipart(Buffer.from("RIFF-test-wav")),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      ok: true,
      data: {
        transcriptText: "A spoken Classic draft",
        engine: "local_whisper",
        modelId: "small.en",
        durationSeconds: 1.25,
      },
    })
    expect(requireConversationScope).toHaveBeenCalledWith({
      projectId: "project-1",
      conversationId: "conversation-1",
    })
    expect(localTranscribe).toHaveBeenCalledOnce()
  })
})
