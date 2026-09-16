import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import type { ApiResponse, Project, ProjectWorkspace } from "@socrates/contracts"
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

const createRuntime = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-stable-classic-"))
  temporaryRoots.push(root)
  const home = path.join(root, "home")
  const workspace = path.join(root, "workspace")
  const dbPath = path.join(root, "socrates.sqlite")
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(workspace, { recursive: true })
  const app = await buildServer({
    dbPath,
    socratesHome: home,
    preserveTerminalsOnClose: false,
    agent: testAgent(),
    embeddingProvider: testEmbeddings(),
    titleProvider: false,
  })
  runningServers.push(app)
  return { app, workspace, dbPath }
}

const parse = <T>(payload: string): ApiResponse<T> => JSON.parse(payload) as ApiResponse<T>

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

describe("stable Classic product isolation", () => {
  it("does not expose Flow HTTP routes and creates no Flow state during normal Classic use", async () => {
    const runtime = await createRuntime()
    for (const request of [
      { method: "GET" as const, url: "/api/v2/capabilities" },
      { method: "POST" as const, url: "/api/v2/projects/not-mounted/flow", payload: {} },
      { method: "GET" as const, url: "/api/v2/speech/packs" },
    ]) {
      const response = await runtime.app.inject(request)
      expect(response.statusCode).toBe(404)
    }

    const onboarding = await runtime.app.inject({
      method: "POST",
      url: "/api/onboarding",
      payload: { displayName: "Stable Classic Test" },
    })
    expect(onboarding.statusCode).toBe(200)

    const response = await runtime.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Classic Project",
        description: "A real isolated Classic workspace.",
        creationMode: "start_from_scratch",
        workspacePath: runtime.workspace,
      },
    })
    const body = parse<{ project: Project; primaryWorkspace: ProjectWorkspace }>(response.payload)
    expect(body.ok).toBe(true)
    if (!body.ok) throw new Error(body.error.message)

    const dashboard = await runtime.app.inject({ method: "GET", url: `/api/projects/${body.data.project.id}` })
    expect(dashboard.statusCode).toBe(200)
    expect(dashboard.json()).toMatchObject({
      ok: true,
      data: { project: { id: body.data.project.id }, conversations: [] },
    })

    expect(tableCounts(runtime.dbPath, [
      "v2_flows",
      "v2_goals",
      "v2_turns",
      "v2_messages",
      "v2_classic_conversation_bridges",
      "v2_artifacts",
      "v2_speech_jobs",
    ])).toEqual({
      v2_flows: 0,
      v2_goals: 0,
      v2_turns: 0,
      v2_messages: 0,
      v2_classic_conversation_bridges: 0,
      v2_artifacts: 0,
      v2_speech_jobs: 0,
    })
  })
})
