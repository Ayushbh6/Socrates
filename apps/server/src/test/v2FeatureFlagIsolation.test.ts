import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import type { ApiResponse, Project, ProjectWorkspace, V2Artifact, V2FlowSnapshot } from "@socrates/contracts"
import { SocratesAgent } from "@socrates/core"
import type { EmbeddingProvider, ModelProvider } from "@socrates/providers"
import { buildServer } from "../app"

type TestServer = Awaited<ReturnType<typeof buildServer>>

const runningServers: TestServer[] = []
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((app) => app.close()))
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const testAgent = (): SocratesAgent => {
  const provider: ModelProvider = {
    async countTokens(request) {
      return {
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens: 1,
        baseTokens: 1,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }
    },
    async *stream() {
      yield { type: "model.completed" as const, usage: { totalTokens: 0 } }
    },
  }
  return new SocratesAgent(provider)
}

const testEmbeddings = (): EmbeddingProvider => ({
  async check() {
    return { ok: true, dimensions: 3, message: "Test embeddings are ready." }
  },
  async embed() {
    return { embeddings: [[0, 0, 1]], dimensions: 3 }
  },
  async embedMany(request) {
    return { embeddings: request.values.map(() => [0, 0, 1]), dimensions: 3 }
  },
})

const createRuntime = async (v2FlowEnabled: boolean) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `socrates-v2-flag-${v2FlowEnabled ? "on" : "off"}-`))
  temporaryRoots.push(root)
  const home = path.join(root, "home")
  const workspace = path.join(root, "workspace")
  const dbPath = path.join(root, "socrates.sqlite")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const app = await buildServer({
    dbPath,
    socratesHome: home,
    v2FlowEnabled,
    preserveTerminalsOnClose: false,
    agent: testAgent(),
    embeddingProvider: testEmbeddings(),
    titleProvider: false,
  })
  runningServers.push(app)
  return { app, root, home, workspace, dbPath }
}

const parse = <T>(payload: string): ApiResponse<T> => JSON.parse(payload) as ApiResponse<T>

const onboardAndCreateProject = async (
  runtime: Awaited<ReturnType<typeof createRuntime>>,
): Promise<{ project: Project; primaryWorkspace: ProjectWorkspace }> => {
  const onboarding = await runtime.app.inject({
    method: "POST",
    url: "/api/onboarding",
    payload: { displayName: "V2 Isolation Test" },
  })
  expect(onboarding.statusCode).toBe(200)
  expect(parse(onboarding.payload).ok).toBe(true)

  const response = await runtime.app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name: "V2 Flag Isolation",
      description: "A real workspace used only by the V2 integration test.",
      creationMode: "start_from_scratch",
      workspacePath: runtime.workspace,
    },
  })
  const body = parse<{ project: Project; primaryWorkspace: ProjectWorkspace }>(response.payload)
  expect(response.statusCode).toBe(200)
  expect(body.ok).toBe(true)
  if (!body.ok) throw new Error(`Classic project creation failed: ${body.error.message}`)
  return body.data
}

const multipartAudio = (boundary: string, data: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="voice-note.wav"\r\nContent-Type: audio/wav\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])

const tableCounts = (dbPath: string, tables: string[]): Record<string, number> => {
  const database = new Database(dbPath, { readonly: true })
  try {
    return Object.fromEntries(
      tables.map((table) => [
        table,
        Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count),
      ]),
    )
  } finally {
    database.close()
  }
}

describe("V2 app feature flag and Classic isolation", () => {
  it("keeps V2 Flow and speech routes unmounted while Classic remains usable", async () => {
    const runtime = await createRuntime(false)
    const capabilities = await runtime.app.inject({ method: "GET", url: "/api/v2/capabilities" })
    expect(capabilities.statusCode).toBe(200)
    expect(capabilities.json()).toMatchObject({
      ok: true,
      data: { enabled: false, product: "socrates_flow", contractVersion: 2 },
    })

    const flowRoute = await runtime.app.inject({
      method: "POST",
      url: "/api/v2/projects/not-mounted/flow",
      payload: {},
    })
    const speechRoute = await runtime.app.inject({ method: "GET", url: "/api/v2/speech/packs" })
    expect(flowRoute.statusCode).toBe(404)
    expect(speechRoute.statusCode).toBe(404)

    const { project } = await onboardAndCreateProject(runtime)
    const dashboard = await runtime.app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json()).toMatchObject({
      ok: true,
      data: { project: { id: project.id }, conversations: [] },
    })

    expect(tableCounts(runtime.dbPath, ["v2_flows", "v2_artifacts", "v2_speech_jobs"])).toEqual({
      v2_flows: 0,
      v2_artifacts: 0,
      v2_speech_jobs: 0,
    })
  })

  it("mounts the real V2 surface without creating any Classic runtime rows", async () => {
    const runtime = await createRuntime(true)
    const capabilities = await runtime.app.inject({ method: "GET", url: "/api/v2/capabilities" })
    expect(capabilities.statusCode).toBe(200)
    expect(capabilities.json()).toMatchObject({
      ok: true,
      data: {
        enabled: true,
        product: "socrates_flow",
        contractVersion: 2,
        speech: {
          localStt: ["whisper.cpp/base.en", "whisper.cpp/small.en"],
          hostedStt: [
            "nvidia/parakeet-tdt-0.6b-v3",
            "microsoft/mai-transcribe-1.5",
            "mistralai/voxtral-mini-transcribe",
          ],
          localTts: ["kokoro-82m"],
        },
      },
    })

    const { project, primaryWorkspace } = await onboardAndCreateProject(runtime)
    expect(primaryWorkspace.path).toBe(runtime.workspace)

    const classicRuntimeTables = [
      "conversations",
      "sessions",
      "turns",
      "messages",
      "message_attachments",
      "model_calls",
      "tool_calls",
      "approvals",
      "events",
      "terminal_sessions",
      "terminal_output_chunks",
      "agent_tasks",
      "agent_task_waits",
      "agent_task_turns",
      "message_feedback",
    ]
    // Project onboarding is a shared control-plane operation and records its
    // own Classic events. V2 isolation means Flow work must not change any of
    // these Classic runtime tables after that shared project baseline exists.
    const classicRuntimeBaseline = tableCounts(runtime.dbPath, classicRuntimeTables)

    const createFlow = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${project.id}/flow`,
      payload: {},
    })
    const flowBody = parse<{ snapshot: V2FlowSnapshot }>(createFlow.payload)
    expect(createFlow.statusCode).toBe(200)
    expect(flowBody.ok).toBe(true)
    if (!flowBody.ok) throw new Error(`V2 Flow creation failed: ${flowBody.error.message}`)
    expect(flowBody.data.snapshot).toMatchObject({
      flow: { projectId: project.id, status: "active", revision: 1 },
      goals: [{ title: "General Conversation", kind: "general", status: "foreground", pinned: true }],
      messages: [],
      messageWindow: { hasEarlier: false },
      lastEventSequence: 0,
    })
    const flowId = flowBody.data.snapshot.flow.id
    const classicBridgeBaseline = tableCounts(runtime.dbPath, classicRuntimeTables)
    expect(classicBridgeBaseline.conversations).toBe((classicRuntimeBaseline.conversations ?? 0) + 1)
    expect(classicBridgeBaseline.sessions).toBe((classicRuntimeBaseline.sessions ?? 0) + 1)

    const packList = await runtime.app.inject({ method: "GET", url: "/api/v2/speech/packs" })
    expect(packList.statusCode).toBe(200)
    expect((packList.json() as { data: { packs: Array<{ id: string }> } }).data.packs.map((pack) => pack.id)).toEqual([
      "whisper-base.en",
      "whisper-small.en",
      "kokoro-en-v0_19",
    ])

    const audioBytes = Buffer.from("RIFF-real-v2-isolation-audio")
    const boundary = "socrates-v2-app-isolation-audio"
    const upload = await runtime.app.inject({
      method: "POST",
      url: `/api/v2/projects/${project.id}/flows/${flowId}/speech/artifacts`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartAudio(boundary, audioBytes),
    })
    const uploadBody = parse<{ artifact: V2Artifact }>(upload.payload)
    expect(upload.statusCode).toBe(200)
    expect(uploadBody.ok).toBe(true)
    if (!uploadBody.ok) throw new Error(`V2 speech upload failed: ${uploadBody.error.message}`)

    const expectedAttachmentDirectory = path.join(runtime.workspace, ".socrates", "attachments")
    const storedPath = uploadBody.data.artifact.path
    expect(storedPath).toBeTruthy()
    expect(path.dirname(storedPath ?? "")).toBe(expectedAttachmentDirectory)
    expect(fs.readFileSync(storedPath ?? "")).toEqual(audioBytes)
    expect(uploadBody.data.artifact).toMatchObject({
      projectId: project.id,
      flowId,
      kind: "speech_input",
      mimeType: "audio/wav",
      sizeBytes: audioBytes.byteLength,
    })

    expect(tableCounts(runtime.dbPath, classicRuntimeTables)).toEqual(classicBridgeBaseline)
    expect(tableCounts(runtime.dbPath, ["v2_flows", "v2_artifacts", "v2_speech_jobs"])).toEqual({
      v2_flows: 1,
      v2_artifacts: 1,
      v2_speech_jobs: 0,
    })
  })
})
