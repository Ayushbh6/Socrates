import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import type { ApiResponse, Conversation, Message, Project, ProjectEmbeddingStatus, ProjectInstructions, ProjectResource, ProjectWorkspace, ServerEvent, User } from "@socrates/contracts"
import { clientCommandSchema, serverEventSchema } from "@socrates/contracts"
import { SocratesAgent } from "@socrates/core"
import type { EmbeddingProvider, ModelProvider } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { buildServer } from "../app"
import { openDatabase, runMigrations } from "../db/client"
import { SocratesStore } from "../services/store"

type TestServer = Awaited<ReturnType<typeof buildServer>>

const servers: TestServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const tempDbPath = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-server-test-"))
  return path.join(dir, "socrates.sqlite")
}

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "socrates-server-workspace-test-"))

const buildTestServer = async (dbPath = tempDbPath(), agent = createTestAgent()): Promise<TestServer> => {
  const app = await buildServer({ dbPath, agent })
  servers.push(app)
  return app
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const fakeCountTokens: ModelProvider["countTokens"] = async (request) => {
  const baseTokens = Math.ceil(`${request.system}${JSON.stringify(request.messages)}${JSON.stringify(request.tools ?? [])}`.length / 4)
  return {
    providerId: request.providerId,
    modelId: request.modelId,
    inputTokens: baseTokens,
    baseTokens,
    method: "local_tiktoken",
    safetyMarginPercent: 0,
  }
}

const createTestAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      yield { type: "model.reasoning.delta", text: "Testing." }
      yield { type: "model.answer.delta", text: `Echo: ${request.messages.at(-1)?.content ?? ""}` }
      await delay(100)
      yield {
        type: "model.completed",
        usage: {
          inputTokens: 4,
          outputTokens: 3,
          reasoningTokens: 2,
          totalTokens: 9,
        },
      }
    },
  }
  return new SocratesAgent(provider)
}

const createCapturingAgent = (requests: unknown[]): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      requests.push(request)
      yield { type: "model.answer.delta", text: "Captured" }
      yield {
        type: "model.completed",
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
        },
      }
    },
  }
  return new SocratesAgent(provider)
}

const createFixedContextAgent = (inputTokens: number): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    async countTokens(request) {
      return {
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens,
        baseTokens: inputTokens,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }
    },
    async *stream() {
      yield { type: "model.answer.delta", text: "Fixed context answer." }
      yield {
        type: "model.completed",
        usage: {
          inputTokens: 4,
          outputTokens: 2,
          totalTokens: 6,
        },
      }
    },
  }
  return new SocratesAgent(provider)
}

const createCancellablePartialAgent = (requests: unknown[]): SocratesAgent => {
  let call = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      call += 1
      requests.push(request)
      if (call === 1) {
        yield { type: "model.answer.delta", text: "Partial answer before stop." }
        await delay(500)
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Next answer." }
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }
    },
  }
  return new SocratesAgent(provider)
}

const createApprovalWaitingAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: "tcall_waiting_bash",
          toolName: "bash",
          input: { command: "pip install example-package" },
        },
      }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createFailingAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      yield {
        type: "model.failed",
        error: new SocratesError("provider_failed", "Provider failed during test"),
      }
    },
  }
  return new SocratesAgent(provider)
}

const createPersistentBashAgent = (): SocratesAgent => {
  let step = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_cd",
            toolName: "bash",
            input: { command: "mkdir -p nested && cd nested && export SOCRATES_SERVER_TEST=ok && pwd" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 2) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_state",
            toolName: "bash",
            input: { command: "printf \"$SOCRATES_SERVER_TEST $(basename \"$PWD\")\"" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Shell state preserved." }
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
    },
  }
  return new SocratesAgent(provider)
}

const createApprovalToolAgent = (): SocratesAgent => {
  let step = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_approval",
            toolName: "bash",
            input: { command: "printf approved > approved.txt" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Approved command ran." }
      yield { type: "model.completed", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } }
    },
  }
  return new SocratesAgent(provider)
}

const createTestEmbeddingProvider = (): EmbeddingProvider => ({
  async check() {
    return { ok: true, dimensions: 3, message: "Test embeddings are reachable." }
  },
  async embed(request) {
    return {
      embeddings: [testEmbeddingVector(request.value)],
      dimensions: 3,
    }
  },
  async embedMany(request) {
    return {
      embeddings: request.values.map(testEmbeddingVector),
      dimensions: 3,
    }
  },
})

const testEmbeddingVector = (value: string): number[] => {
  const lower = value.toLowerCase()
  if (lower.includes("blue-lantern-42")) {
    return [1, 0, 0]
  }
  if (lower.includes("ordinary")) {
    return [0, 1, 0]
  }
  return [0, 0, 1]
}

const createGeminiSignatureAgent = (requests: unknown[]): SocratesAgent => {
  let step = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      requests.push(request)
      step += 1
      if (step === 1) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_resources",
            toolName: "list_project_resources",
            input: { kind: "pdf", limit: 1 },
            providerMetadata: { google: { thoughtSignature: "sig_gemini_1" } },
          },
        }
        yield { type: "model.completed", finishReason: "tool-calls" }
        return
      }
      yield { type: "model.answer.delta", text: "Resources listed." }
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
    },
  }
  return new SocratesAgent(provider)
}

const parseResponse = <T>(payload: string): ApiResponse<T> => JSON.parse(payload) as ApiResponse<T>

const onboard = async (app: TestServer, displayName = "Ayush"): Promise<User> => {
  const response = await app.inject({
    method: "POST",
    url: "/api/onboarding",
    payload: { displayName },
  })
  const body = parseResponse<{ user: User }>(response.payload)
  expect(body.ok).toBe(true)
  if (!body.ok) {
    throw new Error("Expected onboarding success")
  }
  return body.data.user
}

const createProject = async (
  app: TestServer,
  name = "Backend Test Project",
): Promise<{ project: Project; primaryWorkspace: ProjectWorkspace }> => {
  const workspacePath = path.join(tempDir(), name.replaceAll(" ", "-"))
  const response = await app.inject({
    method: "POST",
    url: "/api/projects",
    payload: {
      name,
      description: "A test project",
      creationMode: "start_from_scratch",
      workspacePath,
    },
  })
  const body = parseResponse<{ project: Project; primaryWorkspace: ProjectWorkspace }>(response.payload)
  expect(body.ok).toBe(true)
  if (!body.ok) {
    throw new Error("Expected project creation success")
  }
  return body.data
}

const createConversation = async (app: TestServer, projectId: string, title = "Test Chat"): Promise<Conversation> => {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/conversations`,
    payload: { title },
  })
  const body = parseResponse<{ conversation: Conversation }>(response.payload)
  expect(body.ok).toBe(true)
  if (!body.ok) {
    throw new Error("Expected conversation creation success")
  }
  return body.data.conversation
}

const connectWebSocket = async (app: TestServer): Promise<WebSocket> => {
  await app.listen({ host: "127.0.0.1", port: 0 })
  const address = app.server.address()
  if (!address || typeof address === "string") {
    throw new Error("Could not resolve test server address")
  }

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`)
  trackedEvents.set(socket, [])
  socket.on("message", (raw) => {
    trackedEvents.get(socket)?.push(serverEventSchema.parse(JSON.parse(raw.toString())))
  })
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve())
    socket.once("error", reject)
  })
  return socket
}

const trackedEvents = new WeakMap<WebSocket, ServerEvent[]>()

const waitForEvent = async <T extends ServerEvent["type"]>(
  socket: WebSocket,
  type: T,
): Promise<Extract<ServerEvent, { type: T }>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`Timed out waiting for ${type}`))
    }, 1_000)

    const interval = setInterval(() => {
      const events = trackedEvents.get(socket) ?? []
      const index = events.findIndex((event) => event.type === type)
      if (index >= 0) {
        const [event] = events.splice(index, 1)
        clearTimeout(timer)
        clearInterval(interval)
        resolve(event as Extract<ServerEvent, { type: T }>)
      }
    }, 5)
  })

const sendCommand = (socket: WebSocket, command: unknown): void => {
  socket.send(JSON.stringify(clientCommandSchema.parse(command)))
}

const insertTestSession = (sqlite: Database.Database, projectId: string, conversationId: string): string => {
  const id = createId("sess")
  const now = nowIso()
  sqlite
    .prepare(
      `INSERT INTO sessions (
        id, conversation_id, project_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'idle', ?, ?)`,
    )
    .run(id, conversationId, projectId, now, now)
  return id
}

const insertCompletedTestTurn = (
  sqlite: Database.Database,
  conversationId: string,
  sessionId: string,
  userContent: string,
  assistantContent: string,
  timestamp: string,
): { turnId: string; userMessageId: string; assistantMessageId: string } => {
  const turnId = createId("turn")
  const userMessageId = createId("msg")
  const assistantMessageId = createId("msg")
  sqlite
    .prepare(
      `INSERT INTO turns (
        id, session_id, conversation_id, user_message_id, assistant_message_id, status, started_at, completed_at
       ) VALUES (?, ?, ?, ?, ?, 'completed', ?, ?)`,
    )
    .run(turnId, sessionId, conversationId, userMessageId, assistantMessageId, timestamp, timestamp)
  sqlite
    .prepare(
      `INSERT INTO messages (
        id, conversation_id, session_id, turn_id, role, content, content_format, status, created_at, completed_at
       ) VALUES (?, ?, ?, ?, 'user', ?, 'markdown', 'completed', ?, ?)`,
    )
    .run(userMessageId, conversationId, sessionId, turnId, userContent, timestamp, timestamp)
  sqlite
    .prepare(
      `INSERT INTO messages (
        id, conversation_id, session_id, turn_id, role, content, content_format, status, created_at, completed_at
       ) VALUES (?, ?, ?, ?, 'assistant', ?, 'markdown', 'completed', ?, ?)`,
    )
    .run(assistantMessageId, conversationId, sessionId, turnId, assistantContent, timestamp, timestamp)
  sqlite.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(timestamp, conversationId)
  return { turnId, userMessageId, assistantMessageId }
}

const waitForEmbeddingStatus = async (
  store: SocratesStore,
  projectId: string,
  predicate: (status: ProjectEmbeddingStatus) => boolean,
): Promise<ProjectEmbeddingStatus> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const status = store.getProjectEmbeddingStatus(projectId)
    if (predicate(status)) {
      return status
    }
    await delay(25)
  }
  throw new Error("Timed out waiting for embedding status")
}

const chatMessageCommand = (projectId: string, conversationId: string, content: string) => ({
  id: createId("evt"),
  type: "chat.message.send",
  schemaVersion: 1,
  timestamp: nowIso(),
  projectId,
  conversationId,
  actor: { type: "user" },
  payload: {
    clientMessageId: createId("msg"),
    content,
    runtimeConfig: {
      providerId: "openai",
      modelId: "gpt-test",
      thinkingEnabled: true,
      thinkingEffort: "medium",
      approvalMode: "manual",
      sandboxMode: "workspace_write",
    },
  },
})

const chatMessageCommandWithRuntime = (
  projectId: string,
  conversationId: string,
  content: string,
  runtime: Partial<ReturnType<typeof chatMessageCommand>["payload"]["runtimeConfig"]>,
) => {
  const command = chatMessageCommand(projectId, conversationId, content)
  return {
    ...command,
    payload: {
      ...command.payload,
      runtimeConfig: {
        ...command.payload.runtimeConfig,
        ...runtime,
      },
    },
  }
}

describe("database migrations", () => {
  it("creates every backend foundation table", () => {
    const dbPath = tempDbPath()
    const handle = openDatabase(dbPath)
    try {
      runMigrations(handle)
    } finally {
      handle.close()
    }

    const sqlite = new Database(dbPath)
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name)
    sqlite.close()

    expect(tables).toEqual(
      expect.arrayContaining([
        "users",
        "projects",
        "project_workspaces",
        "project_resources",
        "project_instructions",
        "conversations",
        "sessions",
        "turns",
        "turn_runtime_configs",
        "messages",
        "events",
        "model_calls",
        "model_stream_chunks",
        "model_usage",
        "context_usage_snapshots",
        "context_compaction_snapshots",
        "tool_calls",
        "approvals",
        "shell_commands",
        "shell_output_chunks",
        "file_operations",
        "patches",
        "errors",
        "trace_documents",
        "trace_documents_fts",
        "trace_index_jobs",
        "project_embedding_configs",
        "trace_embeddings",
        "artifacts",
        "voice_inputs",
        "audio_outputs",
        "message_feedback",
        "session_state",
        "schema_migrations",
      ]),
    )
  })
})

describe("context compaction persistence", () => {
  it("chains active snapshots and exposes completed summaries through trace_retrieve", async () => {
    const dbPath = tempDbPath()
    const handle = openDatabase(dbPath)
    runMigrations(handle)
    const store = new SocratesStore(handle)
    const now = nowIso()
    const userId = createId("user")
    const projectId = createId("proj")
    const workspaceId = createId("pws")
    const conversationId = createId("conv")
    const sessionId = createId("sess")
    const turnId = createId("turn")
    const firstSnapshotId = createId("ctxcmp")
    const secondSnapshotId = createId("ctxcmp")

    try {
      handle.sqlite
        .prepare("INSERT INTO users (id, display_name, onboarding_completed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
        .run(userId, "Ayush", now, now)
      handle.sqlite
        .prepare("INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
        .run(projectId, userId, "Compression Test", now, now)
      handle.sqlite
        .prepare(
          "INSERT INTO project_workspaces (id, project_id, kind, path, is_primary, status, created_at, updated_at) VALUES (?, ?, 'existing_folder', ?, 1, 'active', ?, ?)",
        )
        .run(workspaceId, projectId, tempDir(), now, now)
      handle.sqlite
        .prepare("INSERT INTO conversations (id, project_id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
        .run(conversationId, projectId, userId, "Compression Chat", now, now)
      handle.sqlite
        .prepare("INSERT INTO sessions (id, conversation_id, project_id, status, created_at, updated_at) VALUES (?, ?, ?, 'idle', ?, ?)")
        .run(sessionId, conversationId, projectId, now, now)

      store.startContextCompactionSnapshot({
        snapshotId: firstSnapshotId,
        projectId,
        conversationId,
        sessionId,
        turnId,
        reason: "threshold",
        contextTokensEstimate: 126000,
        targetTokens: 100000,
        compressorProviderId: "openrouter",
        compressorModelId: "deepseek/deepseek-v4-flash",
        sourceMessageIds: ["msg_old_1"],
        sourceTurnIds: ["turn_old_1"],
      })
      store.completeContextCompactionSnapshot({
        snapshotId: firstSnapshotId,
        summary: { decisions: ["alpha decision"] },
        renderedSummary: "alpha decision from first compacted summary",
        sourceHandles: [{ messageId: "msg_old_1" }],
        inputTokensEstimate: 126000,
        outputTokensEstimate: 1200,
        contextTokensAfter: 95000,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      })
      store.startContextCompactionSnapshot({
        snapshotId: secondSnapshotId,
        previousSnapshotId: firstSnapshotId,
        projectId,
        conversationId,
        sessionId,
        turnId,
        reason: "threshold",
        contextTokensEstimate: 130000,
        targetTokens: 100000,
        compressorProviderId: "openrouter",
        compressorModelId: "qwen/qwen3.6-plus",
        sourceMessageIds: ["msg_old_2"],
        sourceTurnIds: ["turn_old_2"],
      })
      store.completeContextCompactionSnapshot({
        snapshotId: secondSnapshotId,
        summary: { decisions: ["beta decision"] },
        renderedSummary: "beta decision from second compacted summary",
        sourceHandles: [{ messageId: "msg_old_2" }],
        inputTokensEstimate: 130000,
        outputTokensEstimate: 1300,
        contextTokensAfter: 96000,
      })

      const latest = store.getLatestContextCompactionSnapshot(conversationId)
      expect(latest?.snapshotId).toBe(secondSnapshotId)
      expect(latest?.previousSnapshotId).toBe(firstSnapshotId)

      const activeRows = handle.sqlite
        .prepare("SELECT id, active FROM context_compaction_snapshots WHERE conversation_id = ? ORDER BY started_at")
        .all(conversationId) as Array<{ id: string; active: number }>
      expect(activeRows).toEqual([
        { id: firstSnapshotId, active: 0 },
        { id: secondSnapshotId, active: 1 },
      ])

      const search = await store.retrieveToolTraces(projectId, conversationId, {
        query: "beta decision",
        include: ["summaries"],
      })
      expect(search.results.some((result) => result.kind === "conversation_summary" && result.sourceId === secondSnapshotId)).toBe(true)
    } finally {
      store.close()
    }
  })
})

describe("HTTP API", () => {
  it("returns null user before onboarding", async () => {
    const app = await buildTestServer()
    const response = await app.inject({ method: "GET", url: "/api/me" })
    const body = parseResponse<{ user: User | null }>(response.payload)

    expect(response.statusCode).toBe(200)
    expect(body).toEqual({ ok: true, data: { user: null } })
  })

  it("creates and updates the single local user during onboarding", async () => {
    const app = await buildTestServer()
    const created = await onboard(app, "Ayush")
    expect(created.displayName).toBe("Ayush")
    expect(created.onboardingCompleted).toBe(true)

    const updated = await onboard(app, "Aparajit")
    expect(updated.id).toBe(created.id)
    expect(updated.displayName).toBe("Aparajit")
  })

  it("creates, lists, gets, and patches projects", async () => {
    const app = await buildTestServer()
    await onboard(app)

    const { project, primaryWorkspace } = await createProject(app)
    expect(project.status).toBe("active")
    expect(primaryWorkspace.path).toBeTruthy()
    expect(fs.statSync(path.join(primaryWorkspace.path ?? "", ".socrates", "resources")).isDirectory()).toBe(true)

    const listResponse = await app.inject({ method: "GET", url: "/api/projects" })
    const listBody = parseResponse<
      { projects: Array<{ project: Project; primaryWorkspace: ProjectWorkspace; conversationCount: number }> }
    >(listResponse.payload)
    expect(listBody.ok).toBe(true)
    if (listBody.ok) {
      expect(listBody.data.projects).toHaveLength(1)
      expect(listBody.data.projects[0]?.project.id).toBe(project.id)
      expect(listBody.data.projects[0]?.primaryWorkspace.id).toBe(primaryWorkspace.id)
      expect(listBody.data.projects[0]?.conversationCount).toBe(0)
    }

    const getResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    const getBody = parseResponse<{
      project: Project
      primaryWorkspace: ProjectWorkspace
      resources: ProjectResource[]
      conversations: Conversation[]
    }>(getResponse.payload)
    expect(getBody.ok).toBe(true)
    if (getBody.ok) {
      expect(getBody.data.project.id).toBe(project.id)
      expect(getBody.data.primaryWorkspace.id).toBe(primaryWorkspace.id)
      expect(getBody.data.resources).toEqual([])
      expect(getBody.data.conversations).toEqual([])
    }

    const patchResponse = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}`,
      payload: { name: "Renamed Project" },
    })
    const patchBody = parseResponse<{ project: Project }>(patchResponse.payload)
    expect(patchBody.ok).toBe(true)
    if (patchBody.ok) {
      expect(patchBody.data.project.name).toBe("Renamed Project")
    }
  })

  it("creates an existing-folder project and rejects duplicate workspace paths", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const workspacePath = tempDir()

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Existing Folder Project",
        creationMode: "existing_folder",
        workspacePath,
      },
    })
    const createBody = parseResponse<{ project: Project; primaryWorkspace: ProjectWorkspace }>(createResponse.payload)
    expect(createBody.ok).toBe(true)
    if (createBody.ok) {
      expect(createBody.data.primaryWorkspace.kind).toBe("existing_folder")
      expect(fs.statSync(path.join(workspacePath, ".socrates", "resources")).isDirectory()).toBe(true)
    }

    const duplicateResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Duplicate",
        creationMode: "existing_folder",
        workspacePath,
      },
    })
    const duplicateBody = parseResponse<never>(duplicateResponse.payload)
    expect(duplicateResponse.statusCode).toBe(409)
    expect(duplicateBody.ok).toBe(false)
    if (!duplicateBody.ok) {
      expect(duplicateBody.error.code).toBe("workspace_already_attached")
    }
  })

  it("inspects workspaces and requires explicit action for an existing .socrates folder", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const workspacePath = tempDir()
    const markerPath = path.join(workspacePath, ".socrates", "keep.txt")
    fs.mkdirSync(path.dirname(markerPath), { recursive: true })
    fs.writeFileSync(markerPath, "keep")

    const inspectResponse = await app.inject({
      method: "POST",
      url: "/api/workspaces/inspect",
      payload: { workspacePath },
    })
    const inspectBody = parseResponse<{
      workspacePath: string
      folderName: string
      exists: boolean
      isDirectory: boolean
      hasSocratesDir: boolean
      hasResourcesDir: boolean
    }>(inspectResponse.payload)
    expect(inspectBody.ok).toBe(true)
    if (inspectBody.ok) {
      expect(inspectBody.data.hasSocratesDir).toBe(true)
      expect(inspectBody.data.hasResourcesDir).toBe(false)
    }

    const missingActionResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Existing Socrates",
        creationMode: "existing_folder",
        workspacePath,
      },
    })
    const missingActionBody = parseResponse<never>(missingActionResponse.payload)
    expect(missingActionResponse.statusCode).toBe(409)
    expect(missingActionBody.ok).toBe(false)
    if (!missingActionBody.ok) {
      expect(missingActionBody.error.code).toBe("workspace_scaffold_action_required")
    }

    const createResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Use Existing Socrates",
        creationMode: "existing_folder",
        workspacePath,
        scaffoldAction: "use_existing",
      },
    })
    const createBody = parseResponse<{ project: Project; primaryWorkspace: ProjectWorkspace }>(createResponse.payload)
    expect(createBody.ok).toBe(true)
    expect(fs.readFileSync(markerPath, "utf8")).toBe("keep")
    expect(fs.statSync(path.join(workspacePath, ".socrates", "resources")).isDirectory()).toBe(true)
  })

  it("updates a project workspace, copies uploaded resources, and detaches the old workspace", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const boundary = "----socrates-workspace-switch-boundary"
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="Keep Me.txt"',
        "Content-Type: text/plain",
        "",
        "copy me",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    )
    const uploadResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources/upload`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })
    const uploadBody = parseResponse<{ resources: ProjectResource[] }>(uploadResponse.payload)
    expect(uploadBody.ok).toBe(true)
    if (!uploadBody.ok) {
      throw new Error("Expected upload success")
    }
    const oldResourcePath = uploadBody.data.resources[0]?.uri ?? ""
    const newWorkspacePath = tempDir()
    fs.mkdirSync(path.join(newWorkspacePath, ".socrates"), { recursive: true })

    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/workspace`,
      payload: {
        workspacePath: newWorkspacePath,
        creationMode: "existing_folder",
        scaffoldAction: "use_existing",
      },
    })
    const updateBody = parseResponse<{ primaryWorkspace: ProjectWorkspace; resources: ProjectResource[] }>(updateResponse.payload)
    expect(updateBody.ok).toBe(true)
    if (!updateBody.ok) {
      throw new Error("Expected workspace update success")
    }
    expect(updateBody.data.primaryWorkspace.path).toBe(newWorkspacePath)
    const copiedResource = updateBody.data.resources.find((resource) => resource.id === uploadBody.data.resources[0]?.id)
    expect(copiedResource?.uri).toBe(path.join(newWorkspacePath, ".socrates", "resources", "Keep_Me.txt"))
    expect(fs.readFileSync(copiedResource?.uri ?? "", "utf8")).toBe("copy me")
    expect(fs.readFileSync(oldResourcePath, "utf8")).toBe("copy me")

    const sqlite = new Database(dbPath)
    try {
      const rows = sqlite
        .prepare("SELECT id, path, is_primary, status FROM project_workspaces WHERE project_id = ? ORDER BY created_at")
        .all(project.id) as Array<{ id: string; path: string; is_primary: number; status: string }>
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.id === primaryWorkspace.id)?.status).toBe("detached")
      expect(rows.find((row) => row.path === newWorkspacePath)?.is_primary).toBe(1)
    } finally {
      sqlite.close()
    }
  })

  it("blocks workspace updates while a project turn is active", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)

    const sqlite = new Database(dbPath)
    try {
      const sessionId = insertTestSession(sqlite, project.id, conversation.id)
      sqlite
        .prepare(
          "INSERT INTO turns (id, session_id, conversation_id, status, started_at) VALUES (?, ?, ?, 'running', ?)",
        )
        .run(createId("turn"), sessionId, conversation.id, nowIso())
    } finally {
      sqlite.close()
    }

    const response = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/workspace`,
      payload: {
        workspacePath: tempDir(),
        creationMode: "existing_folder",
      },
    })
    const body = parseResponse<never>(response.payload)
    expect(response.statusCode).toBe(409)
    expect(body.ok).toBe(false)
    if (!body.ok) {
      expect(body.error.code).toBe("project_workspace_has_active_turn")
    }
  })

  it("creates and lists project resources", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project } = await createProject(app)

    const createResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources`,
      payload: {
        name: "Spec",
        kind: "document",
        source: "uploaded",
      },
    })
    const createBody = parseResponse<{ resource: ProjectResource }>(createResponse.payload)
    expect(createBody.ok).toBe(true)
    if (createBody.ok) {
      expect(createBody.data.resource.name).toBe("Spec")
    }

    const listResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/resources` })
    const listBody = parseResponse<{ resources: ProjectResource[] }>(listResponse.payload)
    expect(listBody.ok).toBe(true)
    if (listBody.ok) {
      expect(listBody.data.resources).toHaveLength(1)
    }
  })

  it("uploads project resources into the workspace scaffold", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const boundary = "----socrates-test-boundary"
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="Spec Draft?.md"',
        "Content-Type: text/markdown",
        "",
        "hello from upload",
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="Data.csv"',
        "Content-Type: text/csv",
        "",
        "id,name\n1,Socrates",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    )

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources/upload`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })
    const body = parseResponse<{ resources: ProjectResource[] }>(response.payload)

    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.resources).toHaveLength(2)
      expect(body.data.resources[0]?.name).toBe("Spec_Draft_.md")
      expect(body.data.resources[0]?.mimeType).toBe("text/markdown")
      expect(body.data.resources[0]?.sizeBytes).toBe(Buffer.byteLength("hello from upload"))
      expect(body.data.resources[0]?.uri).toBe(
        path.join(primaryWorkspace.path ?? "", ".socrates", "resources", "Spec_Draft_.md"),
      )
      expect(fs.readFileSync(body.data.resources[0]?.uri ?? "", "utf8")).toBe("hello from upload")
      expect(body.data.resources[1]?.name).toBe("Data.csv")
      expect(body.data.resources[1]?.mimeType).toBe("text/csv")
    }
  })

  it("deletes uploaded project resources and their owned copied files", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const boundary = "----socrates-delete-boundary"
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="Delete Me.txt"',
        "Content-Type: text/plain",
        "",
        "delete me",
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    )

    const uploadResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources/upload`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })
    const uploadBody = parseResponse<{ resources: ProjectResource[] }>(uploadResponse.payload)
    expect(uploadBody.ok).toBe(true)
    if (!uploadBody.ok) {
      throw new Error("Expected upload success")
    }
    const resource = uploadBody.data.resources[0]
    expect(resource).toBeDefined()
    expect(fs.existsSync(resource?.uri ?? "")).toBe(true)

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/resources/${resource?.id}`,
    })
    const deleteBody = parseResponse<{ deletedResourceId: string }>(deleteResponse.payload)
    expect(deleteBody.ok).toBe(true)
    if (deleteBody.ok) {
      expect(deleteBody.data.deletedResourceId).toBe(resource?.id)
    }
    expect(fs.existsSync(resource?.uri ?? "")).toBe(false)

    const listBody = parseResponse<{ resources: ProjectResource[] }>(
      (await app.inject({ method: "GET", url: `/api/projects/${project.id}/resources` })).payload,
    )
    expect(listBody.ok).toBe(true)
    if (listBody.ok) {
      expect(listBody.data.resources).toHaveLength(0)
    }

    const dashboardBody = parseResponse<{ resources: ProjectResource[] }>(
      (await app.inject({ method: "GET", url: `/api/projects/${project.id}` })).payload,
    )
    expect(dashboardBody.ok).toBe(true)
    if (dashboardBody.ok) {
      expect(dashboardBody.data.resources).toHaveLength(0)
    }

    const sqlite = new Database(dbPath)
    try {
      const row = sqlite.prepare("SELECT status FROM project_resources WHERE id = ?").get(resource?.id) as { status: string }
      expect(row.status).toBe("deleted")
    } finally {
      sqlite.close()
    }
  })

  it("soft-deletes linked project resources without deleting external files", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project } = await createProject(app)
    const externalPath = path.join(tempDir(), "external.txt")
    fs.writeFileSync(externalPath, "external")

    const createResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources`,
      payload: {
        name: "External",
        kind: "local_file",
        source: "linked_file",
        uri: externalPath,
      },
    })
    const createBody = parseResponse<{ resource: ProjectResource }>(createResponse.payload)
    expect(createBody.ok).toBe(true)
    if (!createBody.ok) {
      throw new Error("Expected linked resource creation success")
    }

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/resources/${createBody.data.resource.id}`,
    })
    const deleteBody = parseResponse<{ deletedResourceId: string }>(deleteResponse.payload)
    expect(deleteBody.ok).toBe(true)
    if (deleteBody.ok) {
      expect(deleteBody.data.deletedResourceId).toBe(createBody.data.resource.id)
    }
    expect(fs.readFileSync(externalPath, "utf8")).toBe("external")

    const listBody = parseResponse<{ resources: ProjectResource[] }>(
      (await app.inject({ method: "GET", url: `/api/projects/${project.id}/resources` })).payload,
    )
    expect(listBody.ok).toBe(true)
    if (listBody.ok) {
      expect(listBody.data.resources).toHaveLength(0)
    }
  })

  it("rejects upload requests with more than 10 files", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project } = await createProject(app)
    const boundary = "----socrates-test-boundary"
    const parts = Array.from({ length: 11 }, (_, index) =>
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="files"; filename="file-${index}.txt"`,
        "Content-Type: text/plain",
        "",
        `file ${index}`,
      ].join("\r\n"),
    )
    const payload = Buffer.from([...parts, `--${boundary}--`, ""].join("\r\n"))

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources/upload`,
      headers: {
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    })
    const body = parseResponse<never>(response.payload)

    expect(body.ok).toBe(false)
    if (!body.ok) {
      expect(body.error.code).toBe("resource_upload_limit_exceeded")
    }
  })

  it("creates and updates project instructions", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project } = await createProject(app)

    const createResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/instructions`,
      payload: { content: "Read repo_docs before answering." },
    })
    const createBody = parseResponse<{ instructions: ProjectInstructions }>(createResponse.payload)
    expect(createBody.ok).toBe(true)

    const updateResponse = await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/instructions`,
      payload: { content: "Read repo_docs and keep changes scoped." },
    })
    const updateBody = parseResponse<{ instructions: ProjectInstructions }>(updateResponse.payload)
    expect(updateBody.ok).toBe(true)
    if (createBody.ok && updateBody.ok) {
      expect(updateBody.data.instructions.id).toBe(createBody.data.instructions.id)
      expect(updateBody.data.instructions.content).toBe("Read repo_docs and keep changes scoped.")
    }

    const getResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    const getBody = parseResponse<{ instructions?: ProjectInstructions }>(getResponse.payload)
    expect(getBody.ok).toBe(true)
    if (getBody.ok) {
      expect(getBody.data.instructions?.content).toBe("Read repo_docs and keep changes scoped.")
    }
  })

  it("creates, lists, and gets conversations under a project", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)

    const listResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/conversations` })
    const listBody = parseResponse<{ conversations: Conversation[] }>(listResponse.payload)
    expect(listBody.ok).toBe(true)
    if (listBody.ok) {
      expect(listBody.data.conversations[0]?.id).toBe(conversation.id)
    }

    const getResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/conversations/${conversation.id}`,
    })
    const getBody = parseResponse<{ conversation: Conversation; messages: unknown[] }>(getResponse.payload)
    expect(getBody.ok).toBe(true)
    if (getBody.ok) {
      expect(getBody.data.conversation.id).toBe(conversation.id)
      expect(getBody.data.messages).toEqual([])
    }
  })

  it("creates default conversations lazily, stores user messages, renames, and hard-deletes", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)

    const createResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations`,
      payload: {},
    })
    const createBody = parseResponse<{ conversation: Conversation }>(createResponse.payload)
    expect(createBody.ok).toBe(true)
    if (!createBody.ok) {
      throw new Error("Expected default conversation creation success")
    }
    const conversation = createBody.data.conversation
    expect(conversation.title).toBe("New conversation")

    let sqlite = new Database(dbPath)
    try {
      const sessionCount = sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE conversation_id = ?").get(conversation.id) as {
        count: number
      }
      expect(sessionCount.count).toBe(0)
    } finally {
      sqlite.close()
    }

    const messageResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations/${conversation.id}/messages`,
      payload: { content: "Extraordinary planning starts now" },
    })
    const messageBody = parseResponse<{ conversation: Conversation; message: Message }>(messageResponse.payload)
    expect(messageBody.ok).toBe(true)
    if (!messageBody.ok) {
      throw new Error("Expected message creation success")
    }
    expect(messageBody.data.conversation.title).toBe("Extraordin...")
    expect(messageBody.data.message.role).toBe("user")
    expect(messageBody.data.message.content).toBe("Extraordinary planning starts now")

    const secondMessageResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations/${conversation.id}/messages`,
      payload: { content: "Second message should not rename" },
    })
    const secondMessageBody = parseResponse<{ conversation: Conversation; message: Message }>(secondMessageResponse.payload)
    expect(secondMessageBody.ok).toBe(true)
    if (secondMessageBody.ok) {
      expect(secondMessageBody.data.conversation.title).toBe("Extraordin...")
    }

    sqlite = new Database(dbPath)
    try {
      const row = sqlite
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM sessions WHERE conversation_id = ?) AS session_count,
             (SELECT COUNT(*) FROM turns WHERE conversation_id = ? AND status = 'completed') AS completed_turn_count,
             (SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND role = 'user') AS user_message_count`,
        )
        .get(conversation.id, conversation.id, conversation.id) as {
        session_count: number
        completed_turn_count: number
        user_message_count: number
      }
      expect(row.session_count).toBe(1)
      expect(row.completed_turn_count).toBe(2)
      expect(row.user_message_count).toBe(2)
    } finally {
      sqlite.close()
    }

    const renameResponse = await app.inject({
      method: "PATCH",
      url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      payload: { title: "Manual title" },
    })
    const renameBody = parseResponse<{ conversation: Conversation }>(renameResponse.payload)
    expect(renameBody.ok).toBe(true)
    if (renameBody.ok) {
      expect(renameBody.data.conversation.title).toBe("Manual title")
    }

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/conversations/${conversation.id}`,
    })
    const deleteBody = parseResponse<{ deletedConversationId: string }>(deleteResponse.payload)
    expect(deleteBody.ok).toBe(true)
    if (deleteBody.ok) {
      expect(deleteBody.data.deletedConversationId).toBe(conversation.id)
    }

    const getDeletedResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/conversations/${conversation.id}`,
    })
    expect(getDeletedResponse.statusCode).toBe(404)

    const listResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/conversations` })
    const listBody = parseResponse<{ conversations: Conversation[] }>(listResponse.payload)
    expect(listBody.ok).toBe(true)
    if (listBody.ok) {
      expect(listBody.data.conversations).toEqual([])
    }

    sqlite = new Database(dbPath)
    try {
      const row = sqlite
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM conversations WHERE id = ?) AS conversation_count,
             (SELECT COUNT(*) FROM sessions WHERE conversation_id = ?) AS session_count,
             (SELECT COUNT(*) FROM turns WHERE conversation_id = ?) AS turn_count,
             (SELECT COUNT(*) FROM messages WHERE conversation_id = ?) AS message_count`,
        )
        .get(conversation.id, conversation.id, conversation.id, conversation.id) as {
        conversation_count: number
        session_count: number
        turn_count: number
        message_count: number
      }
      expect(row.conversation_count).toBe(0)
      expect(row.session_count).toBe(0)
      expect(row.turn_count).toBe(0)
      expect(row.message_count).toBe(0)
    } finally {
      sqlite.close()
    }
  })

  it("returns ApiError envelopes for invalid HTTP payloads", async () => {
    const app = await buildTestServer()
    await onboard(app)

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        description: "Missing required name and creationMode",
      },
    })
    const body = parseResponse<never>(response.payload)

    expect(response.statusCode).toBe(400)
    expect(body.ok).toBe(false)
    if (!body.ok) {
      expect(body.error.code).toBe("invalid_request")
    }
  })
})

describe("WebSocket API", () => {
  it("emits connection.ready on connect", async () => {
    const app = await buildTestServer()
    const socket = await connectWebSocket(app)
    try {
      const ready = await waitForEvent(socket, "connection.ready")
      expect(ready.payload.connectionId).toMatch(/^conn_/)
    } finally {
      socket.close()
    }
  })

  it("emits error.created for invalid JSON and invalid command envelopes", async () => {
    const app = await buildTestServer()
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")

      socket.send("not-json")
      const invalidJson = await waitForEvent(socket, "error.created")
      expect(invalidJson.payload.error.code).toBe("invalid_json")

      socket.send(JSON.stringify({ type: "chat.message.send" }))
      const invalidCommand = await waitForEvent(socket, "error.created")
      expect(invalidCommand.payload.error.code).toBe("invalid_websocket_command")
    } finally {
      socket.close()
    }
  })

  it("emits turn.started, message.completed, and turn.completed for chat.message.send", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Hello Socrates"))

      const started = await waitForEvent(socket, "turn.started")
      expect(started.payload.userMessage.content).toBe("Hello Socrates")

      const messageCompleted = await waitForEvent(socket, "message.completed")
      expect(messageCompleted.payload.message.role).toBe("assistant")
      expect(messageCompleted.payload.message.reasoning).toBe("Testing.")

      const turnCompleted = await waitForEvent(socket, "turn.completed")
      expect(turnCompleted.payload.turnId).toBe(started.payload.turnId)

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ messages: Message[] }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.messages.find((message) => message.role === "assistant")?.reasoning).toBe("Testing.")
      }

      const sqlite = new Database(dbPath)
      try {
        sqlite.prepare("UPDATE messages SET metadata_json = NULL WHERE conversation_id = ? AND role = 'assistant'").run(conversation.id)
      } finally {
        sqlite.close()
      }

      const hydratedResponse = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const hydratedBody = parseResponse<{ messages: Message[] }>(hydratedResponse.payload)
      expect(hydratedBody.ok).toBe(true)
      if (hydratedBody.ok) {
        expect(hydratedBody.data.messages.find((message) => message.role === "assistant")?.reasoning).toBe("Testing.")
      }

      const handle = openDatabase(dbPath)
      const store = new SocratesStore(handle)
      try {
        const indexed = handle.sqlite
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM trace_index_jobs WHERE turn_id = ? AND status = 'completed') AS completed_jobs,
               (SELECT COUNT(*) FROM trace_documents WHERE turn_id = ?) AS document_count,
               (SELECT COUNT(*) FROM trace_documents_fts) AS fts_count`,
          )
          .get(started.payload.turnId, started.payload.turnId) as { completed_jobs: number; document_count: number; fts_count: number }
        expect(indexed.completed_jobs).toBe(1)
        expect(indexed.document_count).toBeGreaterThanOrEqual(3)
        expect(indexed.fts_count).toBeGreaterThanOrEqual(indexed.document_count)

        const search = await store.retrieveToolTraces(project.id, conversation.id, { query: "Hello Socrates" })
        expect(search.appliedFilters.scope).toBe("current_conversation")
        expect(search.appliedFilters.defaultDateWindowApplied).toBe(true)
        expect(search.warnings?.join(" ")).toContain("Only viewing the current chat")
        expect(search.results.some((result) => result.kind === "message" && result.title.includes("User"))).toBe(true)
        expect(search.results[0]?.conversation?.title).toBe(conversation.title)
        expect(search.results[0]?.conversation?.isCurrentConversation).toBe(true)

        const handleResult = search.results.find((result) => result.kind === "message" && result.title.includes("User"))
        expect(handleResult).toBeDefined()
        if (handleResult) {
          const inspected = await store.retrieveToolTraces(project.id, conversation.id, { operation: "inspect", handle: handleResult.handle })
          expect(inspected.results[0]?.kind).toBe("exact_source")
          expect(inspected.results[0]?.conversation?.title).toBe(conversation.title)
          expect(inspected.results[0]?.conversation?.isCurrentConversation).toBe(true)
          expect(JSON.stringify(inspected.results[0])).toContain("Hello Socrates")
        }

        const semantic = await store.retrieveToolTraces(project.id, conversation.id, { query: "Hello", mode: "semantic" })
        expect(semantic.warnings?.join(" ")).toContain("Semantic trace retrieval is not configured")
      } finally {
        store.close()
      }
    } finally {
      socket.close()
    }
  })

  it("returns contextUsage from snapshots rather than cumulative tokenUsage", async () => {
    const app = await buildTestServer(tempDbPath(), createFixedContextAgent(12_345))
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(
        socket,
        chatMessageCommandWithRuntime(project.id, conversation.id, "Count this request", {
          modelId: "gpt-5.4-mini",
          thinkingEnabled: false,
          thinkingEffort: "none",
        }),
      )

      const snapshot = await waitForEvent(socket, "context.usage.snapshot")
      expect(snapshot.payload.contextUsedTokens).toBe(12_345)
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{
        tokenUsage: { totalTokens: number }
        contextUsage?: { contextUsedTokens: number; contextWindowTokens: number }
      }>(response.payload)

      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.tokenUsage.totalTokens).toBe(6)
        expect(body.data.contextUsage?.contextUsedTokens).toBe(12_345)
        expect(body.data.contextUsage?.contextUsedTokens).not.toBe(body.data.tokenUsage.totalTokens)
      }
    } finally {
      socket.close()
    }
  })

  it("creates verbatim anchors for long canonical user source text", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const rubric = `Canonical rubric. Follow this exactly and use this throughout.\n${"Every question must preserve the source wording and assignment rules. ".repeat(40)}`
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, rubric))
      const started = await waitForEvent(socket, "turn.started")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const handle = openDatabase(dbPath)
      const store = new SocratesStore(handle)
      try {
        const row = handle.sqlite
          .prepare("SELECT COUNT(*) AS count FROM trace_documents WHERE turn_id = ? AND source_kind = 'verbatim_anchor' AND preserve_verbatim = 1")
          .get(started.payload.turnId) as { count: number }
        expect(row.count).toBeGreaterThan(0)

        const search = await store.retrieveToolTraces(project.id, conversation.id, {
          query: "canonical rubric exact assignment rules",
          mode: "exact",
          include: ["messages"],
        })
        expect(search.results.some((result) => result.kind === "verbatim_anchor" && result.preserveVerbatim)).toBe(true)
      } finally {
        store.close()
      }
    } finally {
      socket.close()
    }
  })

  it("retrieves explicit turnNo matches without natural-language ordinal fallback", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const source = await createConversation(app, project.id, "Ordinal Source")
    const live = await createConversation(app, project.id, "Ordinal Live")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle)
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, source.id)
      insertCompletedTestTurn(handle.sqlite, source.id, sessionId, "First ordinary user message", "First assistant reply", new Date(Date.now() - 3_000).toISOString())
      const second = insertCompletedTestTurn(
        handle.sqlite,
        source.id,
        sessionId,
        "Second user message contains BLUE-LANTERN-42.",
        "Second assistant reply.",
        new Date(Date.now() - 2_000).toISOString(),
      )
      insertCompletedTestTurn(handle.sqlite, source.id, sessionId, "Third ordinary user message", "Third assistant reply", new Date(Date.now() - 1_000).toISOString())

      const ordinal = await store.retrieveToolTraces(project.id, live.id, {
        query: "what did I say in the second user message",
        scope: "project",
        conversationHint: "Ordinal Source",
        turnNo: 2,
        role: "user",
      })
      expect(ordinal.results[0]?.kind).toBe("message")
      expect(ordinal.results[0]?.sourceId).toBe(second.userMessageId)
      expect(ordinal.results[0]?.conversation?.title).toBe("Ordinal Source")
      expect(ordinal.results[0]?.conversation?.isCurrentConversation).toBe(false)
      expect(ordinal.results[0]?.turnNo).toBe(2)
      expect(ordinal.results[0]?.messageRole).toBe("user")
      expect(JSON.stringify(ordinal.results[0])).toContain(`"inspectArgs":{"operation":"inspect","messageId":"${second.userMessageId}"}`)

      const inspected = await store.retrieveToolTraces(project.id, live.id, { operation: "inspect", messageId: second.userMessageId })
      expect(inspected.results[0]?.conversation?.title).toBe("Ordinal Source")
      expect(inspected.results[0]?.conversation?.isCurrentConversation).toBe(false)
      expect(JSON.stringify(inspected.results)).toContain("BLUE-LANTERN-42")

      const lexicalOnly = await store.retrieveToolTraces(project.id, live.id, {
        query: "what did I say in the second user message",
        scope: "project",
        conversationHint: "Ordinal Source",
      })
      expect(JSON.stringify(lexicalOnly.results)).not.toContain("BLUE-LANTERN-42")

      const broad = await store.retrieveToolTraces(project.id, live.id, {
        query: "second user message",
        scope: "project",
        turnNo: 2,
        role: "user",
      })
      expect(broad.results).toHaveLength(0)
      expect(broad.warnings?.join(" ")).toContain("requires conversationHint")

      const outOfRange = await store.retrieveToolTraces(project.id, live.id, {
        query: "fifth user message",
        scope: "project",
        conversationHint: "Ordinal Source",
        turnNo: 5,
        role: "user",
      })
      expect(outOfRange.results).toHaveLength(0)
      expect(outOfRange.warnings?.join(" ")).toContain("No turn number 5")
    } finally {
      store.close()
    }
  })

  it("requires a precise conversation hint for broad turnNo lookup and inspects ordered conversation bundles", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const first = await createConversation(app, project.id, "Shared Ordinal")
    const second = await createConversation(app, project.id, "Shared Ordinal")
    const live = await createConversation(app, project.id, "Ordinal Live")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle)
    try {
      const firstSession = insertTestSession(handle.sqlite, project.id, first.id)
      const secondSession = insertTestSession(handle.sqlite, project.id, second.id)
      insertCompletedTestTurn(handle.sqlite, first.id, firstSession, "First shared source", "Assistant one", new Date(Date.now() - 5_000).toISOString())
      insertCompletedTestTurn(handle.sqlite, second.id, secondSession, "Second shared source", "Assistant two", new Date(Date.now() - 4_000).toISOString())
      insertCompletedTestTurn(handle.sqlite, second.id, secondSession, "Second conversation turn two", "Assistant turn two", new Date(Date.now() - 3_000).toISOString())
      insertCompletedTestTurn(handle.sqlite, second.id, secondSession, "Second conversation turn three", "Assistant turn three", new Date(Date.now() - 2_000).toISOString())

      const ambiguous = await store.retrieveToolTraces(project.id, live.id, {
        query: "first shared source",
        scope: "project",
        conversationHint: "Shared Ordinal",
        turnNo: 1,
        role: "user",
      })
      expect(ambiguous.results).toHaveLength(0)
      expect(ambiguous.warnings?.join(" ")).toContain("matched multiple conversations")

      const bundle = await store.retrieveToolTraces(project.id, live.id, {
        operation: "inspect",
        conversationId: second.id,
        startTurnNo: 2,
        turnLimit: 2,
      })
      expect(bundle.results[0]?.kind).toBe("exact_source")
      expect(JSON.stringify(bundle.results)).toContain("[turn 2")
      expect(JSON.stringify(bundle.results)).toContain("Second conversation turn two")
      expect(JSON.stringify(bundle.results)).toContain("[turn 3")
      expect(JSON.stringify(bundle.results)).not.toContain("Second shared source")
      expect(bundle.appliedFilters.startTurnNo).toBe(2)
      expect(bundle.appliedFilters.turnLimit).toBe(2)
    } finally {
      store.close()
    }
  })

  it("configures trace embeddings and uses semantic retrieval for active provider rows", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Semantic Source")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, createTestEmbeddingProvider())
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const ordinary = insertCompletedTestTurn(
        handle.sqlite,
        conversation.id,
        sessionId,
        "Ordinary setup note.",
        "Ordinary assistant reply.",
        new Date(Date.now() - 2_000).toISOString(),
      )
      const target = insertCompletedTestTurn(
        handle.sqlite,
        conversation.id,
        sessionId,
        "The durable semantic recall key is BLUE-LANTERN-42.",
        "Remembered.",
        new Date(Date.now() - 1_000).toISOString(),
      )
      store.indexTurnTraceDocuments(project.id, conversation.id, ordinary.turnId)
      store.indexTurnTraceDocuments(project.id, conversation.id, target.turnId)

      await store.configureProjectEmbeddings(project.id, {
        providerId: "ollama",
        modelId: "embeddinggemma",
        credentialSource: "none",
        ollamaBaseUrl: "http://127.0.0.1:11434",
      })
      const status = await waitForEmbeddingStatus(store, project.id, (current) => current.pendingDocuments === 0 && current.indexedDocuments > 0)
      expect(status.indexedDocuments).toBeGreaterThan(0)

      const semantic = await store.retrieveToolTraces(project.id, conversation.id, {
        query: "BLUE-LANTERN-42",
        mode: "semantic",
        include: ["messages"],
      })
      expect(semantic.warnings?.join(" ") ?? "").not.toContain("not configured")
      expect(semantic.results[0]?.kind).toBe("message")
      expect(JSON.stringify(semantic.results[0])).toContain(target.userMessageId)

      handle.sqlite
        .prepare(
          `INSERT INTO trace_embeddings
            (id, project_id, trace_document_id, provider_id, model_id, dimensions, content_hash, vector_json, status, created_at, updated_at, embedded_at)
           SELECT ?, project_id, id, 'openai', 'text-embedding-3-small', 3, content_hash, '[1,0,0]', 'completed', ?, ?, ?
           FROM trace_documents
           WHERE source_id = ?
           LIMIT 1`,
        )
        .run(createId("temb"), nowIso(), nowIso(), nowIso(), ordinary.userMessageId)
      const stillSemantic = await store.retrieveToolTraces(project.id, conversation.id, {
        query: "BLUE-LANTERN-42",
        mode: "semantic",
        include: ["messages"],
      })
      expect(JSON.stringify(stillSemantic.results[0])).toContain(target.userMessageId)
    } finally {
      store.close()
    }
  })

  it("checks embedding setup through HTTP without exposing workspace env secrets", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    expect(primaryWorkspace.path).toBeDefined()
    fs.writeFileSync(path.join(primaryWorkspace.path as string, ".env.local"), "OPENAI_API_KEY=sk-secret-test\n")

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/embeddings/check`,
      payload: { providerId: "openai", modelId: "text-embedding-3-small" },
    })
    const body = parseResponse<{
      ok: boolean
      workspaceEnvCandidates?: Array<{ fileName: string; hasOpenAiApiKey: boolean }>
    }>(response.payload)
    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.ok).toBe(true)
      expect(body.data.workspaceEnvCandidates).toContainEqual({ fileName: ".env.local", hasOpenAiApiKey: true })
      expect(JSON.stringify(body.data)).not.toContain("sk-secret-test")
    }
  })

  it("injects user, project, and project instructions into the agent prompt", async () => {
    const requests: unknown[] = []
    const app = await buildTestServer(tempDbPath(), createCapturingAgent(requests))
    await onboard(app, "Context User")
    const { project } = await createProject(app, "Context Project")
    await app.inject({
      method: "PUT",
      url: `/api/projects/${project.id}/instructions`,
      payload: { content: "Always answer from the project instructions." },
    })
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Use the context"))
      await waitForEvent(socket, "message.completed")

      const request = requests[0] as { system: string; messages: Array<{ content: string }> }
      expect(request.system).toContain("Name: Context User")
      expect(request.system).toContain("Name: Context Project")
      expect(request.system).toContain("A test project")
      expect(request.system).toContain("Always answer from the project instructions.")
      expect(request.messages.at(-1)?.content).toBe("Use the context")
    } finally {
      socket.close()
    }
  })

  it("keeps Gemini thought signatures during same-turn tool continuation and lists project resources", async () => {
    const requests: unknown[] = []
    const app = await buildTestServer(tempDbPath(), createGeminiSignatureAgent(requests))
    await onboard(app)
    const { project } = await createProject(app)
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources`,
      payload: {
        name: "Brief.pdf",
        kind: "pdf",
        source: "uploaded",
        uri: "/tmp/socrates/.socrates/resources/Brief.pdf",
      },
    })
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources`,
      payload: {
        name: "Appendix.pdf",
        kind: "pdf",
        source: "uploaded",
        uri: "/tmp/socrates/.socrates/resources/Appendix.pdf",
      },
    })
    await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/resources`,
      payload: {
        name: "Diagram.png",
        kind: "image",
        source: "uploaded",
        uri: "/tmp/socrates/.socrates/resources/Diagram.png",
      },
    })
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(
        socket,
        chatMessageCommandWithRuntime(project.id, conversation.id, "List resources", {
          providerId: "google",
          modelId: "gemini-3-flash-preview",
          thinkingEnabled: true,
          thinkingEffort: "medium",
        }),
      )
      const toolCompleted = await waitForEvent(socket, "tool.call.completed")
      expect(toolCompleted.payload.summary).toBe("Listed 1 of 2 project resources.")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const secondRequest = requests[1] as { messages: Array<{ role: string; content: unknown }> }
      expect(JSON.stringify(secondRequest.messages)).toContain("thoughtSignature")
      expect(JSON.stringify(secondRequest.messages)).toContain("sig_gemini_1")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ messages: Message[] }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(JSON.stringify(body.data.messages)).not.toContain("thoughtSignature")
      }

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Continue without replaying tools"))
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const nextTurnRequest = requests[2] as { messages: Array<{ role: string; content: unknown }> }
      expect(JSON.stringify(nextTurnRequest.messages)).toContain("Resources listed.")
      expect(JSON.stringify(nextTurnRequest.messages)).toContain("Continue without replaying tools")
      expect(JSON.stringify(nextTurnRequest.messages)).not.toContain("tool-result")
      expect(JSON.stringify(nextTurnRequest.messages)).not.toContain("sig_gemini_1")
    } finally {
      socket.close()
    }
  })

  it("reuses one persistent bash shell for tool calls in the same turn and hydrates tool history", async () => {
    const app = await buildTestServer(tempDbPath(), createPersistentBashAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Use bash state", { approvalMode: "approve_all" }))
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{
        toolRuns: Array<{ toolCallId: string; shell?: { stdout: string; cwd: string }; durationMs?: number }>
      }>(response.payload)

      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.toolRuns).toHaveLength(2)
        expect(body.data.toolRuns[1]?.toolCallId).toBe("tcall_state")
        expect(body.data.toolRuns[1]?.shell?.stdout).toBe("ok nested")
        expect(body.data.toolRuns[1]?.shell?.cwd.endsWith("nested")).toBe(true)
        expect(body.data.toolRuns[1]?.durationMs).toBeGreaterThanOrEqual(0)
      }
    } finally {
      socket.close()
    }
  })

  it("hydrates approved tool calls with approval status", async () => {
    const app = await buildTestServer(tempDbPath(), createApprovalToolAgent())
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Run approved command"))
      const approval = await waitForEvent(socket, "approval.requested")
      sendCommand(socket, {
        id: createId("evt"),
        type: "approval.decide",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: {
          approvalId: approval.payload.approvalId,
          decision: "approved",
        },
      })
      await waitForEvent(socket, "approval.resolved")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{
        toolRuns: Array<{ toolCallId: string; approval?: { status: string; decision?: string }; shell?: { exitCode?: number | null } }>
      }>(response.payload)

      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.toolRuns[0]?.toolCallId).toBe("tcall_approval")
        expect(body.data.toolRuns[0]?.approval?.status).toBe("approved")
        expect(body.data.toolRuns[0]?.approval?.decision).toBe("approved")
        expect(body.data.toolRuns[0]?.shell?.exitCode).toBe(0)
        expect(fs.readFileSync(path.join(primaryWorkspace.path ?? "", "approved.txt"), "utf8")).toBe("approved")
      }
    } finally {
      socket.close()
    }
  })

  it("rejects a second chat.message.send while a turn is active", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "First"))
      await waitForEvent(socket, "turn.started")

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Second"))
      const error = await waitForEvent(socket, "error.created")
      expect(error.payload.error.code).toBe("turn_already_active")
    } finally {
      socket.close()
    }
  })

  it("emits turn.failed and does not persist an assistant message when the provider fails", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath, createFailingAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Please fail"))
      const started = await waitForEvent(socket, "turn.started")

      const failed = await waitForEvent(socket, "turn.failed")
      expect(failed.payload.turnId).toBe(started.payload.turnId)
      expect(failed.payload.error.code).toBe("provider_failed")

      const sqlite = new Database(dbPath)
      try {
        const row = sqlite
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM messages WHERE conversation_id = ? AND role = 'assistant') AS assistant_count,
               (SELECT COUNT(*) FROM turns WHERE id = ? AND status = 'failed') AS failed_turn_count,
               (SELECT COUNT(*) FROM model_calls WHERE turn_id = ? AND status = 'failed') AS failed_model_call_count,
               (SELECT COUNT(*) FROM trace_index_jobs WHERE turn_id = ? AND status = 'completed') AS completed_trace_jobs,
               (SELECT COUNT(*) FROM trace_documents WHERE turn_id = ? AND source_kind = 'error') AS trace_error_count`,
          )
          .get(conversation.id, started.payload.turnId, started.payload.turnId, started.payload.turnId, started.payload.turnId) as {
          assistant_count: number
          failed_turn_count: number
          failed_model_call_count: number
          completed_trace_jobs: number
          trace_error_count: number
        }
        expect(row.assistant_count).toBe(0)
        expect(row.failed_turn_count).toBe(1)
        expect(row.failed_model_call_count).toBe(1)
        expect(row.completed_trace_jobs).toBe(1)
        expect(row.trace_error_count).toBe(1)
      } finally {
        sqlite.close()
      }
    } finally {
      socket.close()
    }
  })

  it("persists partial assistant text on cancel and carries it into the next turn history", async () => {
    const dbPath = tempDbPath()
    const requests: unknown[] = []
    const app = await buildTestServer(dbPath, createCancellablePartialAgent(requests))
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Please stop soon"))
      const started = await waitForEvent(socket, "turn.started")
      await waitForEvent(socket, "agent.answer.delta")

      sendCommand(socket, {
        id: createId("evt"),
        type: "chat.turn.cancel",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: {
          turnId: started.payload.turnId,
          reason: "User clicked stop",
        },
      })

      const cancelled = await waitForEvent(socket, "turn.cancelled")
      expect(cancelled.payload.turnId).toBe(started.payload.turnId)
      expect(cancelled.payload.reason).toBe("User clicked stop")
      expect(cancelled.payload.partialAssistantMessage?.content).toBe("Partial answer before stop.")
      expect(cancelled.payload.partialAssistantMessage?.status).toBe("cancelled")
      expect(cancelled.payload.partialAssistantMessage?.partial).toBe(true)

      await delay(150)
      const sqlite = new Database(dbPath)
      try {
        const row = sqlite
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM trace_index_jobs WHERE turn_id = ? AND status = 'completed') AS completed_trace_jobs,
               (SELECT COUNT(*) FROM trace_documents WHERE turn_id = ? AND source_kind = 'message') AS trace_message_count`,
          )
          .get(started.payload.turnId, started.payload.turnId) as { completed_trace_jobs: number; trace_message_count: number }
        expect(row.completed_trace_jobs).toBe(1)
        expect(row.trace_message_count).toBeGreaterThanOrEqual(2)
      } finally {
        sqlite.close()
      }

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Continue from that"))
      await waitForEvent(socket, "message.completed")

      const secondRequest = requests[1] as { messages: Array<{ role: string; content: string }> }
      expect(secondRequest.messages.map((message) => `${message.role}:${message.content}`)).toContain(
        "assistant:Partial answer before stop.",
      )
      expect(secondRequest.messages.at(-1)).toMatchObject({ role: "user", content: "Continue from that" })
    } finally {
      socket.close()
    }
  })

  it("finalizes pending approvals and tool rows when a turn is cancelled", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath, createApprovalWaitingAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Install something"))
      const started = await waitForEvent(socket, "turn.started")
      await waitForEvent(socket, "approval.requested")

      sendCommand(socket, {
        id: createId("evt"),
        type: "chat.turn.cancel",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: {
          turnId: started.payload.turnId,
          reason: "User clicked stop",
        },
      })
      await waitForEvent(socket, "turn.cancelled")
      await delay(100)

      const sqlite = new Database(dbPath)
      try {
        const approval = sqlite.prepare("SELECT status, decision FROM approvals WHERE turn_id = ?").get(started.payload.turnId) as {
          status: string
          decision: string
        }
        const tool = sqlite.prepare("SELECT status FROM tool_calls WHERE turn_id = ?").get(started.payload.turnId) as {
          status: string
        }
        const modelCall = sqlite.prepare("SELECT status FROM model_calls WHERE turn_id = ?").get(started.payload.turnId) as {
          status: string
        }
        expect(approval).toEqual({ status: "rejected", decision: "rejected" })
        expect(tool.status).toBe("cancelled")
        expect(modelCall.status).toBe("cancelled")
      } finally {
        sqlite.close()
      }
    } finally {
      socket.close()
    }
  })
})
