import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import type { ApiResponse, Conversation, Message, Project, ProjectInstructions, ProjectResource, ProjectWorkspace, ServerEvent, User } from "@socrates/contracts"
import { clientCommandSchema, serverEventSchema } from "@socrates/contracts"
import { SocratesAgent } from "@socrates/core"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { buildServer } from "../app"
import { openDatabase, runMigrations } from "../db/client"

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

const createTestAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
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

const createCancellablePartialAgent = (requests: unknown[]): SocratesAgent => {
  let call = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
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

const createGeminiSignatureAgent = (requests: unknown[]): SocratesAgent => {
  let step = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
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
        "tool_calls",
        "approvals",
        "shell_commands",
        "shell_output_chunks",
        "file_operations",
        "patches",
        "errors",
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
    } finally {
      socket.close()
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
               (SELECT COUNT(*) FROM model_calls WHERE turn_id = ? AND status = 'failed') AS failed_model_call_count`,
          )
          .get(conversation.id, started.payload.turnId, started.payload.turnId) as {
          assistant_count: number
          failed_turn_count: number
          failed_model_call_count: number
        }
        expect(row.assistant_count).toBe(0)
        expect(row.failed_turn_count).toBe(1)
        expect(row.failed_model_call_count).toBe(1)
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

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Continue from that"))
      await waitForEvent(socket, "message.completed")

      const secondRequest = requests[1] as { messages: Array<{ role: string; content: string }> }
      expect(secondRequest.messages.map((message) => `${message.role}:${message.content}`)).toContain(
        "assistant:Partial answer before stop.",
      )
      expect(secondRequest.messages.at(-1)).toEqual({ role: "user", content: "Continue from that" })
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
