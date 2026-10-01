import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import yazl from "yazl"
import type {
  ApiResponse,
  Conversation,
  GetProviderCredentialsStatusResponse,
  Message,
  MessageAttachment,
  ListModelsResponse,
  Project,
  ProjectEmbeddingStatus,
  ProjectInstructions,
  ProjectResource,
  ProjectWorkspace,
  ServerEvent,
  ChatCompaction,
  MemoryCompaction,
  MemoryAgentJournalOutput,
  McpServerStatus,
  ModelSettingsResolution,
  SkillSummary,
  User,
  WorkerModelSettings,
} from "@socrates/contracts"
import { clientCommandSchema, memoryDocRequiredSections, serverEventSchema } from "@socrates/contracts"
import { MAX_IMAGE_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENT_BYTES, MAX_MESSAGE_ATTACHMENTS } from "@socrates/contracts"
import { SocratesAgent } from "@socrates/core"
import type { EmbeddingProvider, ModelProvider, StructuredModelRequest, StructuredModelResult } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { buildServer } from "../app"
import { openDatabase, runMigrations } from "../db/client"
import { SocratesStore } from "../services/store"
import { buildStructuredMemoryDoc, parseMemoryDoc, patchMemoryDocSection } from "../services/store/memoryDocParser"
import { ToolDocsStore } from "../services/store/toolDocsStore"
import { TerminalSupervisorClient } from "../ws/terminalSupervisorClient"
import { terminalHostSocketPath, terminalSupervisorSocketPath } from "../ws/terminalSupervisorPaths"

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

const multipartFiles = (
  boundary: string,
  files: Array<{ name: string; mimeType: string; data: Buffer }>,
): Buffer => Buffer.concat([
  ...files.flatMap((file) => [
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${file.name}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`),
    file.data,
    Buffer.from("\r\n"),
  ]),
  Buffer.from(`--${boundary}--\r\n`),
])

const zipFiles = (files: Record<string, string>): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile()
    const chunks: Buffer[] = []
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk))
    zip.outputStream.once("error", reject)
    zip.outputStream.once("end", () => resolve(Buffer.concat(chunks)))
    for (const [filePath, content] of Object.entries(files)) zip.addBuffer(Buffer.from(content), filePath)
    zip.end()
  })

const writeTestChatGptCodexTokens = (socratesHome: string): void => {
  const credentialDir = path.join(socratesHome, ".credentials")
  fs.mkdirSync(credentialDir, { recursive: true })
  fs.writeFileSync(
    path.join(credentialDir, "openai-chatgpt-oauth.json"),
    `${JSON.stringify({
      refresh: "refresh-test",
      access: "access-test",
      expires: Date.now() + 60 * 60 * 1000,
      updatedAt: nowIso(),
    })}\n`,
  )
}

const expectStructuredToolDoc = (socratesHome: string, relativePath: string): string => {
  const filePath = path.join(socratesHome, "tool_usage", relativePath)
  const content = fs.readFileSync(filePath, "utf8")
  const index = parseMemoryDoc(content, {
    docType: "tool_doc",
    ownerTool: "tool_docs",
    scope: "global",
    path: `tool_usage/${relativePath.replaceAll(path.sep, "/")}`,
    projectId: "global",
    indexTags: ["tool_usage"],
  })
  expect(index.warnings, relativePath).toBeUndefined()
  expect(index.sections.map((section) => section.sectionId), relativePath).toEqual(memoryDocRequiredSections.tool_doc)
  expect(content, relativePath).not.toContain("Legacy Content")
  expect(content, relativePath).not.toContain("legacy_content")
  expect(content, relativePath).not.toContain("What this tool guidance is for")
  return content
}

const validServerChatCompaction = (overrides: Partial<ChatCompaction> = {}): ChatCompaction => ({
  schemaVersion: 1,
  goal: "Persist compacted context.",
  constraints: [],
  done: [],
  inProgress: [],
  blocked: [],
  decisions: [],
  nextSteps: [],
  criticalContext: [],
  relevantFiles: [],
  toolState: [],
  anchors: ["Turn 1: inspect compacted source."],
  ...overrides,
})

const validServerMemoryCompaction = (overrides: Partial<MemoryCompaction> = {}): MemoryCompaction => ({
  schemaVersion: 1,
  goal: "Continue the global memory-agent run.",
  manifestScope: ["Covered compacted memory-agent evidence."],
  investigated: ["Compressed memory-agent evidence."],
  changed: [],
  skipped: [],
  blocked: [],
  decisions: [],
  nextSteps: ["Continue the memory-agent run."],
  criticalContext: [],
  toolState: [],
  anchors: ["Turn 1: inspect compacted memory-agent evidence."],
  ...overrides,
})

const validMemoryAgentJournal = (overrides: Partial<MemoryAgentJournalOutput> = {}): MemoryAgentJournalOutput => ({
  summary: "Completed the bounded Memory Agent investigation.",
  patternsObserved: [],
  skillsAffected: [],
  decisions: [],
  openInvestigations: [],
  nextRunFocus: [],
  ...overrides,
})

const hasMemoryCompactionMessage = (messages: unknown[]): boolean =>
  messages.some((message) => {
    if (!message || typeof message !== "object") {
      return false
    }
    const content = (message as { content?: unknown }).content
    return typeof content === "string" && content.includes("socrates_internal_memory_context_compaction")
  })

const hasToolResultPart = (messages: unknown[]): boolean =>
  messages.some((message) => {
    if (!message || typeof message !== "object") {
      return false
    }
    const content = (message as { content?: unknown }).content
    return Array.isArray(content) && content.some((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "tool-result")
  })

const buildTestServer = async (
  dbPath = tempDbPath(),
  agent = createTestAgent(),
  options: {
    socratesHome?: string
    titleProvider?: ModelProvider | false
    memoryProvider?: ModelProvider
    embeddingProvider?: EmbeddingProvider
    preserveTerminalsOnClose?: boolean
  } = {},
): Promise<TestServer> => {
  const socratesHome = options.socratesHome ?? path.dirname(dbPath)
  if (dbPath !== ":memory:") {
    fs.mkdirSync(socratesHome, { recursive: true })
    const envPath = path.join(socratesHome, ".env")
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, "OPENAI_API_KEY=\"sk-test-openai\"\n", { mode: 0o600 })
    }
  }
  const app = await buildServer({ dbPath, agent, preserveTerminalsOnClose: false, ...options, socratesHome })
  servers.push(app)
  return app
}

const closeTestServer = async (app: TestServer): Promise<void> => {
  await app.close()
  const index = servers.indexOf(app)
  if (index >= 0) {
    servers.splice(index, 1)
  }
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const waitForFileText = async (filePath: string, text: string): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.readFileSync(filePath, "utf8").includes(text)) {
      return
    }
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${text} in ${filePath}`)
}
const psQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`
const nodeCommand = (script: string): string =>
  process.platform === "win32"
    ? `& ${psQuote(process.execPath)} -e ${psQuote(`eval(Buffer.from("${Buffer.from(script).toString("base64")}", "base64").toString())`)}`
    : `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`eval(Buffer.from("${Buffer.from(script).toString("base64")}", "base64").toString())`)}`

const repoDocsPreflightCall = (toolCallId = "tcall_repo_docs_preflight") =>
  ({
    type: "model.tool_call.completed" as const,
    toolCall: {
      toolCallId,
      toolName: "repo_docs",
      input: { operation: "read", path: "REPO_RULES.md" },
    },
  })

const writeCredentialFlowMcpScript = (root: string): string => {
  const scriptPath = path.join(root, "credential-flow-mcp.cjs")
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(scriptPath, [
    "const readline = require('node:readline');",
    "const rl = readline.createInterface({ input: process.stdin });",
    "const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');",
    "rl.on('line', (line) => {",
    "  const message = JSON.parse(line);",
    "  if (message.method === 'initialize') return send(message.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'credential-flow', version: '1.0.0' } });",
    "  if (message.method === 'tools/list') return send(message.id, { tools: [{ name: 'noop', description: 'No-op test tool.' }] });",
    "  if (message.id !== undefined) send(message.id, {});",
    "});",
  ].join("\n"))
  return scriptPath
}

const projectNotesPreflightCall = (toolCallId = "tcall_project_notes_preflight") =>
  ({
    type: "model.tool_call.completed" as const,
    toolCall: {
      toolCallId,
      toolName: "project_docs",
      input: { operation: "read", area: "notes" },
    },
  })

const projectMemoryReviewCall = (toolCallId = "tcall_project_memory_review") =>
  ({
    type: "model.tool_call.completed" as const,
    toolCall: {
      toolCallId,
      toolName: "project_docs",
      input: { operation: "read", area: "memory" },
    },
  })

const serializedRequestMessages = (request: { messages: unknown }): string => JSON.stringify(request.messages)

const requestHasToolResult = (request: { messages: unknown }, providerToolCallId: string): boolean =>
  serializedRequestMessages(request).includes(providerToolCallId)

const plainRequestText = (request: { messages: Array<{ content: unknown }> }): string =>
  request.messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n")

const processExists = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const waitForProcessExit = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if (!processExists(pid)) {
      return
    }
    await delay(50)
  }
  throw new Error(`Timed out waiting for process ${pid} to exit`)
}

const waitForProjectEmbeddingStatus = async (
  store: SocratesStore,
  projectId: string,
  predicate: (status: ProjectEmbeddingStatus) => boolean,
): Promise<ProjectEmbeddingStatus> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const status = store.getProjectEmbeddingStatus(projectId)
    if (predicate(status)) {
      return status
    }
    await delay(20)
  }
  throw new Error(`Timed out waiting for embedding status: ${JSON.stringify(store.getProjectEmbeddingStatus(projectId))}`)
}

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

const createSkillWriterProvider = (skipFirstApprovedTask = false): ModelProvider => {
  let writeIndex = 0
  let skippedApprovedTask = false
  return {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const hasSkillWrite = request.tools?.some((tool) => tool.name === "skill_write") ?? false
      const serialized = serializedRequestMessages(request)
      if (hasSkillWrite && skipFirstApprovedTask && !skippedApprovedTask && !serialized.includes('"tool-result"')) {
        skippedApprovedTask = true
        yield { type: "model.answer.delta", text: "Drafted the skill but failed to call the required write tool." }
        yield { type: "model.completed" }
        return
      }
      if (hasSkillWrite && !serialized.includes('"tool-result"')) {
        writeIndex += 1
        const taskText = plainRequestText(request)
        const scope = /\bscope:\s*(global|project)/.exec(taskText)?.[1] ?? "global"
        const operation = /\boperation:\s*(create|update)/.exec(taskText)?.[1] ?? "create"
        const name = /\bskill_name:\s*([a-z0-9-]+)/.exec(taskText)?.[1] ?? `generated-skill-${writeIndex}`
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: `skill_writer_write_${writeIndex}`,
            toolName: "skill_write",
            input: {
              scope,
              operation,
              name,
              changeSummary: `Create the approved ${name} workflow.`,
              evidenceTurnIds: [],
              content: [
                "---",
                `name: ${name}`,
                `description: Use when handling ${name.replaceAll("-", " ")} workflows.`,
                "---",
                "",
                `# ${name}`,
                "",
                "Use this skill when the approved request matches this reusable workflow.",
                "",
                "## Workflow",
                "",
                "- Inspect the relevant local context first.",
                "- Apply the approved guidance narrowly.",
                "- Verify the result with the smallest meaningful check.",
                "",
              ].join("\n"),
            },
          },
        }
        yield { type: "model.completed", finishReason: "tool-calls" }
        return
      }
      yield { type: "model.answer.delta", text: "Skill written." }
      yield { type: "model.completed", usage: { totalTokens: 42 } }
    },
  }
}

const latestUserContent = (messages: Array<{ role?: string; content?: unknown }>): unknown => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === "user") {
      return message.content
    }
  }
  return undefined
}

const createTestAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      yield { type: "model.reasoning.delta", text: "Testing." }
      yield { type: "model.answer.delta", text: `Echo: ${latestUserContent(request.messages) ?? ""}` }
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

const createTitleProvider = (title: string, requestedModelIds: string[] = []): ModelProvider => ({
  countTokens: fakeCountTokens,
  async *stream(request) {
    requestedModelIds.push(request.modelId)
    yield { type: "model.answer.delta", text: title }
    yield {
      type: "model.completed",
      usage: {
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
      },
    }
  },
})

const createFallbackTitleProvider = (title: string, requestedModelIds: string[]): ModelProvider => ({
  countTokens: fakeCountTokens,
  async *stream(request) {
    requestedModelIds.push(request.modelId)
    if (request.modelId === "meta-llama/llama-4-maverick") {
      yield { type: "model.failed", error: new Error("Primary title model unavailable") }
      return
    }
    yield { type: "model.answer.delta", text: title }
    yield {
      type: "model.completed",
      usage: {
        inputTokens: 8,
        outputTokens: 4,
        totalTokens: 12,
      },
    }
  },
})

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

const createReconnectStreamingAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      yield { type: "model.answer.delta", text: "Part one." }
      await delay(150)
      yield { type: "model.answer.delta", text: " Part two." }
      await delay(50)
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 } }
    },
  }
  return new SocratesAgent(provider)
}

const createSlowStreamingAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      yield { type: "model.answer.delta", text: "Started." }
      await delay(500)
      yield { type: "model.answer.delta", text: " Finished." }
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 4, totalTokens: 8 } }
    },
  }
  return new SocratesAgent(provider)
}

const createConcurrentWorkspaceMutationAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const serializedMessages = JSON.stringify(request.messages)
      const hasMutationToolResult = serializedMessages.includes("tcall_slow_workspace_mutation") || serializedMessages.includes("tcall_fast_workspace_mutation")
      const hasMemoryReview = serializedMessages.includes("tcall_project_memory_after_workspace_mutation")
      const isSlow = serializedMessages.includes("slow workspace mutation")
      const isFast = serializedMessages.includes("fast workspace mutation")
      if (!hasMutationToolResult && (isSlow || isFast)) {
      const script = isSlow
        ? "setTimeout(() => { require('fs').appendFileSync('race.txt', 'first\\n') }, 250); setTimeout(() => process.exit(0), 300)"
        : "require('fs').appendFileSync('race.txt', 'second\\n')"
      yield projectNotesPreflightCall(isSlow ? "tcall_project_notes_before_slow_workspace_mutation" : "tcall_project_notes_before_fast_workspace_mutation")
      yield repoDocsPreflightCall(isSlow ? "tcall_repo_docs_before_slow_workspace_mutation" : "tcall_repo_docs_before_fast_workspace_mutation")
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: isSlow ? "tcall_slow_workspace_mutation" : "tcall_fast_workspace_mutation",
          toolName: "bash",
          input: { command: nodeCommand(script) },
        },
      }
        yield { type: "model.completed" }
        return
      }
      if (hasMutationToolResult && !hasMemoryReview) {
        yield projectMemoryReviewCall("tcall_project_memory_after_workspace_mutation")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: isSlow ? "Slow mutation done." : "Fast mutation done." }
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
    },
  }
  return new SocratesAgent(provider)
}

const createApprovalWaitingAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      yield projectNotesPreflightCall("tcall_project_notes_before_waiting_bash")
      yield repoDocsPreflightCall("tcall_repo_docs_before_waiting_bash")
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

const createCredentialFlowAgent = (scriptPath: string): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const serialized = JSON.stringify(request.messages)
      if (!serialized.includes("tcall_credential_repo_preflight")) {
        yield projectNotesPreflightCall("tcall_credential_notes_preflight")
        yield repoDocsPreflightCall("tcall_credential_repo_preflight")
        yield { type: "model.completed", finishReason: "tool-calls" }
        return
      }
      if (!serialized.includes("tcall_secure_mcp_configure")) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_secure_mcp_configure",
            toolName: "mcp_registry",
            input: {
              operation: "configure",
              scope: "project",
              server: {
                id: "credential-flow",
                label: "Credential Flow MCP",
                command: process.execPath,
                args: [scriptPath],
                secretBindings: [
                  { envKey: "FIRST_TEST_KEY", source: "user_input" },
                  { envKey: "SECOND_TEST_KEY", source: "user_input" },
                ],
              },
            },
          },
        }
        yield { type: "model.completed", finishReason: "tool-calls" }
        return
      }
      yield { type: "model.answer.delta", text: "Credential flow completed." }
      yield { type: "model.completed", usage: { inputTokens: 6, outputTokens: 3, totalTokens: 9 } }
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

const createEmptyResponseAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      yield {
        type: "model.completed",
        usage: {
          inputTokens: 4,
          outputTokens: 1,
          totalTokens: 5,
        },
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
        const setupCommand = process.platform === "win32" ? "New-Item -ItemType Directory -Force nested | Out-Null; Set-Location nested; Get-Location" : "mkdir -p nested && cd nested && pwd"
        yield projectNotesPreflightCall("tcall_project_notes_before_cd")
        yield repoDocsPreflightCall("tcall_repo_docs_before_cd")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_cd",
            toolName: "bash",
            input: { command: setupCommand },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 2) {
        const stateCommand =
          process.platform === "win32"
            ? 'Write-Output -NoNewline "$(Split-Path -Leaf (Get-Location))"'
            : 'printf "$(basename "$PWD")"'
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_state",
            toolName: "bash",
            input: { command: stateCommand },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 3) {
        yield projectMemoryReviewCall("tcall_project_memory_after_persistent_bash")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Shell state preserved." }
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
    },
  }
  return new SocratesAgent(provider)
}

const createRecoveringBashAgent = (): SocratesAgent => {
  let step = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
        yield projectNotesPreflightCall("tcall_project_notes_before_break_shell")
        yield repoDocsPreflightCall("tcall_repo_docs_before_break_shell")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_break_shell",
            toolName: "bash",
            input: { command: "cd /Users/example/Test && python3 -m venv venv" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 2) {
        const recoveryCommand = process.platform === "win32" ? "Write-Output -NoNewline recovered" : "printf recovered"
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_after_reset",
            toolName: "bash",
            input: { command: recoveryCommand },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 3) {
        yield projectMemoryReviewCall("tcall_project_memory_after_recovering_bash")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Recovered after shell reset." }
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
        const command =
          process.platform === "win32"
            ? `[System.IO.File]::WriteAllText((Join-Path (Get-Location) ${psQuote("approved.txt")}), ${psQuote("approved")})`
            : "printf approved > approved.txt"
        yield projectNotesPreflightCall("tcall_project_notes_before_approval")
        yield repoDocsPreflightCall("tcall_repo_docs_before_approval")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_approval",
            toolName: "bash",
            input: { command },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 2) {
        yield projectMemoryReviewCall("tcall_project_memory_after_approval")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Approved command ran." }
      yield { type: "model.completed", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } }
    },
  }
  return new SocratesAgent(provider)
}

const createVerifiedEditAgent = (): SocratesAgent => {
  let step = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
        yield projectNotesPreflightCall("tcall_project_notes_before_verified_edit")
        yield repoDocsPreflightCall("tcall_repo_docs_before_verified_edit")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_read_readme",
            toolName: "read",
            input: { path: "README.md" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 2) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_verified_edit",
            toolName: "edit",
            input: { path: "README.md", oldString: "old", newString: "new" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 3) {
        yield projectMemoryReviewCall("tcall_project_memory_after_verified_edit")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Verified edit done." }
      yield { type: "model.completed", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } }
    },
  }
  return new SocratesAgent(provider)
}

const createVerifiedPatchAgent = (): SocratesAgent => {
  let step = 0
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
        yield projectNotesPreflightCall("tcall_project_notes_before_verified_patch")
        yield repoDocsPreflightCall("tcall_repo_docs_before_verified_patch")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_read_patch_target",
            toolName: "read",
            input: { path: "README.md" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 2) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_verified_patch",
            toolName: "apply_patch",
            input: {
              patchText: [
                "*** Begin Patch",
                "*** Update File: README.md",
                "@@",
                "-hello old world",
                "+hello patched world",
                "*** End Patch",
              ].join("\n"),
            },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 3) {
        yield projectMemoryReviewCall("tcall_project_memory_after_verified_patch")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Verified patch done." }
      yield { type: "model.completed", usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 } }
    },
  }
  return new SocratesAgent(provider)
}

const createStaleEditAgent = (): SocratesAgent => {
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      yield projectNotesPreflightCall("tcall_project_notes_before_stale_edit")
      yield repoDocsPreflightCall("tcall_repo_docs_before_stale_edit")
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: "tcall_stale_edit",
          toolName: "edit",
          input: { path: "README.md", content: "new", overwrite: true },
        },
      }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createConversationTerminalAgent = (requests: unknown[]): SocratesAgent => {
  const command = `node -e "console.log('terminal-ready'); setInterval(() => console.log('terminal-tick'), 250)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      requests.push(request)
      const latestUser = String(latestUserContent(request.messages) ?? "")
      if (latestUser.includes("Start a terminal")) {
        if (!requestHasToolResult(request, "tcall_terminal_start")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_terminal_start")
          yield repoDocsPreflightCall("tcall_repo_docs_before_terminal_start")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_terminal_start",
              toolName: "bash",
              input: { operation: "start", command, name: "server-test" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_terminal_start")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_terminal_start")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Terminal observed." }
        yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
        return
      }
      if (latestUser.includes("Stop terminal by name")) {
        if (!requestHasToolResult(request, "tcall_terminal_stop_by_name")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_terminal_stop_by_name")
          yield repoDocsPreflightCall("tcall_repo_docs_before_terminal_stop_by_name")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_terminal_stop_by_name",
              toolName: "bash",
              input: { operation: "stop", name: "server-test" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_terminal_stop_by_name")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_terminal_stop_by_name")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Terminal observed." }
        yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
        return
      }
      yield { type: "model.answer.delta", text: "Terminal observed." }
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
    },
  }
  return new SocratesAgent(provider)
}

const createUntargetedTerminalStopAgent = (): SocratesAgent => {
  const command = `node -e "console.log('solo-ready'); setInterval(() => console.log('solo-tick'), 250)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const latestUser = String(latestUserContent(request.messages) ?? "")
      if (latestUser.includes("Start one terminal")) {
        if (!requestHasToolResult(request, "tcall_terminal_start_solo")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_terminal_start_solo")
          yield repoDocsPreflightCall("tcall_repo_docs_before_terminal_start_solo")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_terminal_start_solo",
              toolName: "bash",
              input: { operation: "start", command, name: "solo-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_terminal_start_solo")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_terminal_start_solo")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Solo Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (latestUser.includes("Stop the only terminal")) {
        if (!requestHasToolResult(request, "tcall_terminal_stop_solo")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_terminal_stop_solo")
          yield repoDocsPreflightCall("tcall_repo_docs_before_terminal_stop_solo")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_terminal_stop_solo",
              toolName: "bash",
              input: { operation: "stop" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_terminal_stop_solo")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_terminal_stop_solo")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Solo Terminal stopped." }
        yield { type: "model.completed" }
        return
      }
    },
  }
  return new SocratesAgent(provider)
}

const createAmbiguousTerminalStopAgent = (): SocratesAgent => {
  const command = `node -e "console.log('ambiguous-ready'); setInterval(() => console.log('ambiguous-tick'), 250)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const latestUser = String(latestUserContent(request.messages) ?? "")
      if (latestUser.includes("Start alpha")) {
        if (!requestHasToolResult(request, "tcall_terminal_start_alpha")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_terminal_start_alpha")
          yield repoDocsPreflightCall("tcall_repo_docs_before_terminal_start_alpha")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_terminal_start_alpha",
              toolName: "bash",
              input: { operation: "start", command, name: "alpha-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_terminal_start_alpha")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_terminal_start_alpha")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Alpha Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (latestUser.includes("Start beta")) {
        if (!requestHasToolResult(request, "tcall_terminal_start_beta")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_terminal_start_beta")
          yield repoDocsPreflightCall("tcall_repo_docs_before_terminal_start_beta")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_terminal_start_beta",
              toolName: "bash",
              input: { operation: "start", command, name: "beta-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_terminal_start_beta")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_terminal_start_beta")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Beta Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (latestUser.includes("Stop without target")) {
        yield projectNotesPreflightCall("tcall_project_notes_before_terminal_stop_ambiguous")
        yield repoDocsPreflightCall("tcall_repo_docs_before_terminal_stop_ambiguous")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_terminal_stop_ambiguous",
            toolName: "bash",
            input: { operation: "stop" },
          },
        }
        yield { type: "model.completed" }
        return
      }
    },
  }
  return new SocratesAgent(provider)
}

const createInteractiveTerminalAgent = (): SocratesAgent => {
  const command = nodeCommand(`
process.stdout.write("? Select a component library › - Use arrow-keys. Return to submit.\\n› Radix\\n  Base")
process.stdin.on("data", (data) => {
  const text = data.toString("utf8")
  if (text.includes(String.fromCharCode(27) + "[B")) {
    process.stdout.write("\\nselected Base")
  }
  if (text.includes("\\r") || text.includes("\\n")) {
    process.stdout.write("\\nsubmitted")
    process.exit(0)
  }
})
setInterval(() => {}, 1000)
`)
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      if (!requestHasToolResult(request, "tcall_interactive_terminal_start")) {
        yield projectNotesPreflightCall("tcall_project_notes_before_interactive_terminal_start")
        yield repoDocsPreflightCall("tcall_repo_docs_before_interactive_terminal_start")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_interactive_terminal_start",
            toolName: "bash",
            input: { operation: "start", command, name: "interactive-test", inputMode: "user" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (!requestHasToolResult(request, "tcall_project_memory_after_interactive_terminal_start")) {
        yield projectMemoryReviewCall("tcall_project_memory_after_interactive_terminal_start")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Interactive Terminal started." }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createShutdownCleanupTerminalAgent = (): SocratesAgent => {
  const command = nodeCommand(`
process.stdout.write("shutdown-cleanup-ready\\n")
setInterval(() => {}, 1000)
`)
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      if (!requestHasToolResult(request, "tcall_shutdown_cleanup_start")) {
        yield projectNotesPreflightCall("tcall_project_notes_before_shutdown_cleanup_start")
        yield repoDocsPreflightCall("tcall_repo_docs_before_shutdown_cleanup_start")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_shutdown_cleanup_start",
            toolName: "bash",
            input: { operation: "start", command, name: "shutdown-cleanup-test" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (!requestHasToolResult(request, "tcall_project_memory_after_shutdown_cleanup_start")) {
        yield projectMemoryReviewCall("tcall_project_memory_after_shutdown_cleanup_start")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Shutdown cleanup terminal started." }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createTextInputTerminalAgent = (): SocratesAgent => {
  const command = nodeCommand(`
let stage = 0
let colour = ""
process.stdout.write("What is your favorite colour? ")
process.stdin.on("data", (data) => {
  const answer = data.toString("utf8").trim()
  if (stage === 0) {
    colour = answer
    stage = 1
    process.stdout.write("Name an animal with the colour " + colour + ": ")
    return
  }
  process.stdout.write("Recorded " + answer + " for " + colour + "!\\n")
  process.exit(0)
})
setInterval(() => {}, 1000)
`)
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      if (!requestHasToolResult(request, "tcall_text_input_terminal_start")) {
        yield projectNotesPreflightCall("tcall_project_notes_before_text_input_terminal_start")
        yield repoDocsPreflightCall("tcall_repo_docs_before_text_input_terminal_start")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_text_input_terminal_start",
            toolName: "bash",
            input: { operation: "start", command, name: "text-input-test", inputMode: "user" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (!requestHasToolResult(request, "tcall_project_memory_after_text_input_terminal_start")) {
        yield projectMemoryReviewCall("tcall_project_memory_after_text_input_terminal_start")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Text input Terminal started." }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createPrematureInteractiveStopAgent = (): SocratesAgent => {
  const command = nodeCommand(`
process.stdout.write("What is your name? ")
process.stdin.once("data", (data) => {
  const name = data.toString("utf8").trim()
  process.stdout.write("Hello, " + name + "!\\n")
  process.exit(0)
})
setInterval(() => {}, 1000)
`)
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const latestUser = String(latestUserContent(request.messages) ?? "")
      if (latestUser.includes("Start interactive")) {
        if (!requestHasToolResult(request, "tcall_premature_stop_start")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_premature_stop_start")
          yield repoDocsPreflightCall("tcall_repo_docs_before_premature_stop_start")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_premature_stop_start",
              toolName: "bash",
              input: { operation: "start", command, name: "premature-stop-test", inputMode: "user" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_attempt_stop_awaiting")) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_attempt_stop_awaiting",
              toolName: "bash",
              input: { operation: "stop", target: "premature-stop-test" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Terminal is waiting for user input." }
        yield { type: "model.completed" }
        return
      }
    },
  }
  return new SocratesAgent(provider)
}

const createTerminalOutputAgent = (): SocratesAgent => {
  const command = `node -e "console.log('tail-ready'); setInterval(() => {}, 1000)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const latestUser = String(latestUserContent(request.messages) ?? "")
      if (latestUser.includes("Start tail terminal")) {
        if (!requestHasToolResult(request, "tcall_tail_start")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_tail_start")
          yield repoDocsPreflightCall("tcall_repo_docs_before_tail_start")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_tail_start",
              toolName: "bash",
              input: { operation: "start", command, name: "tail-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_tail_start")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_tail_start")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Tail Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (latestUser.includes("Read tail terminal output")) {
        if (!requestHasToolResult(request, "tcall_tail_output")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_tail_output")
          yield repoDocsPreflightCall("tcall_repo_docs_before_tail_output")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_tail_output",
              toolName: "bash",
              input: { operation: "output", name: "tail-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_tail_output")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_tail_output")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Tail output checked." }
        yield { type: "model.completed" }
        return
      }
    },
  }
  return new SocratesAgent(provider)
}

const createTerminalWaitResumeAgent = (completionDelayMs = 2500, onContinuationContext?: (serializedMessages: string) => void): SocratesAgent => {
  const command = nodeCommand(`
setTimeout(() => {
  process.stdout.write("wait-resume-complete\\n")
  process.exit(0)
}, ${completionDelayMs})
`)
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const serialized = JSON.stringify(request.messages)
      const latestUser = String(latestUserContent(request.messages) ?? "")
      if (serialized.includes("terminal_wake_context")) {
        onContinuationContext?.(serialized)
        yield { type: "model.answer.delta", text: "Background terminal result verified." }
        yield { type: "model.completed" }
        return
      }
      if (!latestUser.includes("Wait for terminal completion")) return
      if (!requestHasToolResult(request, "tcall_wait_start")) {
        yield projectNotesPreflightCall("tcall_project_notes_before_wait_start")
        yield repoDocsPreflightCall("tcall_repo_docs_before_wait_start")
        yield {
          type: "model.tool_call.completed",
          toolCall: { toolCallId: "tcall_wait_start", toolName: "bash", input: { operation: "start", command, name: "wait-resume-tests" } },
        }
        yield { type: "model.completed" }
        return
      }
      if (!requestHasToolResult(request, "tcall_project_memory_after_wait_start")) {
        yield projectMemoryReviewCall("tcall_project_memory_after_wait_start")
        yield { type: "model.completed" }
        return
      }
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: "tcall_wait_until_complete",
          toolName: "wait",
          input: { terminalNames: ["wait-resume-tests"], wakeOn: ["completed", "failed"], reason: "Waiting for terminal test completion" },
        },
      }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createTerminalStopDedupAgent = (): SocratesAgent => {
  const command = `for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "tick-$i"; sleep 0.1; done`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      const latestUser = String(latestUserContent(request.messages) ?? "")
      if (latestUser.includes("Start dedup terminal")) {
        if (!requestHasToolResult(request, "tcall_dedup_start")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_dedup_start")
          yield repoDocsPreflightCall("tcall_repo_docs_before_dedup_start")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_dedup_start",
              toolName: "bash",
              input: { operation: "start", command, name: "dedup-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_dedup_start")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_dedup_start")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Dedup Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (latestUser.includes("Read dedup output")) {
        if (!requestHasToolResult(request, "tcall_dedup_output")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_dedup_output")
          yield repoDocsPreflightCall("tcall_repo_docs_before_dedup_output")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_dedup_output",
              toolName: "bash",
              input: { operation: "output", name: "dedup-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_dedup_output")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_dedup_output")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Dedup output checked." }
        yield { type: "model.completed" }
        return
      }
      if (latestUser.includes("Stop dedup terminal")) {
        if (!requestHasToolResult(request, "tcall_dedup_stop")) {
          yield projectNotesPreflightCall("tcall_project_notes_before_dedup_stop")
          yield repoDocsPreflightCall("tcall_repo_docs_before_dedup_stop")
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_dedup_stop",
              toolName: "bash",
              input: { operation: "stop", name: "dedup-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (!requestHasToolResult(request, "tcall_project_memory_after_dedup_stop")) {
          yield projectMemoryReviewCall("tcall_project_memory_after_dedup_stop")
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Dedup checked." }
        yield { type: "model.completed" }
        return
      }
    },
  }
  return new SocratesAgent(provider)
}

const createFiniteTerminalAgent = (): SocratesAgent => {
  const command = nodeCommand("setTimeout(() => { console.log('finite-done') }, 50)")
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      if (!requestHasToolResult(request, "tcall_finite_start")) {
        yield projectNotesPreflightCall("tcall_project_notes_before_finite_start")
        yield repoDocsPreflightCall("tcall_repo_docs_before_finite_start")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_finite_start",
            toolName: "bash",
            input: { operation: "start", command, name: "finite-server" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (!requestHasToolResult(request, "tcall_project_memory_after_finite_start")) {
        yield projectMemoryReviewCall("tcall_project_memory_after_finite_start")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Finite Terminal completed." }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createQuickRunOutputAgent = (): SocratesAgent => {
  const command = nodeCommand("process.stdout.write('quick-run-evidence\\n')")
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      if (!requestHasToolResult(request, "tcall_quick_run_output")) {
        yield projectNotesPreflightCall("tcall_project_notes_before_quick_run_output")
        yield repoDocsPreflightCall("tcall_repo_docs_before_quick_run_output")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_quick_run_output",
            toolName: "bash",
            input: { operation: "run", command },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (!requestHasToolResult(request, "tcall_project_memory_after_quick_run_output")) {
        yield projectMemoryReviewCall("tcall_project_memory_after_quick_run_output")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Quick run output observed." }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createDuplicateTerminalStartAgent = (): SocratesAgent => {
  const command = `node -e "console.log('reuse-ready'); setInterval(() => {}, 1000)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      if (!requestHasToolResult(request, "tcall_reuse_start_first")) {
        yield projectNotesPreflightCall("tcall_project_notes_before_reuse_start")
        yield repoDocsPreflightCall("tcall_repo_docs_before_reuse_start")
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_reuse_start_first",
            toolName: "bash",
            input: { operation: "start", command, name: "reuse-server" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (!requestHasToolResult(request, "tcall_reuse_start_second")) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_reuse_start_second",
            toolName: "bash",
            input: { operation: "start", command, name: "reuse-server" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (!requestHasToolResult(request, "tcall_project_memory_after_reuse_start")) {
        yield projectMemoryReviewCall("tcall_project_memory_after_reuse_start")
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Reuse checked." }
      yield { type: "model.completed" }
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
  if (lower.includes("blue-lantern-42") || lower.includes("fuzzy blue memory")) {
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
  if (!app.server.listening) {
    await app.listen({ host: "127.0.0.1", port: 0 })
  }
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
  timeoutMs = 3_000,
): Promise<Extract<ServerEvent, { type: T }>> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      clearInterval(interval)
      reject(new Error(`Timed out waiting for ${type}`))
    }, timeoutMs)

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

const waitForToolResult = async (socket: WebSocket): Promise<Extract<ServerEvent, { type: "tool.call.completed" | "tool.call.failed" }>> =>
  Promise.race([waitForEvent(socket, "tool.call.completed"), waitForEvent(socket, "tool.call.failed")])

const waitForToolCompletedByProviderId = async (
  socket: WebSocket,
  providerToolCallId: string,
  timeoutMs = 3_000,
): Promise<Extract<ServerEvent, { type: "tool.call.completed" }>> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const event = await waitForEvent(socket, "tool.call.completed", Math.max(10, Math.min(250, deadline - Date.now())))
      if (event.payload.providerToolCallId === providerToolCallId) {
        return event
      }
    } catch {
      // Keep polling until the full provider-id deadline expires.
    }
  }
  throw new Error(`Timed out waiting for completed tool ${providerToolCallId}`)
}

const waitForToolFailedByProviderId = async (
  socket: WebSocket,
  providerToolCallId: string,
  timeoutMs = 3_000,
): Promise<Extract<ServerEvent, { type: "tool.call.failed" }>> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const event = await waitForEvent(socket, "tool.call.failed", Math.max(10, Math.min(250, deadline - Date.now())))
      if (event.payload.providerToolCallId === providerToolCallId) {
        return event
      }
    } catch {
      // Keep polling until the full provider-id deadline expires.
    }
  }
  throw new Error(`Timed out waiting for failed tool ${providerToolCallId}`)
}

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

const insertTurnCompletedEvent = (
  sqlite: Database.Database,
  input: { projectId: string; conversationId: string; sessionId: string; turnId: string; timestamp?: string },
): number => {
  const sequence = ((sqlite.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM events").get() as { sequence: number }).sequence)
  const timestamp = input.timestamp ?? nowIso()
  sqlite
    .prepare(
      `INSERT INTO events (
        id, project_id, conversation_id, session_id, turn_id, sequence, type, source, payload_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'turn.completed', 'test', ?, ?)`,
    )
    .run(
      createId("evt"),
      input.projectId,
      input.conversationId,
      input.sessionId,
      input.turnId,
      sequence,
      JSON.stringify({ turnId: input.turnId, summary: "Test turn completed." }),
      timestamp,
    )
  return sequence
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

const chatSubscribeCommand = (projectId: string, conversationId: string) => ({
  id: createId("evt"),
  type: "chat.conversation.subscribe",
  schemaVersion: 1,
  timestamp: nowIso(),
  projectId,
  conversationId,
  actor: { type: "user" },
  payload: {
    replayActiveTurn: true,
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
        "ai_usage_events",
        "turn_usage_reports",
        "context_usage_snapshots",
        "context_compaction_snapshots",
        "tool_calls",
        "approvals",
        "shell_commands",
        "shell_output_chunks",
        "terminal_sessions",
        "terminal_output_chunks",
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
        "memory_agent_jobs",
        "project_memory_agent_settings",
        "memory_agent_actions",
        "memory_agent_confirmations",
        "memory_doc_indexes",
        "memory_doc_sections",
        "notifications",
        "session_state",
        "schema_migrations",
      ]),
    )
  })

  it("stores repeated provider tool-call ids under unique Socrates tool run ids", () => {
    const dbPath = tempDbPath()
    const handle = openDatabase(dbPath)
    runMigrations(handle)
    const store = new SocratesStore(handle)
    try {
      for (const toolCallId of ["tcall_internal_1", "tcall_internal_2"]) {
        store.createToolCall({
          toolCallId,
          providerToolCallId: "functions.read:0",
          conversationId: "conv_duplicate_provider",
          sessionId: "sess_duplicate_provider",
          turnId: "turn_duplicate_provider",
          toolName: "read",
          arguments: { path: "README.md" },
          requiresApproval: false,
        })
        store.completeToolCall(toolCallId, { ok: true })
      }

      const rows = handle.sqlite
        .prepare("SELECT id, provider_tool_call_id FROM tool_calls WHERE conversation_id = ? ORDER BY started_at")
        .all("conv_duplicate_provider") as Array<{ id: string; provider_tool_call_id: string }>
      expect(rows.map((row) => row.id)).toEqual(["tcall_internal_1", "tcall_internal_2"])
      expect(rows.map((row) => row.provider_tool_call_id)).toEqual(["functions.read:0", "functions.read:0"])
    } finally {
      handle.close()
    }
  })

  it("materializes AI usage events into completed turn cost reports", () => {
    const dbPath = tempDbPath()
    const handle = openDatabase(dbPath)
    runMigrations(handle)
    const store = new SocratesStore(handle)
    const now = nowIso()
    const userId = createId("user")
    const projectId = createId("proj")
    const conversationId = createId("conv")
    const sessionId = createId("sess")
    const turnId = createId("turn")
    const snapshotId = createId("ctxcmp")

    try {
      handle.sqlite
        .prepare("INSERT INTO users (id, display_name, onboarding_completed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
        .run(userId, "Ayush", now, now)
      handle.sqlite
        .prepare("INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
        .run(projectId, userId, "Usage Test", now, now)
      handle.sqlite
        .prepare("INSERT INTO conversations (id, project_id, user_id, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)")
        .run(conversationId, projectId, userId, "Usage", now, now)
      handle.sqlite
        .prepare("INSERT INTO sessions (id, project_id, conversation_id, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)")
        .run(sessionId, projectId, conversationId, now, now)
      handle.sqlite
        .prepare("INSERT INTO turns (id, session_id, conversation_id, status, started_at, completed_at) VALUES (?, ?, ?, 'completed', ?, ?)")
        .run(turnId, sessionId, conversationId, now, now)

      const modelCallId = store.createModelCall({
        conversationId,
        sessionId,
        turnId,
        runtimeConfigId: "rtc_usage",
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        request: { modelId: "gpt-5.4-mini" },
      })
      store.completeModelCall({
        modelCallId,
        response: { ok: true },
        providerResponse: { id: "gen_1", provider: "OpenAI" },
        usage: {
          inputTokens: 1000,
          outputTokens: 100,
          cachedInputTokens: 400,
          uncachedInputTokens: 600,
          totalTokens: 1100,
          costUsd: 0.00093,
          costSource: "computed",
          pricingSnapshot: { source: "test" },
          providerMetadata: { openai: { requestId: "resp_1" } },
          raw: { provider: "openai" },
        },
      })

      store.startContextCompactionSnapshot({
        snapshotId,
        projectId,
        conversationId,
        sessionId,
        turnId,
        reason: "threshold",
        contextTokensEstimate: 1000,
        targetTokens: 170000,
        compressorProviderId: "openrouter",
        compressorModelId: "deepseek/deepseek-v4-flash",
        sourceMessageIds: [],
        sourceTurnIds: [turnId],
      })
      store.completeContextCompactionSnapshot({
        snapshotId,
        summary: validServerChatCompaction({ done: ["Compacted."] }),
        renderedSummary: "Compacted.",
        sourceHandles: [],
        inputTokensEstimate: 200,
        outputTokensEstimate: 50,
        contextTokensAfter: 450,
        compressorProviderId: "openrouter",
        compressorModelId: "deepseek/deepseek-v4-flash",
        usage: {
          inputTokens: 200,
          outputTokens: 50,
          totalTokens: 250,
          costUsd: 0.0004,
          costSource: "provider_reported",
          raw: { provider: "openrouter" },
        },
      })

      const report = store.buildTurnUsageReport(turnId)
      expect(report?.totalTokens).toBe(1350)
      expect(report?.totalCostUsd).toBeCloseTo(0.00133)
      expect(report?.costSource).toBe("mixed")
      expect(report?.callBreakdown).toHaveLength(1)
      expect(report?.compactionBreakdown).toHaveLength(1)

      const persisted = handle.sqlite
        .prepare(
          `SELECT mc.provider_response_json AS providerResponseJson,
                  mu.metadata_json AS modelUsageMetadataJson,
                  aue.metadata_json AS ledgerMetadataJson
           FROM model_calls mc
           INNER JOIN model_usage mu ON mu.model_call_id = mc.id
           INNER JOIN ai_usage_events aue ON aue.source_id = mc.id
           WHERE mc.id = ?`,
        )
        .get(modelCallId) as { providerResponseJson: string; modelUsageMetadataJson: string; ledgerMetadataJson: string }
      expect(JSON.parse(persisted.providerResponseJson)).toEqual({ id: "gen_1", provider: "OpenAI" })
      expect(JSON.parse(persisted.modelUsageMetadataJson)).toEqual({ providerMetadata: { openai: { requestId: "resp_1" } } })
      expect(JSON.parse(persisted.ledgerMetadataJson)).toEqual({ providerMetadata: { openai: { requestId: "resp_1" } } })

      const conversation = store.getConversation(projectId, conversationId)
      expect(conversation.costUsage.totalCostUsd).toBeCloseTo(0.00133)
      expect(conversation.costUsage.hasComputedCost).toBe(true)
      expect(conversation.turnUsageReports?.[0]?.turnId).toBe(turnId)
    } finally {
      handle.close()
    }
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
        contextTokensEstimate: 161000,
        targetTokens: 170000,
        compressorProviderId: "openrouter",
        compressorModelId: "deepseek/deepseek-v4-flash",
        sourceMessageIds: ["msg_old_1"],
        sourceTurnIds: ["turn_old_1"],
      })
      store.completeContextCompactionSnapshot({
        snapshotId: firstSnapshotId,
        summary: validServerChatCompaction({ decisions: ["alpha decision"], anchors: ["Turn 1: alpha decision source."] }),
        renderedSummary: "alpha decision from first compacted summary",
        sourceHandles: [{ messageId: "msg_old_1" }],
        inputTokensEstimate: 161000,
        outputTokensEstimate: 1200,
        contextTokensAfter: 115000,
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
        contextTokensEstimate: 165000,
        targetTokens: 170000,
        compressorProviderId: "openrouter",
        compressorModelId: "stepfun/step-3.7-flash",
        sourceMessageIds: ["msg_old_2"],
        sourceTurnIds: ["turn_old_2"],
      })
      store.completeContextCompactionSnapshot({
        snapshotId: secondSnapshotId,
        summary: validServerChatCompaction({ decisions: ["beta decision"], anchors: ["Turn 2: beta decision source."] }),
        renderedSummary: "beta decision from second compacted summary",
        sourceHandles: [{ messageId: "msg_old_2" }],
        inputTokensEstimate: 165000,
        outputTokensEstimate: 1300,
        contextTokensAfter: 116000,
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
        scope: "current_conversation",
        include: ["summaries"],
      })
      expect(search.results.some((result) => result.entryType === "continuation_summary" && "text" in result && result.text.includes("beta decision"))).toBe(true)
    } finally {
      await store.close()
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

  it("configures worker model settings through the HTTP API", async () => {
    const app = await buildTestServer()
    await onboard(app)

    const listResponse = await app.inject({ method: "GET", url: "/api/worker-model-settings" })
    const listBody = parseResponse<{ settings: WorkerModelSettings[] }>(listResponse.payload)
    expect(listResponse.statusCode).toBe(200)
    expect(listBody.ok).toBe(true)
    if (!listBody.ok) {
      throw new Error("Expected worker model settings list success")
    }
    expect(listBody.data.settings.map((setting) => setting.workerId)).toEqual([
      "skill_writer",
      "context_compactor",
      "title_generator",
      "memory_router",
      "frontier",
    ])
    expect(listBody.data.settings.find((setting) => setting.workerId === "skill_writer")).toMatchObject({
      providerId: "openrouter",
      modelId: "xiaomi/mimo-v2.5-pro",
      thinkingEnabled: false,
    })
    expect(listBody.data.settings.find((setting) => setting.workerId === "memory_router")).toMatchObject({
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-flash",
      thinkingEnabled: false,
    })
    expect(listBody.data.settings.find((setting) => setting.workerId === "frontier")).toMatchObject({
      providerId: "openrouter",
      modelId: "x-ai/grok-4.5",
      thinkingEnabled: true,
      thinkingEffort: "low",
    })

    await app.inject({
      method: "POST",
      url: "/api/provider-credentials/session",
      payload: { providerId: "google", apiKey: "sk-google-test", source: "manual" },
    })

    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/worker-model-settings/title_generator",
      payload: {
        providerId: "google",
        authMode: "api_key",
        modelId: "gemini-3.5-flash",
        thinkingEnabled: false,
      },
    })
    const updateBody = parseResponse<{ settings: WorkerModelSettings }>(updateResponse.payload)
    expect(updateResponse.statusCode).toBe(200)
    expect(updateBody.ok).toBe(true)
    if (!updateBody.ok) {
      throw new Error("Expected worker model settings update success")
    }
    expect(updateBody.data.settings).toMatchObject({
      workerId: "title_generator",
      providerId: "google",
      authMode: "api_key",
      modelId: "gemini-3.5-flash",
      thinkingEnabled: false,
    })

    const invalidResponse = await app.inject({
      method: "PATCH",
      url: "/api/worker-model-settings/unknown_worker",
      payload: {
        providerId: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        thinkingEnabled: false,
      },
    })
    expect(invalidResponse.statusCode).toBe(400)
  })

  it("prefers ChatGPT Codex defaults for built-in worker settings when connected", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-worker-codex-test-"))
    writeTestChatGptCodexTokens(home)
    const app = await buildServer({ dbPath: path.join(home, "socrates.sqlite"), socratesHome: home, agent: createTestAgent() })
    servers.push(app)
    await onboard(app)

    const listResponse = await app.inject({ method: "GET", url: "/api/worker-model-settings" })
    const listBody = parseResponse<{ settings: WorkerModelSettings[]; resolutions: ModelSettingsResolution[] }>(listResponse.payload)
    expect(listBody.ok).toBe(true)
    if (!listBody.ok) {
      throw new Error("Expected worker model settings list success")
    }

    const resolutionByWorker = new Map(listBody.data.settings.map((setting, index) => [setting.workerId, listBody.data.resolutions[index]] as const))
    expect(resolutionByWorker.get("skill_writer")?.effective).toMatchObject({
      providerId: "openai",
      authMode: "chatgpt_subscription",
      modelId: "gpt-5.4-mini",
      thinkingEnabled: true,
      thinkingEffort: "low",
    })
    expect(resolutionByWorker.get("context_compactor")?.effective).toMatchObject({
      providerId: "openai",
      authMode: "chatgpt_subscription",
      modelId: "gpt-5.4-mini",
      thinkingEnabled: true,
      thinkingEffort: "low",
    })
    expect(resolutionByWorker.get("title_generator")?.effective).toMatchObject({
      providerId: "openai",
      authMode: "chatgpt_subscription",
      modelId: "gpt-5.4-mini",
      thinkingEnabled: true,
      thinkingEffort: "low",
    })
    expect(resolutionByWorker.get("memory_router")?.effective).toMatchObject({
      providerId: "openai",
      authMode: "chatgpt_subscription",
      modelId: "gpt-5.4-mini",
      thinkingEnabled: true,
      thinkingEffort: "low",
    })
    expect(resolutionByWorker.get("frontier")?.effective).toMatchObject({
      providerId: "openai",
      authMode: "chatgpt_subscription",
      modelId: "gpt-5.5",
      thinkingEnabled: true,
      thinkingEffort: "low",
    })
  })

  it("allows browser CORS preflights for project PATCH routes", async () => {
    const app = await buildTestServer()
    const response = await app.inject({
      method: "OPTIONS",
      url: "/api/projects/proj_test/workspace",
      headers: {
        origin: "http://127.0.0.1:49986",
        "access-control-request-method": "PATCH",
      },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH")
  })

  it("manages provider credentials without returning secret values", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-credentials-test-"))
    const app = await buildServer({ dbPath: path.join(home, "socrates.sqlite"), socratesHome: home, agent: createTestAgent() })
    servers.push(app)

    const initialResponse = await app.inject({ method: "GET", url: "/api/provider-credentials/status" })
    const initialBody = parseResponse<GetProviderCredentialsStatusResponse>(initialResponse.payload)
    expect(initialResponse.statusCode).toBe(200)
    expect(JSON.stringify(initialBody)).not.toContain("sk-secret")

    const setResponse = await app.inject({
      method: "POST",
      url: "/api/provider-credentials/session",
      payload: { providerId: "openrouter", apiKey: "sk-secret-test", source: "local_file" },
    })
    expect(setResponse.statusCode).toBe(200)
    expect(setResponse.payload).not.toContain("sk-secret-test")
    expect(fs.readFileSync(path.join(home, ".env"), "utf8")).toContain("OPENROUTER_API_KEY=")

    const checkResponse = await app.inject({
      method: "POST",
      url: "/api/provider-credentials/check",
      payload: { providerId: "openrouter" },
    })
    expect(checkResponse.statusCode).toBe(200)
    expect(checkResponse.payload).not.toContain("sk-secret-test")

    const deleteResponse = await app.inject({ method: "DELETE", url: "/api/provider-credentials/openrouter" })
    expect(deleteResponse.statusCode).toBe(200)
    expect(deleteResponse.payload).not.toContain("sk-secret-test")
    expect(fs.readFileSync(path.join(home, ".env"), "utf8")).not.toContain("OPENROUTER_API_KEY=")
  })

  it("filters HTTP model list by configured provider credentials", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-models-test-"))
    const app = await buildServer({ dbPath: path.join(home, "socrates.sqlite"), socratesHome: home, agent: createTestAgent() })
    servers.push(app)

    const emptyResponse = await app.inject({ method: "GET", url: "/api/models" })
    const emptyBody = parseResponse<ListModelsResponse>(emptyResponse.payload)
    expect(emptyBody.ok && emptyBody.data.models).toEqual([])
    expect(emptyBody.ok && emptyBody.data.defaultModel).toBeNull()

    await app.inject({
      method: "POST",
      url: "/api/provider-credentials/session",
      payload: { providerId: "openrouter", apiKey: "sk-openrouter-test", source: "manual" },
    })

    const openRouterResponse = await app.inject({ method: "GET", url: "/api/models" })
    const openRouterBody = parseResponse<ListModelsResponse>(openRouterResponse.payload)
    expect(openRouterBody.ok && openRouterBody.data.models.every((model) => model.providerId === "openrouter")).toBe(true)
    expect(openRouterBody.ok && openRouterBody.data.defaultModel).toMatchObject({
      providerId: "openrouter",
      authMode: "api_key",
      modelId: "deepseek/deepseek-v4-pro",
    })

    await app.inject({
      method: "POST",
      url: "/api/provider-credentials/session",
      payload: { providerId: "deepseek", apiKey: "sk-deepseek-test", source: "manual" },
    })

    const deepSeekResponse = await app.inject({ method: "GET", url: "/api/models" })
    const deepSeekBody = parseResponse<ListModelsResponse>(deepSeekResponse.payload)
    expect(deepSeekBody.ok && deepSeekBody.data.models.some((model) => model.providerId === "deepseek" && model.modelId === "deepseek-v4-pro")).toBe(true)
    expect(deepSeekBody.ok && deepSeekBody.data.models.some((model) => model.providerId === "deepseek" && model.modelId === "deepseek-v4-flash")).toBe(true)
  })

  it("creates, lists, gets, and patches projects", async () => {
    const app = await buildTestServer()
    await onboard(app)

    const { project, primaryWorkspace } = await createProject(app)
    expect(project.status).toBe("active")
    expect(primaryWorkspace.path).toBeTruthy()
    expect(fs.statSync(path.join(primaryWorkspace.path ?? "", ".socrates", "resources")).isDirectory()).toBe(true)
    expect(fs.statSync(path.join(primaryWorkspace.path ?? "", ".socrates", "repo_docs")).isDirectory()).toBe(true)

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

  it("allows reusing a workspace path after the old project detached it", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const originalWorkspacePath = tempDir()

    const firstCreateResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Original Workspace Owner",
        creationMode: "existing_folder",
        workspacePath: originalWorkspacePath,
      },
    })
    const firstCreateBody = parseResponse<{ project: Project; primaryWorkspace: ProjectWorkspace }>(firstCreateResponse.payload)
    expect(firstCreateBody.ok).toBe(true)
    if (!firstCreateBody.ok) {
      return
    }

    const newWorkspacePath = tempDir()
    const updateResponse = await app.inject({
      method: "PATCH",
      url: `/api/projects/${firstCreateBody.data.project.id}/workspace`,
      payload: {
        workspacePath: newWorkspacePath,
        creationMode: "existing_folder",
      },
    })
    const updateBody = parseResponse<{ primaryWorkspace: ProjectWorkspace }>(updateResponse.payload)
    expect(updateBody.ok).toBe(true)

    const secondCreateResponse = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Reused Detached Workspace",
        creationMode: "existing_folder",
        workspacePath: originalWorkspacePath,
        scaffoldAction: "use_existing",
      },
    })
    const secondCreateBody = parseResponse<{ project: Project; primaryWorkspace: ProjectWorkspace }>(secondCreateResponse.payload)
    expect(secondCreateBody.ok).toBe(true)
    if (secondCreateBody.ok) {
      expect(secondCreateBody.data.primaryWorkspace.path).toBe(originalWorkspacePath)
    }
  })

  it("preserves existing workspace repo docs when attaching an existing .socrates folder", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const workspacePath = tempDir()
    const repoDocsPath = path.join(workspacePath, ".socrates", "repo_docs")
    fs.mkdirSync(repoDocsPath, { recursive: true })
    fs.writeFileSync(path.join(repoDocsPath, "REPO_RULES.md"), "# Existing Rules\n\n- Preserve me.\n")

    const response = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        name: "Existing Repo Docs",
        creationMode: "existing_folder",
        workspacePath,
        scaffoldAction: "use_existing",
      },
    })
    const body = parseResponse<{ project: Project; primaryWorkspace: ProjectWorkspace }>(response.payload)
    expect(body.ok).toBe(true)
    expect(fs.readFileSync(path.join(repoDocsPath, "REPO_RULES.md"), "utf8")).toContain("Preserve me.")
    expect(fs.existsSync(path.join(repoDocsPath, "CORE_IDEA.md"))).toBe(true)
    expect(fs.existsSync(path.join(repoDocsPath, "REPO_NAVIGATION.md"))).toBe(true)
    expect(fs.existsSync(path.join(repoDocsPath, "CONTRACTS.md"))).toBe(true)
    expect(fs.existsSync(path.join(repoDocsPath, "APP_FLOW.md"))).toBe(false)
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

  it("prefers the active primary workspace over stale detached primary duplicates", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const stalePath = tempDir()

    const sqlite = new Database(dbPath)
    try {
      sqlite
        .prepare(
          "INSERT INTO project_workspaces (id, project_id, kind, path, is_primary, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("pws_stale_primary", project.id, "existing_folder", stalePath, 1, "detached", "2099-01-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z")
    } finally {
      sqlite.close()
    }

    const response = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}`,
    })
    const body = parseResponse<{ primaryWorkspace: ProjectWorkspace }>(response.payload)
    expect(body.ok).toBe(true)
    if (!body.ok) {
      throw new Error("Expected project dashboard success")
    }
    expect(body.data.primaryWorkspace.id).toBe(primaryWorkspace.id)
    expect(body.data.primaryWorkspace.path).toBe(primaryWorkspace.path)
  })

  it("blocks workspace updates while a project turn is active", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
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
    const { project, primaryWorkspace } = await createProject(app)

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

  it("syncs files manually added to the workspace resources folder", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const manualPath = path.join(primaryWorkspace.path ?? "", ".socrates", "resources", "Manual Brief.pdf")
    fs.writeFileSync(manualPath, "manual pdf")

    const listResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}/resources` })
    const listBody = parseResponse<{ resources: ProjectResource[] }>(listResponse.payload)
    expect(listBody.ok).toBe(true)
    if (!listBody.ok) {
      throw new Error("Expected resource list success")
    }

    const synced = listBody.data.resources.find((resource) => resource.uri === manualPath)
    expect(synced?.name).toBe("Manual Brief.pdf")
    expect(synced?.kind).toBe("pdf")
    expect(synced?.source).toBe("uploaded")
    expect(synced?.mimeType).toBe("application/pdf")
    expect(synced?.sizeBytes).toBe(Buffer.byteLength("manual pdf"))

    const dashboardResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    const dashboardBody = parseResponse<{ resources: ProjectResource[] }>(dashboardResponse.payload)
    expect(dashboardBody.ok).toBe(true)
    if (dashboardBody.ok) {
      expect(dashboardBody.data.resources.some((resource) => resource.uri === manualPath)).toBe(true)
    }
  })

  it("removes resources from listings when their workspace file is manually removed", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const manualPath = path.join(primaryWorkspace.path ?? "", ".socrates", "resources", "Temporary Notes.md")
    fs.writeFileSync(manualPath, "temporary")

    const firstList = parseResponse<{ resources: ProjectResource[] }>(
      (await app.inject({ method: "GET", url: `/api/projects/${project.id}/resources` })).payload,
    )
    expect(firstList.ok).toBe(true)
    if (!firstList.ok) {
      throw new Error("Expected first resource list success")
    }
    expect(firstList.data.resources.some((resource) => resource.uri === manualPath)).toBe(true)

    fs.rmSync(manualPath)

    const secondList = parseResponse<{ resources: ProjectResource[] }>(
      (await app.inject({ method: "GET", url: `/api/projects/${project.id}/resources` })).payload,
    )
    expect(secondList.ok).toBe(true)
    if (secondList.ok) {
      expect(secondList.data.resources.some((resource) => resource.uri === manualPath)).toBe(false)
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
    const { project, primaryWorkspace } = await createProject(app)
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

  it("builds project skills from the dashboard flow", async () => {
    const app = await buildTestServer(undefined, createTestAgent(), { memoryProvider: createSkillWriterProvider(true) })
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)

    const firstResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/skills/build`,
      payload: { name: "memory-review", request: "Create a memory review skill for this project." },
    })
    const firstBody = parseResponse<{ skill: SkillSummary }>(firstResponse.payload)
    expect(firstBody.ok).toBe(true)
    if (!firstBody.ok) return
    expect(firstBody.data.skill.scope).toBe("project")
    expect(firstBody.data.skill.name).toBe("memory-review")
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "skills", firstBody.data.skill.name, "SKILL.md"))).toBe(true)

    const secondResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/skills/build`,
      payload: { request: "Create a memory review skill for this project." },
    })
    const secondBody = parseResponse<{ skill: SkillSummary }>(secondResponse.payload)
    expect(secondBody.ok).toBe(true)
    if (secondBody.ok) {
      expect(secondBody.data.skill.name).not.toBe(firstBody.data.skill.name)
    }

    const getResponse = await app.inject({ method: "GET", url: `/api/projects/${project.id}` })
    const getBody = parseResponse<{ skills: SkillSummary[] }>(getResponse.payload)
    expect(getBody.ok).toBe(true)
    if (getBody.ok) {
      expect(getBody.data.skills.some((skill) => skill.name === firstBody.data.skill.name)).toBe(true)
    }

    const deleteResponse = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}/skills/${firstBody.data.skill.name}` })
    const deleteBody = parseResponse<{ deletedSkillName: string; scope: string }>(deleteResponse.payload)
    expect(deleteBody.ok).toBe(true)
    if (!deleteBody.ok) return
    expect(deleteBody.data).toEqual({ deletedSkillName: "memory-review", scope: "project" })
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "skills", firstBody.data.skill.name))).toBe(false)
  })

  it("builds and deletes global skills from the Memory Center flow", async () => {
    const app = await buildTestServer(undefined, createTestAgent(), { memoryProvider: createSkillWriterProvider() })
    await onboard(app)

    const buildResponse = await app.inject({
      method: "POST",
      url: "/api/memory-agent/skills/build",
      payload: { name: "global-review", request: "Create a global review skill." },
    })
    const buildBody = parseResponse<{ skill: SkillSummary }>(buildResponse.payload)
    expect(buildBody.ok).toBe(true)
    if (!buildBody.ok) return
    expect(buildBody.data.skill).toMatchObject({ name: "global-review", scope: "global" })

    const deleteResponse = await app.inject({ method: "DELETE", url: "/api/memory-agent/skills/global-review" })
    const deleteBody = parseResponse<{ deletedSkillName: string; scope: string }>(deleteResponse.payload)
    expect(deleteBody.ok).toBe(true)
    if (deleteBody.ok) {
      expect(deleteBody.data).toEqual({ deletedSkillName: "global-review", scope: "global" })
    }
  })

  it("previews, imports, disables, and replaces portable global and project skill ZIPs", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const archive = await zipFiles({
      "portable-review/SKILL.md": "---\nname: portable-review\ndescription: Use when the user asks for a portable review checklist.\nlicense: Apache-2.0\nmetadata:\n  version: '1.0'\n---\n\n# Portable Review\n\n1. Inspect the requested evidence.\n2. Return the phrase portable-review-complete.\n",
      "portable-review/references/checklist.md": "# Checklist\n\n- Verify the current evidence.\n",
    })
    const boundary = "----socrates-skill-import"
    const payload = multipartFiles(boundary, [{ name: "portable-review.zip", mimeType: "application/zip", data: archive }])

    const globalPreviewResponse = await app.inject({
      method: "POST",
      url: "/api/memory-agent/skills/import/preview",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    const globalPreview = parseResponse<{ previewId: string; skill: SkillSummary; conflict: { exists: boolean }; package: { fileCount: number } }>(globalPreviewResponse.payload)
    expect(globalPreview.ok, globalPreviewResponse.payload).toBe(true)
    if (!globalPreview.ok) return
    expect(globalPreview.data).toMatchObject({ skill: { name: "portable-review", scope: "global", source: "imported" }, conflict: { exists: false }, package: { fileCount: 2 } })

    const globalCommitResponse = await app.inject({
      method: "POST",
      url: "/api/memory-agent/skills/import/commit",
      payload: { previewId: globalPreview.data.previewId, conflictStrategy: "reject" },
    })
    const globalCommit = parseResponse<{ skill: SkillSummary; replaced: boolean }>(globalCommitResponse.payload)
    expect(globalCommit.ok, globalCommitResponse.payload).toBe(true)
    if (!globalCommit.ok) return
    expect(globalCommit.data).toMatchObject({ skill: { name: "portable-review", enabled: true, source: "imported" }, replaced: false })

    const disabledResponse = await app.inject({ method: "PATCH", url: "/api/memory-agent/skills/portable-review/state", payload: { enabled: false } })
    const disabled = parseResponse<{ skill: SkillSummary }>(disabledResponse.payload)
    expect(disabled.ok, disabledResponse.payload).toBe(true)
    if (disabled.ok) expect(disabled.data.skill.enabled).toBe(false)

    const projectPreviewResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/skills/import/preview`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    const projectPreview = parseResponse<{ previewId: string; skill: SkillSummary }>(projectPreviewResponse.payload)
    expect(projectPreview.ok, projectPreviewResponse.payload).toBe(true)
    if (!projectPreview.ok) return
    expect(projectPreview.data.skill.scope).toBe("project")
    const projectCommitResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/skills/import/commit`,
      payload: { previewId: projectPreview.data.previewId, conflictStrategy: "reject" },
    })
    const projectCommit = parseResponse<{ skill: SkillSummary; replaced: boolean }>(projectCommitResponse.payload)
    expect(projectCommit.ok, projectCommitResponse.payload).toBe(true)
    if (projectCommit.ok) expect(projectCommit.data.skill).toMatchObject({ name: "portable-review", scope: "project", source: "imported" })
  })

  it("manages global and project MCP servers through the API", async () => {
    const app = await buildTestServer()
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)

    const initialResponse = await app.inject({ method: "GET", url: `/api/mcp?projectId=${encodeURIComponent(project.id)}` })
    const initialBody = parseResponse<{ servers: McpServerStatus[] }>(initialResponse.payload)
    expect(initialBody.ok, initialResponse.payload).toBe(true)
    if (!initialBody.ok) return
    expect(initialBody.data.servers.some((server) => server.id === "playwright" && server.scope === "global")).toBe(true)

    const configParseResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/parse",
      payload: { content: JSON.stringify({ mcpServers: { free_search: { command: "npx", args: ["-y", "free-search"], env: { API_TOKEN: "private" } } } }), format: "auto" },
    })
    const parsedBody = parseResponse<{ format: string; servers: Array<{ id: string; secretEnv?: Record<string, string> }> }>(configParseResponse.payload)
    expect(parsedBody.ok, configParseResponse.payload).toBe(true)
    if (parsedBody.ok) {
      expect(parsedBody.data).toMatchObject({ format: "json", servers: [{ id: "free_search", secretEnv: { API_TOKEN: "private" } }] })
    }

    const upsertResponse = await app.inject({
      method: "POST",
      url: "/api/mcp/servers",
      payload: {
        scope: "project",
        projectId: project.id,
        server: {
          id: "projectfake",
          label: "Project Fake MCP",
          command: process.execPath,
          args: ["-e", "process.exit(0)"],
        },
      },
    })
    const upsertBody = parseResponse<{ server: McpServerStatus }>(upsertResponse.payload)
    expect(upsertBody.ok).toBe(true)
    if (!upsertBody.ok) return
    expect(upsertBody.data.server).toMatchObject({ id: "projectfake", scope: "project", enabled: false })
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "mcp.json"))).toBe(true)

    const disableResponse = await app.inject({
      method: "PATCH",
      url: "/api/mcp/servers/projectfake",
      payload: { scope: "project", projectId: project.id, enabled: false },
    })
    const disableBody = parseResponse<{ server: McpServerStatus }>(disableResponse.payload)
    expect(disableBody.ok).toBe(true)
    if (disableBody.ok) {
      expect(disableBody.data.server.enabled).toBe(false)
    }

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/api/mcp/servers/projectfake",
      payload: { scope: "project", projectId: project.id },
    })
    const deleteBody = parseResponse<{ deletedServerId: string; scope: string }>(deleteResponse.payload)
    expect(deleteBody.ok).toBe(true)
    if (deleteBody.ok) {
      expect(deleteBody.data.deletedServerId).toBe("projectfake")
      expect(deleteBody.data.scope).toBe("project")
    }

    const finalResponse = await app.inject({ method: "GET", url: `/api/mcp?projectId=${encodeURIComponent(project.id)}` })
    const finalBody = parseResponse<{ servers: McpServerStatus[] }>(finalResponse.payload)
    expect(finalBody.ok).toBe(true)
    if (finalBody.ok) {
      expect(finalBody.data.servers.some((server) => server.id === "projectfake")).toBe(false)
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
    expect(messageBody.data.conversation.title).toBe("Extraordinary p...")
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
      expect(secondMessageBody.data.conversation.title).toBe("Extraordinary p...")
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

        const search = await store.retrieveToolTraces(project.id, conversation.id, { query: "Hello Socrates", scope: "current_conversation" })
        expect(search.appliedFilters.scope).toBe("current_conversation")
        expect(search.appliedFilters.mode).toBe("exact")
        expect(search.appliedFilters.conversationLimit).toBe(10)
        expect(search.appliedFilters.defaultDateWindowApplied).toBeUndefined()
        expect(search.warnings?.join(" ") ?? "").toContain("Only viewing the current chat")
        expect(search.results.some((result) => result.entryType === "user_query" && result.messageId)).toBe(true)
        expect(search.results[0]?.conversationTitle).toBe(conversation.title)
        expect(search.results[0]?.conversationId).toBe(conversation.id)

        const messageResult = search.results.find((result) => result.entryType === "user_query" && result.messageId)
        expect(messageResult).toBeDefined()
        if (messageResult) {
          const inspected = await store.retrieveToolTraces(project.id, conversation.id, { operation: "inspect", resultNumber: messageResult.resultNumber })
          expect(inspected.results[0]?.entryType).toBe("user_query")
          expect(inspected.results[0]?.conversationTitle).toBe(conversation.title)
          expect(JSON.stringify(inspected.results[0])).toContain("Hello Socrates")
        }

        const semantic = await store.retrieveToolTraces(project.id, conversation.id, { query: "Hello", mode: "semantic", scope: "current_conversation" })
        expect(semantic.warnings?.join(" ")).toContain("Legacy trace-document semantic search is retired")
      } finally {
        await store.close()
      }
    } finally {
      socket.close()
    }
  })

  it("persists a one-way Frontier handover with separate model calls and only Frontier's answer", async () => {
    const dbPath = tempDbPath()
    const socratesHome = path.dirname(dbPath)
    fs.writeFileSync(path.join(socratesHome, ".env"), 'OPENAI_API_KEY="sk-test-openai"\nOPENROUTER_API_KEY="sk-or-test"\n', { mode: 0o600 })
    const requests: Array<{ messages: unknown[]; tools?: Array<{ name: string }> }> = []
    let handedOver = false
    const provider: ModelProvider = {
      countTokens: async (request) => ({
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens: 10,
        baseTokens: 10,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }),
      async generateStructured() {
        return { output: {} as never }
      },
      async *stream(request) {
        requests.push(request)
        const toolNames = request.tools?.map((tool) => tool.name) ?? []
        if (!toolNames.includes("handover_to_frontier") && (toolNames.includes("memory_search") || toolNames.includes("turn_evidence"))) {
          const isPostEvidence = JSON.stringify(request.messages).includes("post-evidence")
          yield {
            type: "model.answer.delta",
            text: JSON.stringify(
              isPostEvidence
                ? { actions: [], reason: "No durable update is needed." }
                : { readTargets: [], reason: "No routed recall is needed." },
            ),
          }
          yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } }
          return
        }
        if (!handedOver && toolNames.includes("handover_to_frontier")) {
          handedOver = true
          yield { type: "model.answer.delta", text: "Discard this driver draft." }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "provider_frontier_handover",
              toolName: "handover_to_frontier",
              input: { focus: "Resolve the final concurrency invariant" },
            },
          }
          yield { type: "model.completed", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }
          return
        }
        yield { type: "model.answer.delta", text: "Frontier-only persisted answer." }
        yield { type: "model.completed", usage: { inputTokens: 18, outputTokens: 5, totalTokens: 23 } }
      },
    }
    const app = await buildTestServer(dbPath, new SocratesAgent(provider), { socratesHome })
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      const command = chatMessageCommand(project.id, conversation.id, "Solve the difficult concurrency problem without restarting your work.")
      sendCommand(socket, {
        ...command,
        payload: {
          ...command.payload,
          runtimeConfig: {
            providerId: "openrouter",
            authMode: "api_key",
            modelId: "deepseek/deepseek-v4-flash",
            thinkingEnabled: false,
            thinkingEffort: "none",
            approvalMode: "manual",
            sandboxMode: "workspace_write",
          },
        },
      })

      const approval = await waitForEvent(socket, "approval.requested")
      expect(approval.payload).toMatchObject({
        actionKind: "other",
        title: "Call Frontier model",
        description: expect.stringContaining("x-ai/grok-4.5 through openrouter"),
        actionPreview: "Focus: Resolve the final concurrency invariant",
        risk: "medium",
      })
      sendCommand(socket, {
        id: createId("evt"),
        type: "approval.decide",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { approvalId: approval.payload.approvalId, decision: "approved" },
      })
      await waitForEvent(socket, "approval.resolved")
      const handover = await waitForEvent(socket, "agent.model.handover")
      expect(handover.payload).toMatchObject({
        fromProviderId: "openrouter",
        fromModelId: "deepseek/deepseek-v4-flash",
        toProviderId: "openrouter",
        toModelId: "x-ai/grok-4.5",
        focus: "Resolve the final concurrency invariant",
      })
      const messageCompleted = await waitForEvent(socket, "message.completed")
      expect(messageCompleted.payload.message.content).toBe("Frontier-only persisted answer.")
      await waitForEvent(socket, "turn.completed")

      const driverRequest = requests.find((request) => request.tools?.some((tool) => tool.name === "handover_to_frontier"))
      const frontierRequests = requests.filter((request) => (request as { modelId?: string }).modelId === "x-ai/grok-4.5")
      expect(driverRequest?.tools?.map((tool) => tool.name)).toContain("handover_to_frontier")
      expect(frontierRequests).toHaveLength(2)
      expect(frontierRequests.every((request) => !request.tools?.some((tool) => tool.name === "handover_to_frontier"))).toBe(true)
      expect(JSON.stringify(frontierRequests[0]?.messages)).toContain("Solve the difficult concurrency problem")
      expect(JSON.stringify(frontierRequests[0]?.messages)).toContain("Resolve the final concurrency invariant")

      const sqlite = new Database(dbPath)
      try {
        const calls = sqlite
          .prepare("SELECT provider_id AS providerId, model_id AS modelId, status FROM model_calls ORDER BY started_at")
          .all() as Array<{ providerId: string; modelId: string; status: string }>
        expect(calls).toEqual([
          { providerId: "openrouter", modelId: "deepseek/deepseek-v4-flash", status: "completed" },
          { providerId: "openrouter", modelId: "x-ai/grok-4.5", status: "completed" },
          { providerId: "openrouter", modelId: "x-ai/grok-4.5", status: "completed" },
        ])
        const handoverEvents = sqlite.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'agent.model.handover'").get() as { count: number }
        expect(handoverEvents.count).toBe(1)
      } finally {
        sqlite.close()
      }
    } finally {
      socket.close()
    }
  })

  it("persists a rejected Frontier approval and lets Socrates finish without offering the tool again", async () => {
    const dbPath = tempDbPath()
    const socratesHome = path.dirname(dbPath)
    fs.writeFileSync(path.join(socratesHome, ".env"), 'OPENAI_API_KEY="sk-test-openai"\nOPENROUTER_API_KEY="sk-or-test"\n', { mode: 0o600 })
    const requests: Array<{ modelId?: string; messages: unknown[]; tools?: Array<{ name: string }> }> = []
    let requestedHandover = false
    const provider: ModelProvider = {
      countTokens: async (request) => ({
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens: 10,
        baseTokens: 10,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }),
      async generateStructured() {
        return { output: {} as never }
      },
      async *stream(request) {
        requests.push(request)
        const toolNames = request.tools?.map((tool) => tool.name) ?? []
        if (!requestedHandover && toolNames.includes("handover_to_frontier")) {
          requestedHandover = true
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "provider_frontier_rejected",
              toolName: "handover_to_frontier",
              input: { focus: "Resolve the final lifecycle conflict" },
            },
          }
          yield { type: "model.completed", usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 } }
          return
        }
        yield { type: "model.answer.delta", text: "Socrates finished after the declined Frontier request." }
        yield { type: "model.completed", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } }
      },
    }
    const app = await buildTestServer(dbPath, new SocratesAgent(provider), { socratesHome })
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Resolve the lifecycle conflict and report the result."))

      const approval = await waitForEvent(socket, "approval.requested")
      expect(approval.payload.title).toBe("Call Frontier model")
      expect(approval.payload.actionPreview).toBe("Focus: Resolve the final lifecycle conflict")
      sendCommand(socket, {
        id: createId("evt"),
        type: "approval.decide",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { approvalId: approval.payload.approvalId, decision: "rejected" },
      })
      const resolved = await waitForEvent(socket, "approval.resolved")
      expect(resolved.payload.decision).toBe("rejected")
      const messageCompleted = await waitForEvent(socket, "message.completed")
      expect(messageCompleted.payload.message.content).toBe("Socrates finished after the declined Frontier request.")
      await waitForEvent(socket, "turn.completed")

      const handoverRequestIndex = requests.findIndex((request) =>
        request.tools?.some((tool) => tool.name === "handover_to_frontier"),
      )
      const continuedRequests = requests.slice(handoverRequestIndex + 1)
      expect(continuedRequests.length).toBeGreaterThan(0)
      expect(continuedRequests.some((request) => JSON.stringify(request.messages).includes("The user declined the Frontier handover"))).toBe(true)
      expect(continuedRequests.every((request) => !request.tools?.some((tool) => tool.name === "handover_to_frontier"))).toBe(true)

      const sqlite = new Database(dbPath)
      try {
        const handoverEvents = sqlite.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'agent.model.handover'").get() as { count: number }
        expect(handoverEvents.count).toBe(0)
        const rejectedTool = sqlite
          .prepare("SELECT status FROM tool_calls WHERE provider_tool_call_id = ?")
          .get("provider_frontier_rejected") as { status: string } | undefined
        expect(rejectedTool?.status).toBe("rejected")
      } finally {
        sqlite.close()
      }
    } finally {
      socket.close()
    }
  })

  it("continues the user task while persisting failed Memory Router errors and usage", async () => {
    const dbPath = tempDbPath()
    let mainCalls = 0
    const provider: ModelProvider = {
      countTokens: async (request) => ({
        providerId: request.providerId,
        modelId: request.modelId,
        inputTokens: 10,
        baseTokens: 10,
        method: "local_tiktoken",
        safetyMarginPercent: 0,
      }),
      async *stream(request) {
        if (request.system.includes("Memory Router Agent")) {
          yield { type: "model.usage", usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 } }
          yield { type: "model.completed" }
          return
        }
        mainCalls += 1
        yield { type: "model.answer.delta", text: mainCalls === 1 ? "Suppressed draft." : "The ordinary task still completed." }
        yield { type: "model.completed", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }
      },
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return {
          output: { readTargets: [], reason: "" } as TOutput,
          usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 },
        }
      },
    }
    const app = await buildTestServer(dbPath, new SocratesAgent(provider))
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Complete this ordinary task even if memory routing fails."))
      const completed = await waitForEvent(socket, "message.completed")
      expect(completed.payload.message.content).toBe("The ordinary task still completed.")
      await waitForEvent(socket, "turn.completed")

      const sqlite = new Database(dbPath)
      try {
        const errors = sqlite
          .prepare("SELECT code, recoverable, details_json AS detailsJson FROM errors WHERE source = 'memory_router' ORDER BY created_at")
          .all() as Array<{ code: string; recoverable: number; detailsJson: string }>
        expect(errors).toHaveLength(2)
        expect(errors.map((error) => error.code)).toEqual(["structured_agent_output_invalid", "structured_agent_output_invalid"])
        expect(errors.map((error) => JSON.parse(error.detailsJson).phase)).toEqual(["pre_turn", "post_evidence"])

        const usageRows = sqlite
          .prepare("SELECT status, metadata_json AS metadataJson FROM ai_usage_events WHERE source_kind = 'memory_router' ORDER BY created_at")
          .all() as Array<{ status: string; metadataJson: string }>
        expect(usageRows).toHaveLength(6)
        expect(usageRows.every((row) => row.status === "failed")).toBe(true)
        expect(usageRows.map((row) => JSON.parse(row.metadataJson).phase)).toEqual([
          "pre_turn",
          "pre_turn",
          "pre_turn",
          "post_evidence",
          "post_evidence",
          "post_evidence",
        ])
        expect(usageRows.every((row) => Boolean(JSON.parse(row.metadataJson).errorId))).toBe(true)
      } finally {
        sqlite.close()
      }
    } finally {
      socket.close()
    }
  })

  it("uses a first-message placeholder title and replaces it with a generated title", async () => {
    const requestedTitleModels: string[] = []
    const app = await buildTestServer(tempDbPath(), createTestAgent(), {
      titleProvider: createTitleProvider("Screenshot Debugging Plan", requestedTitleModels),
    })
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "New conversation")
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Extraordinary planning starts now"))

      const placeholderUpdate = await waitForEvent(socket, "conversation.updated")
      expect(placeholderUpdate.payload.conversation.title).toBe("Extraordinary p...")

      const generatedUpdate = await waitForEvent(socket, "conversation.updated")
      expect(generatedUpdate.payload.conversation.title).toBe("Screenshot Debugging Plan")
      expect(requestedTitleModels).toEqual(["gpt-5.4-mini"])

      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ conversation: Conversation }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.conversation.title).toBe("Screenshot Debugging Plan")
      }
    } finally {
      socket.close()
    }
  })

  it("generates titles with the resolved available title model", async () => {
    const requestedTitleModels: string[] = []
    const app = await buildTestServer(tempDbPath(), createTestAgent(), {
      titleProvider: createFallbackTitleProvider("Fallback Screenshot Title", requestedTitleModels),
    })
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "New conversation")
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Please title this screenshot chat"))

      await waitForEvent(socket, "conversation.updated")
      const generatedUpdate = await waitForEvent(socket, "conversation.updated")
      expect(generatedUpdate.payload.conversation.title).toBe("Fallback Screenshot Title")
      expect(requestedTitleModels).toEqual(["gpt-5.4-mini"])
    } finally {
      socket.close()
    }
  })

  it("uploads chat image attachments, sends image-only messages, and hydrates attachments", async () => {
    const requests: unknown[] = []
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath, createCapturingAgent(requests))
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const boundary = "----socrates-attachment-boundary"
    const imageBytes = Buffer.from("fake png bytes")
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="screenshot.png"',
        "Content-Type: image/png",
        "",
        imageBytes.toString("binary"),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "binary",
    )

    const uploadResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations/${conversation.id}/attachments/upload`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    const uploadBody = parseResponse<{ attachments: MessageAttachment[] }>(uploadResponse.payload)
    expect(uploadBody.ok).toBe(true)
    if (!uploadBody.ok) {
      throw new Error("Expected attachment upload success")
    }
    const attachment = uploadBody.data.attachments[0]
    if (!attachment) {
      throw new Error("Expected uploaded attachment")
    }
    expect(attachment.kind).toBe("image")
    expect(attachment.url).toContain(`/attachments/${attachment.id}/content`)
    expect(attachment.uri).toContain(path.join(".socrates", "attachments"))

    const contentResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/conversations/${conversation.id}/attachments/${attachment?.id}/content`,
    })
    expect(contentResponse.statusCode).toBe(200)
    expect(contentResponse.headers["content-type"]).toContain("image/png")

    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      const command = chatMessageCommandWithRuntime(project.id, conversation.id, "", {
        providerId: "openrouter",
        modelId: "x-ai/grok-build-0.1",
        thinkingEnabled: false,
        thinkingEffort: "none",
      })
      sendCommand(socket, {
        ...command,
        payload: {
          ...command.payload,
          clientMessageId: createId("msg"),
          content: "",
          attachmentIds: [attachment.id],
        },
      })

      const started = await waitForEvent(socket, "turn.started")
      expect(started.payload.userMessage.content).toBe("")
      expect(started.payload.userMessage.attachments?.[0]?.id).toBe(attachment?.id)
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")
    } finally {
      socket.close()
    }

    const hydratedResponse = await app.inject({
      method: "GET",
      url: `/api/projects/${project.id}/conversations/${conversation.id}`,
    })
    const hydratedBody = parseResponse<{ messages: Message[] }>(hydratedResponse.payload)
    expect(hydratedBody.ok).toBe(true)
    if (hydratedBody.ok) {
      const userMessage = hydratedBody.data.messages.find((message) => message.role === "user")
      expect(userMessage?.attachments?.[0]?.id).toBe(attachment?.id)
    }
    expect(JSON.stringify(requests[0])).toContain("\"type\":\"image\"")
    expect(JSON.stringify(requests[0])).toContain(".socrates/attachments/")

    const sqlite = new Database(dbPath)
    try {
      const traceRow = sqlite
        .prepare("SELECT content FROM trace_documents WHERE source_kind = 'message' AND content LIKE ? LIMIT 1")
        .get("%.socrates/attachments/%") as { content: string } | undefined
      expect(traceRow?.content).toContain("screenshot.png")
      expect(traceRow?.content).toContain(".socrates/attachments/")
    } finally {
      sqlite.close()
    }
  })

  it("enforces attachment count, per-image bytes, and combined submission bytes at the backend", async () => {
    const app = await buildTestServer(tempDbPath())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const url = `/api/projects/${project.id}/conversations/${conversation.id}/attachments/upload`

    const tooManyBoundary = "----socrates-too-many-attachments"
    const tooManyResponse = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": `multipart/form-data; boundary=${tooManyBoundary}` },
      payload: multipartFiles(tooManyBoundary, Array.from({ length: MAX_MESSAGE_ATTACHMENTS + 1 }, (_, index) => ({
        name: `image-${index}.png`, mimeType: "image/png", data: Buffer.from([index]),
      }))),
    })
    expect(parseResponse(tooManyResponse.payload)).toMatchObject({ ok: false, error: { code: "attachment_upload_limit_exceeded" } })

    const oversizedBoundary = "----socrates-oversized-image"
    const oversizedResponse = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": `multipart/form-data; boundary=${oversizedBoundary}` },
      payload: multipartFiles(oversizedBoundary, [{
        name: "oversized.png", mimeType: "image/png", data: Buffer.alloc(MAX_IMAGE_ATTACHMENT_BYTES + 1),
      }]),
    })
    expect(parseResponse(oversizedResponse.payload)).toMatchObject({ ok: false, error: { code: "attachment_too_large" } })

    const combinedBoundary = "----socrates-combined-attachments"
    const combinedChunkBytes = Math.floor(MAX_MESSAGE_ATTACHMENT_BYTES / 5) + 1
    const combinedResponse = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": `multipart/form-data; boundary=${combinedBoundary}` },
      payload: multipartFiles(combinedBoundary, Array.from({ length: 5 }, (_, index) => ({
        name: `combined-${index}.png`, mimeType: "image/png", data: Buffer.alloc(combinedChunkBytes),
      }))),
    })
    expect(parseResponse(combinedResponse.payload)).toMatchObject({ ok: false, error: { code: "attachment_total_too_large" } })
  })

  it("accepts a bounded Agent Skill ZIP as a chat attachment", async () => {
    const app = await buildTestServer(tempDbPath())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const archive = await zipFiles({
      "attached-review/SKILL.md": "---\nname: attached-review\ndescription: Use when reviewing an attached Agent Skill package.\n---\n\n# Attached Review\n\n1. Review the attached package safely.\n",
    })
    const boundary = "----socrates-skill-zip-attachment"
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations/${conversation.id}/attachments/upload`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipartFiles(boundary, [{ name: "attached-review.zip", mimeType: "application/zip", data: archive }]),
    })
    const body = parseResponse<{ attachments: MessageAttachment[] }>(response.payload)
    expect(body.ok).toBe(true)
    if (!body.ok) throw new Error("Expected skill ZIP attachment upload success")
    expect(body.data.attachments[0]).toMatchObject({ kind: "skill_zip", mimeType: "application/zip" })
    expect(body.data.attachments[0]?.uri).toContain(path.join(".socrates", "attachments"))
  })

  it("omits chat image bytes for non-vision models", async () => {
    const requests: unknown[] = []
    const app = await buildTestServer(tempDbPath(), createCapturingAgent(requests))
    await onboard(app)
    await app.inject({
      method: "POST",
      url: "/api/provider-credentials/session",
      payload: { providerId: "openrouter", apiKey: "sk-openrouter-test", source: "manual" },
    })
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const boundary = "----socrates-nonvision-attachment-boundary"
    const imageBytes = Buffer.from("fake png bytes")
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="screenshot.png"',
        "Content-Type: image/png",
        "",
        imageBytes.toString("binary"),
        `--${boundary}--`,
        "",
      ].join("\r\n"),
      "binary",
    )

    const uploadResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations/${conversation.id}/attachments/upload`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    const uploadBody = parseResponse<{ attachments: MessageAttachment[] }>(uploadResponse.payload)
    expect(uploadBody.ok).toBe(true)
    if (!uploadBody.ok || !uploadBody.data.attachments[0]) {
      throw new Error("Expected attachment upload success")
    }

    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      const command = chatMessageCommandWithRuntime(project.id, conversation.id, "what do you see?", {
        providerId: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        thinkingEnabled: false,
        thinkingEffort: "none",
      })
      sendCommand(socket, {
        ...command,
        payload: {
          ...command.payload,
          attachmentIds: [uploadBody.data.attachments[0].id],
        },
      })

      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")
    } finally {
      socket.close()
    }

    const serialized = JSON.stringify(requests[0])
    expect(serialized).not.toContain("\"type\":\"image\"")
    expect(serialized).toContain("image attachment retained in chat but pixels were not sent because the selected model does not support vision")
  })

  it("stores large pasted text as a source attachment and sends only a compact manifest", async () => {
    const requests: unknown[] = []
    const app = await buildTestServer(tempDbPath(), createCapturingAgent(requests))
    await onboard(app)
    await app.inject({
      method: "POST",
      url: "/api/provider-credentials/session",
      payload: { providerId: "openrouter", apiKey: "sk-openrouter-test", source: "manual" },
    })
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const boundary = "----socrates-text-attachment-boundary"
    const sourceText = `PASTE_CANARY_START\n${"large pasted source ".repeat(700)}\nPASTE_CANARY_END`
    const payload = Buffer.from(
      [
        `--${boundary}`,
        'Content-Disposition: form-data; name="files"; filename="pasted-text-eval.txt"',
        "Content-Type: text/plain",
        "",
        sourceText,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    )
    const uploadResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/conversations/${conversation.id}/attachments/upload`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    })
    const uploadBody = parseResponse<{ attachments: MessageAttachment[] }>(uploadResponse.payload)
    expect(uploadBody.ok).toBe(true)
    if (!uploadBody.ok || !uploadBody.data.attachments[0]) throw new Error("Expected text attachment upload success")
    const attachment = uploadBody.data.attachments[0]
    expect(attachment.kind).toBe("text")
    expect(attachment.uri).toContain(path.join(".socrates", "attachments"))

    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      const command = chatMessageCommandWithRuntime(project.id, conversation.id, "Use the attached source to answer.", {
        providerId: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        thinkingEnabled: false,
        thinkingEffort: "none",
      })
      sendCommand(socket, { ...command, payload: { ...command.payload, attachmentIds: [attachment.id] } })
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")
    } finally {
      socket.close()
    }

    const serialized = JSON.stringify(requests[0])
    expect(serialized).toContain("pasted-text-eval.txt")
    expect(serialized).toContain("Before answering from an attached text file")
    expect(serialized).not.toContain("PASTE_CANARY_START")
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
        lastRuntimeConfig?: {
          providerId: string
          authMode?: string
          modelId: string
          thinkingEnabled: boolean
          thinkingEffort?: string
          approvalMode: string
          sandboxMode: string
        }
      }>(response.payload)

      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.tokenUsage.totalTokens).toBe(6)
        expect(body.data.contextUsage?.contextUsedTokens).toBe(12_345)
        expect(body.data.contextUsage?.contextUsedTokens).not.toBe(body.data.tokenUsage.totalTokens)
        expect(body.data.lastRuntimeConfig).toEqual({
          providerId: "openai",
          authMode: "api_key",
          modelId: "gpt-5.4-mini",
          thinkingEnabled: false,
          thinkingEffort: "none",
          approvalMode: "manual",
          sandboxMode: "workspace_write",
        })
      }
    } finally {
      socket.close()
    }
  })

  it("creates and updates global memory agent settings", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)

    const getResponse = await app.inject({
      method: "GET",
      url: "/api/memory-agent",
    })
    const current = parseResponse<{ settings: { providerId: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: string; enabled: boolean; cadenceMinutes: number } }>(
      getResponse.payload,
    )
    expect(current.ok).toBe(true)
    if (!current.ok) {
      throw new Error("Expected memory agent success")
    }
    expect(current.data.settings).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      thinkingEnabled: false,
      enabled: true,
      cadenceMinutes: 10,
    })
    expect(current.data.settings.thinkingEffort).toBeUndefined()

    const updateResponse = await app.inject({
      method: "PATCH",
      url: "/api/memory-agent/settings",
      payload: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: true,
        thinkingEffort: "low",
        cadenceMinutes: 30,
        enabled: false,
      },
    })
    const updated = parseResponse<{ settings: { providerId: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: string; enabled: boolean; cadenceMinutes: number } }>(
      updateResponse.payload,
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok) {
      throw new Error("Expected settings update success")
    }
    expect(updated.data.settings).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      thinkingEnabled: true,
      thinkingEffort: "low",
      cadenceMinutes: 30,
      enabled: false,
    })

    const openAiUpdateResponse = await app.inject({
      method: "PATCH",
      url: "/api/memory-agent/settings",
      payload: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: true,
        enabled: true,
      },
    })
    const openAiUpdated = parseResponse<{ settings: { providerId: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: string; enabled: boolean } }>(
      openAiUpdateResponse.payload,
    )
    expect(openAiUpdated.ok).toBe(true)
    if (!openAiUpdated.ok) {
      throw new Error("Expected OpenAI settings update success")
    }
    expect(openAiUpdated.data.settings).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      thinkingEnabled: true,
    })
    expect(openAiUpdated.data.settings.thinkingEffort).toBeUndefined()
  })

  it("prefers ChatGPT Codex for the built-in global memory agent default when connected", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-memory-agent-codex-test-"))
    writeTestChatGptCodexTokens(home)
    const app = await buildServer({ dbPath: path.join(home, "socrates.sqlite"), socratesHome: home, agent: createTestAgent() })
    servers.push(app)
    await onboard(app)

    const response = await app.inject({
      method: "GET",
      url: "/api/memory-agent",
    })
    const body = parseResponse<{ settings: { providerId: string; authMode?: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: string } }>(
      response.payload,
    )
    expect(body.ok).toBe(true)
    if (!body.ok) {
      throw new Error("Expected memory agent success")
    }
    expect(body.data.settings).toMatchObject({
      providerId: "openai",
      authMode: "chatgpt_subscription",
      modelId: "gpt-5.5",
      thinkingEnabled: true,
      thinkingEffort: "low",
    })
  })

  it("exposes user profile in the memory-agent file index", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath, createTestAgent(), { socratesHome })
    await onboard(app)

    const filesResponse = await app.inject({
      method: "GET",
      url: "/api/memory-agent/files",
    })
    const files = parseResponse<{ files: Array<{ id: string; kind: string; name: string; path: string; absolutePath: string }> }>(
      filesResponse.payload,
    )

    expect(files.ok).toBe(true)
    if (!files.ok) {
      throw new Error("Expected memory-agent files success")
    }
    expect(files.data.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "user_profile:user_profile.md",
          kind: "user_profile",
          name: "User Profile",
          path: "user_profile.md",
          absolutePath: path.join(socratesHome, "user_profile.md"),
        }),
      ]),
    )
  })

  it("exposes detached terminal sessions through trace_retrieve shell audit", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Terminal Trace Source")
    const live = await createConversation(app, project.id, "Terminal Trace Live")
    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle)
    const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
    const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, "Start detached terminal", "Terminal started.", nowIso())
    const terminalId = createId("term")
    const now = nowIso()
    try {
      handle.sqlite
        .prepare(
          `INSERT INTO terminal_sessions (
            id, project_id, conversation_id, workspace_path, name, command, cwd, status,
            auto_detached, awaiting_input, started_at, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, 'trace-terminal', 'node script.js', ?, 'detached', 1, 0, ?, ?, ?)`,
        )
        .run(
          terminalId,
          project.id,
          conversation.id,
          primaryWorkspace.path,
          primaryWorkspace.path,
          now,
          now,
          JSON.stringify({ lastTurnId: turn.turnId }),
        )
      handle.sqlite
        .prepare(
          `INSERT INTO terminal_output_chunks (
            id, terminal_session_id, sequence, stream, text, redacted, created_at
          ) VALUES (?, ?, 0, 'pty', 'DETACHED-TERMINAL-TOKEN output line\\n', 0, ?)`,
        )
        .run(createId("tout"), terminalId, now)

      store.indexTurnTraceDocuments(project.id, conversation.id, turn.turnId)

      const result = await store.retrieveToolTraces(project.id, live.id, {
        query: "DETACHED-TERMINAL-TOKEN",
        scope: "project",
        mode: "audit",
        include: ["shell"],
      })

      expect(result.results[0]?.entryType).toBe("shell")
      expect(JSON.stringify(result.results)).toContain("trace-terminal")
      expect(JSON.stringify(result.results)).toContain("DETACHED-TERMINAL-TOKEN")
    } finally {
      await store.close()
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
          query: "Canonical rubric",
          mode: "exact",
          scope: "current_conversation",
          include: ["messages"],
        })
        expect(search.results.some((result) => result.entryType === "user_query" && "text" in result && result.text.includes("Canonical rubric"))).toBe(true)
      } finally {
        await store.close()
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
        scope: "project",
        turnNo: 2,
        role: "user",
      })
      expect(ordinal.results[0]?.entryType).toBe("user_query")
      expect(ordinal.results[0]?.messageId).toBe(second.userMessageId)
      expect(ordinal.results[0]?.conversationTitle).toBe("Ordinal Source")
      expect(ordinal.results[0]?.conversationId).toBe(source.id)
      expect(ordinal.results[0]?.messageNo).toBe(2)

      const inspected = await store.retrieveToolTraces(project.id, live.id, { operation: "inspect", messageId: second.userMessageId })
      expect(inspected.results[0]?.conversationTitle).toBe("Ordinal Source")
      expect(inspected.results[0]?.entryType).toBe("user_query")
      expect(JSON.stringify(inspected.results)).toContain("BLUE-LANTERN-42")

      const lexicalOnly = await store.retrieveToolTraces(project.id, live.id, {
        query: "what did I say in the second user message",
        scope: "project",
      })
      expect(JSON.stringify(lexicalOnly.results)).not.toContain("BLUE-LANTERN-42")

      const mixedSelector = await store.retrieveToolTraces(project.id, live.id, {
        query: "what did I say in the second user message",
        scope: "project",
        turnNo: 2,
        role: "user",
      })
      expect(JSON.stringify(mixedSelector.results)).not.toContain("BLUE-LANTERN-42")
      expect(mixedSelector.appliedFilters.turnNo).toBeUndefined()
      expect(mixedSelector.appliedFilters.role).toBe("user")
      expect(mixedSelector.warnings?.join(" ")).toContain("both query and turnNo")
      expect(mixedSelector.warnings?.join(" ")).toContain("turnNo was ignored")
      expect(mixedSelector.warnings?.join(" ")).toContain("role kept as a query filter")
      expect(mixedSelector.warnings?.join(" ")).toContain("without query")

      const broad = await store.retrieveToolTraces(project.id, live.id, {
        scope: "project",
        turnNo: 2,
        role: "user",
      })
      expect(broad.results[0]?.entryType).toBe("user_query")
      expect(broad.results[0]?.messageId).toBe(second.userMessageId)

      const outOfRange = await store.retrieveToolTraces(project.id, live.id, {
        scope: "project",
        turnNo: 5,
        role: "user",
      })
      expect(outOfRange.results).toHaveLength(0)
      expect(outOfRange.warnings?.join(" ")).toContain("No turn number 5")
    } finally {
      await store.close()
    }
  })

  it("returns broad turnNo matches and inspects ordered conversation bundles", async () => {
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
        scope: "project",
        turnNo: 1,
        role: "user",
      })
      expect(ambiguous.results).toHaveLength(2)
      expect(ambiguous.results.every((result) => result.entryType === "user_query")).toBe(true)
      expect(ambiguous.results.map((result) => result.conversationTitle)).toEqual(["Shared Ordinal", "Shared Ordinal"])

      const bundle = await store.retrieveToolTraces(project.id, live.id, {
        operation: "inspect",
        conversationId: second.id,
        startTurnNo: 2,
        turnLimit: 2,
      })
      expect(bundle.results[0]?.entryType).toBe("continuation_summary")
      expect(JSON.stringify(bundle.results)).toContain("[turn 2")
      expect(JSON.stringify(bundle.results)).toContain("Second conversation turn two")
      expect(JSON.stringify(bundle.results)).toContain("[turn 3")
      expect(JSON.stringify(bundle.results)).not.toContain("Second shared source")
      expect(bundle.appliedFilters.startTurnNo).toBe(2)
      expect(bundle.appliedFilters.turnLimit).toBe(2)
    } finally {
      await store.close()
    }
  })

  it("scopes trace retrieval to visible conversations and cleans trace data on hard delete", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const source = await createConversation(app, project.id, "Visible Trace Source")
    const live = await createConversation(app, project.id, "Trace Live")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle)
    const sourceSessionId = insertTestSession(handle.sqlite, project.id, source.id)
    const sourceTurn = insertCompletedTestTurn(
      handle.sqlite,
      source.id,
      sourceSessionId,
      "The active trace key is VISIBLE-TOKEN-91.",
      "Visible assistant reply.",
      new Date(Date.now() - 2_000).toISOString(),
    )
    const sourceToolCallId = createId("tcall")
    const now = nowIso()
    handle.sqlite
      .prepare(
        `INSERT INTO tool_calls (
          id, conversation_id, session_id, turn_id, tool_name, status, arguments_json, result_json,
          requires_approval, started_at, completed_at
        ) VALUES (?, ?, ?, ?, 'read', 'completed', ?, ?, 0, ?, ?)`,
      )
      .run(
        sourceToolCallId,
        source.id,
        sourceSessionId,
        sourceTurn.turnId,
        JSON.stringify({ path: ".socrates/attachments/visible.png" }),
        JSON.stringify({ path: ".socrates/attachments/visible.png", kind: "image" }),
        now,
        now,
      )
    store.indexTurnTraceDocuments(project.id, source.id, sourceTurn.turnId)

    const sourceTraceDocId = handle.sqlite
      .prepare("SELECT id FROM trace_documents WHERE conversation_id = ? LIMIT 1")
      .get(source.id) as { id: string }
    handle.sqlite
      .prepare(
        `INSERT INTO trace_embeddings
          (id, project_id, trace_document_id, provider_id, model_id, dimensions, content_hash, vector_json, status, created_at, updated_at, embedded_at)
         SELECT ?, project_id, id, 'openai', 'text-embedding-3-small', 3, content_hash, '[1,0,0]', 'completed', ?, ?, ?
         FROM trace_documents
         WHERE id = ?`,
      )
      .run(createId("temb"), now, now, now, sourceTraceDocId.id)

    const orphanConversationId = createId("conv")
    const orphanTurnId = createId("turn")
    const orphanMessageId = createId("msg")
    const orphanHandle = createId("tdoc")
    handle.sqlite
      .prepare(
        `INSERT INTO trace_documents (
          id, project_id, conversation_id, turn_id, source_kind, source_table, source_id, handle, title, summary,
          content, content_hash, importance, preserve_verbatim, chunk_index, token_count_estimate, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'message', 'messages', ?, ?, 'Deleted screenshot message', 'Orphaned deleted trace',
          'ORPHAN-SCREENSHOT-777 should be invisible.', 'orphan-hash', 'normal', 0, 0, 12, '{"role":"user"}', ?, ?)`,
      )
      .run(orphanHandle, project.id, orphanConversationId, orphanTurnId, orphanMessageId, orphanHandle, now, now)
    handle.sqlite
      .prepare(
        `INSERT INTO trace_documents_fts (trace_document_id, title, summary, content, metadata_text)
         VALUES (?, 'Deleted screenshot message', 'Orphaned deleted trace', 'ORPHAN-SCREENSHOT-777 should be invisible.', '{"role":"user"}')`,
      )
      .run(orphanHandle)
    handle.sqlite
      .prepare(
        `INSERT INTO trace_embeddings
          (id, project_id, trace_document_id, provider_id, model_id, dimensions, content_hash, vector_json, status, created_at, updated_at, embedded_at)
         VALUES (?, ?, ?, 'openai', 'text-embedding-3-small', 3, 'orphan-hash', '[0,1,0]', 'completed', ?, ?, ?)`,
      )
      .run(createId("temb"), project.id, orphanHandle, now, now, now)
    handle.sqlite
      .prepare(
        `INSERT INTO trace_index_jobs (id, project_id, conversation_id, turn_id, job_kind, status, attempts, created_at, started_at, completed_at)
         VALUES (?, ?, ?, ?, 'build_trace_documents', 'completed', 1, ?, ?, ?)`,
      )
      .run(createId("tjob"), project.id, orphanConversationId, orphanTurnId, now, now, now)

    try {
      const orphanSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "ORPHAN-SCREENSHOT-777",
        scope: "project",
        mode: "exact",
      })
      expect(orphanSearch.results).toHaveLength(0)
      const orphanInspectByHandle = await store.retrieveToolTraces(project.id, live.id, { operation: "inspect", handle: orphanHandle })
      expect(orphanInspectByHandle.results).toHaveLength(0)
      expect(orphanInspectByHandle.warnings?.join(" ")).toContain("may have been deleted")
      const orphanInspectByMessage = await store.retrieveToolTraces(project.id, live.id, {
        operation: "inspect",
        messageId: orphanMessageId,
      })
      expect(orphanInspectByMessage.results).toHaveLength(0)

      const visibleSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "VISIBLE-TOKEN-91",
        scope: "project",
        mode: "exact",
      })
      expect(visibleSearch.results[0]?.conversationTitle).toBe("Visible Trace Source")
      expect(visibleSearch.results[0]?.messageId).toBe(sourceTurn.userMessageId)
      expect(visibleSearch.results[0]?.entryType).toBe("user_query")

      const titleScopedSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "VISIBLE-TOKEN-91",
        scope: "project",
        conversationTitle: "  visible   trace-source  ",
        conversationLimit: 50,
        mode: "exact",
      })
      expect(titleScopedSearch.appliedFilters.conversationTitle).toBe("  visible   trace-source  ")
      expect(titleScopedSearch.appliedFilters.conversationIds).toEqual([source.id])
      expect(titleScopedSearch.results[0]?.conversationTitle).toBe("Visible Trace Source")

      const idScopedSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "VISIBLE-TOKEN-91",
        scope: "project",
        conversationId: source.id,
        mode: "exact",
      })
      expect(idScopedSearch.appliedFilters.conversationId).toBe(source.id)
      expect(idScopedSearch.appliedFilters.conversationIds).toEqual([source.id])
      expect(idScopedSearch.results[0]?.conversationTitle).toBe("Visible Trace Source")

      const inspectByResult = await store.retrieveToolTraces(project.id, live.id, { operation: "inspect", resultNumber: 1 })
      expect(JSON.stringify(inspectByResult.results)).toContain("VISIBLE-TOKEN-91")

      const toolOnlyNormalSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: ".socrates/attachments/visible.png",
        scope: "project",
        mode: "exact",
      })
      expect(toolOnlyNormalSearch.results).toHaveLength(0)
      await expect(
        store.retrieveToolTraces(project.id, live.id, {
          query: ".socrates/attachments/visible.png",
          include: ["tool_calls"],
        }),
      ).rejects.toThrow('mode="audit"')
      const toolOnlyAuditSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: ".socrates/attachments/visible.png",
        scope: "project",
        mode: "audit",
        include: ["tool_calls"],
      })
      expect(toolOnlyAuditSearch.results[0]?.entryType).toBe("tool_call")
      expect(toolOnlyAuditSearch.results[0]?.toolId).toBe(sourceToolCallId)

      const inspectByMessage = await store.retrieveToolTraces(project.id, live.id, {
        operation: "inspect",
        messageId: sourceTurn.userMessageId,
      })
      expect(JSON.stringify(inspectByMessage.results)).toContain("VISIBLE-TOKEN-91")
      const shortcutInspectByMessage = await store.retrieveToolTraces(project.id, live.id, {
        query: "ignored when exact messageId is present",
        messageId: sourceTurn.userMessageId,
      } as never)
      expect(shortcutInspectByMessage.appliedFilters.operation).toBe("inspect")
      expect(JSON.stringify(shortcutInspectByMessage.results)).toContain("VISIBLE-TOKEN-91")
      const inspectByTool = await store.retrieveToolTraces(project.id, live.id, {
        operation: "inspect",
        toolCallId: sourceToolCallId,
      })
      expect(JSON.stringify(inspectByTool.results)).toContain(".socrates/attachments/visible.png")
      const shortcutInspectByTool = await store.retrieveToolTraces(project.id, live.id, {
        mode: "audit",
        toolId: sourceToolCallId,
      } as never)
      expect(shortcutInspectByTool.appliedFilters.operation).toBe("inspect")
      expect(JSON.stringify(shortcutInspectByTool.results)).toContain(".socrates/attachments/visible.png")
      const inspectByTurn = await store.retrieveToolTraces(project.id, live.id, {
        operation: "inspect",
        turnId: sourceTurn.turnId,
      })
      expect(JSON.stringify(inspectByTurn.results)).toContain("VISIBLE-TOKEN-91")
      const inspectByConversation = await store.retrieveToolTraces(project.id, live.id, {
        operation: "inspect",
        conversationId: source.id,
      })
      expect(JSON.stringify(inspectByConversation.results)).toContain("VISIBLE-TOKEN-91")
    } finally {
      await store.close()
    }

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/projects/${project.id}/conversations/${source.id}`,
    })
    const deleteBody = parseResponse<{ deletedConversationId: string }>(deleteResponse.payload)
    expect(deleteBody.ok).toBe(true)

    const sqlite = new Database(dbPath)
    try {
      const row = sqlite
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM trace_documents WHERE conversation_id = ?) AS document_count,
             (SELECT COUNT(*) FROM trace_documents_fts WHERE trace_document_id = ?) AS fts_count,
             (SELECT COUNT(*) FROM trace_embeddings WHERE trace_document_id = ?) AS embedding_count,
             (SELECT COUNT(*) FROM trace_index_jobs WHERE conversation_id = ?) AS job_count`,
        )
        .get(source.id, sourceTraceDocId.id, sourceTraceDocId.id, source.id) as {
        document_count: number
        fts_count: number
        embedding_count: number
        job_count: number
      }
      expect(row.document_count).toBe(0)
      expect(row.fts_count).toBe(0)
      expect(row.embedding_count).toBe(0)
      expect(row.job_count).toBe(0)
    } finally {
      sqlite.close()
    }
  })

  it("excludes the active conversation from default memory search and inspects the matched assistant message directly", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const source = await createConversation(app, project.id, "apply patch fix")
    const live = await createConversation(app, project.id, "trace retrieve test 2")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle)
    try {
      const sourceSession = insertTestSession(handle.sqlite, project.id, source.id)
      insertCompletedTestTurn(handle.sqlite, source.id, sourceSession, "Earlier prompt one.", "Earlier answer one.", new Date(Date.now() - 5_000).toISOString())
      insertCompletedTestTurn(handle.sqlite, source.id, sourceSession, "Earlier prompt two.", "Earlier answer two.", new Date(Date.now() - 4_000).toISOString())
      const stalenessQuote =
        "The staleness guard caught it cold. Patch B was rejected with a clear error: the expected hash was the pre-patch-A hash, but the file on disk now has patch A's hash. No silent corruption."
      const investigativeAssistantText = [
        "Let me set up both tests. First, let me read the current state of the test file and create a reliable anchor for the concurrent-edit simulation.",
        "context above 1",
        "context above 2",
        "context above 3",
        "context above 4",
        "context above 5",
        "context above 6",
        "context above 7",
        "context above 8",
        `**Test A: PASSED.** ${stalenessQuote}`,
        "context below 1",
        "context below 2",
        "context below 3",
        "context below 4",
        "context below 5",
        "context below 6",
        "context below 7",
        "context below 8",
        "Test B: Partial failure error diagnostics. Now let me apply a 3-hunk patch where hunk 2 has a deliberately wrong anchor. I need to re-read first.",
      ].join("\n")
      const target = insertCompletedTestTurn(
        handle.sqlite,
        source.id,
        sourceSession,
        "ok i have modified the tool exactly for your two concerns, can you maybe run a quick check and tell me if you feell its good now?",
        investigativeAssistantText,
        new Date(Date.now() - 3_000).toISOString(),
      )
      const liveSession = insertTestSession(handle.sqlite, project.id, live.id)
      insertCompletedTestTurn(
        handle.sqlite,
        live.id,
        liveSession,
        'hey can you find which conversation this text is from , "Test B: Partial failure error diagnostics. Now let me apply a 3-hunk patch where hunk 2 has a deliberately wrong anchor. I need to re-read first."',
        "Working on it.",
        new Date(Date.now() - 2_000).toISOString(),
      )
      store.indexTurnTraceDocuments(project.id, source.id, target.turnId)
      const liveTargetTurn = handle.sqlite
        .prepare("SELECT id FROM turns WHERE conversation_id = ? ORDER BY started_at DESC LIMIT 1")
        .get(live.id) as { id: string }
      store.indexTurnTraceDocuments(project.id, live.id, liveTargetTurn.id)

      const search = await store.retrieveToolTraces(project.id, live.id, {
        query: "Test B: Partial failure error diagnostics",
        scope: "recent_conversations",
        conversationLimit: 20,
        mode: "exact",
        limit: 10,
      })

      expect(search.results.length).toBeGreaterThan(0)
      expect(search.results[0]?.conversationTitle).toBe("apply patch fix")
      expect(search.results[0]?.conversationId).toBe(source.id)
      expect(search.results[0]?.messageId).toBe(target.assistantMessageId)
      expect(search.results[0]?.entryType).toBe("assistant_response")
      expect(search.results[0]?.messageNo).toBe(3)
      expect(search.results[0]?.provenanceKind).toBe("original_turn")
      expect(search.results[0]?.pairedUserMessageNo).toBe(3)
      expect(search.results[0]?.pairedUserPreview).toContain("ok i have modified the tool")
      const firstSearchResult = search.results[0]
      expect(firstSearchResult && "text" in firstSearchResult ? firstSearchResult.text : "").toContain("Test B: Partial failure error diagnostics")

      const stalenessSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "staleness guard caught it cold",
        scope: "recent_conversations",
        conversationLimit: 20,
        mode: "exact",
        entryType: "assistant_response",
        limit: 5,
      })
      expect(stalenessSearch.results[0]?.messageId).toBe(target.assistantMessageId)
      const stalenessText = stalenessSearch.results[0] && "text" in stalenessSearch.results[0] ? stalenessSearch.results[0].text : ""
      expect(stalenessText).toContain(stalenessQuote)
      expect(stalenessText).toContain("context above 1")
      expect(stalenessText).toContain("context above 8")
      expect(stalenessText).toContain("context below 1")
      expect(stalenessText).toContain("context below 8")

      const inspectByResult = await store.retrieveToolTraces(project.id, live.id, { operation: "inspect", resultNumber: 1 })
      expect(inspectByResult.results[0]?.entryType).toBe("assistant_response")
      expect(inspectByResult.results[0]?.conversationTitle).toBe("apply patch fix")
      expect(inspectByResult.results[0]?.messageId).toBe(target.assistantMessageId)
      expect(inspectByResult.results[0]?.messageNo).toBe(3)
      expect(inspectByResult.results[0]?.provenanceKind).toBe("original_turn")
      expect(inspectByResult.results[0]?.pairedUserMessageNo).toBe(3)
      expect(inspectByResult.results[0]?.pairedUserPreview).toContain("ok i have modified the tool")
      expect(JSON.stringify(inspectByResult.results[0])).toContain("Test B: Partial failure error diagnostics")

      handle.sqlite
        .prepare(
          `INSERT INTO message_attachments (
            id, project_id, conversation_id, session_id, turn_id, message_id, artifact_id, kind, file_name,
            mime_type, size_bytes, uri, status, created_at, updated_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'image', 'attached-proof.png', 'image/png', 12, '.socrates/attachments/attached-proof.png', 'attached', ?, ?, '{}')`,
        )
        .run(createId("att"), project.id, source.id, sourceSession, target.turnId, target.userMessageId, createId("art"), nowIso(), nowIso())
      store.indexTurnTraceDocuments(project.id, source.id, target.turnId)

      const assistantRoleSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "hunk 2 has a deliberately wrong anchor",
        scope: "recent_conversations",
        mode: "exact",
        role: "assistant",
      })
      expect(assistantRoleSearch.results[0]?.messageId).toBe(target.assistantMessageId)
      expect(assistantRoleSearch.appliedFilters.role).toBe("assistant")

      const userRoleSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "hunk 2 has a deliberately wrong anchor",
        scope: "recent_conversations",
        mode: "exact",
        role: "user",
      })
      expect(userRoleSearch.results).toHaveLength(0)

      const assistantEntryTypeSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "hunk 2 has a deliberately wrong anchor",
        scope: "recent_conversations",
        mode: "exact",
        entryType: "assistant_response",
      })
      expect(assistantEntryTypeSearch.results[0]?.messageId).toBe(target.assistantMessageId)
      expect(assistantEntryTypeSearch.appliedFilters.entryType).toBe("assistant_response")

      const attachmentSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "ok i have modified the tool",
        scope: "recent_conversations",
        mode: "exact",
        hasAttachment: true,
      })
      expect(attachmentSearch.results[0]?.messageId).toBe(target.userMessageId)
      expect(attachmentSearch.results[0]?.provenanceKind).toBe("attachment_origin")
      expect(attachmentSearch.appliedFilters.hasAttachment).toBe(true)

      const dateFilteredSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "Test B: Partial failure error diagnostics",
        scope: "recent_conversations",
        mode: "exact",
        createdAfter: new Date(Date.now() + 60_000).toISOString(),
      })
      expect(dateFilteredSearch.results).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("browses recent conversations without query as grouped Q/A pairs", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const older = await createConversation(app, project.id, "Older Investigation")
    const source = await createConversation(app, project.id, "Latest Investigation")
    const live = await createConversation(app, project.id, "Live Investigation")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle)
    try {
      const olderSession = insertTestSession(handle.sqlite, project.id, older.id)
      insertCompletedTestTurn(handle.sqlite, older.id, olderSession, "Older first user", "Older first assistant", new Date(Date.now() - 7_000).toISOString())
      const sourceSession = insertTestSession(handle.sqlite, project.id, source.id)
      insertCompletedTestTurn(handle.sqlite, source.id, sourceSession, "Source first user", "Source first assistant", new Date(Date.now() - 3_000).toISOString())
      const second = insertCompletedTestTurn(
        handle.sqlite,
        source.id,
        sourceSession,
        "Source second user",
        "Source second assistant",
        new Date(Date.now() - 2_000).toISOString(),
      )

      const browse = await store.retrieveToolTraces(project.id, live.id, {
        scope: "recent_conversations",
        conversationLimit: 1,
        perConversationLimit: 2,
      })
      expect(browse.results).toHaveLength(2)
      expect(browse.results[0]?.entryType).toBe("qa_pair")
      expect(browse.results[0]?.conversationTitle).toBe("Latest Investigation")
      expect(browse.results[0]?.turnNo).toBe(2)
      expect(JSON.stringify(browse.results[0])).toContain("Source second user")
      expect(browse.appliedFilters.perConversationLimit).toBe(2)

      const roleBrowse = await store.retrieveToolTraces(project.id, live.id, {
        scope: "recent_conversations",
        conversationLimit: 1,
        perConversationLimit: 1,
        role: "user",
      })
      expect(roleBrowse.results).toHaveLength(1)
      expect(roleBrowse.results[0]?.entryType).toBe("user_query")
      expect(roleBrowse.results[0]?.messageId).toBe(second.userMessageId)
      expect(roleBrowse.results[0]?.messageNo).toBe(2)

      const offsetBrowse = await store.retrieveToolTraces(project.id, live.id, {
        scope: "recent_conversations",
        conversationLimit: 1,
        conversationOffset: 1,
        perConversationLimit: 1,
      })
      expect(offsetBrowse.results[0]?.conversationTitle).toBe("Older Investigation")
      expect(offsetBrowse.appliedFilters.conversationOffset).toBe(1)

      const futureBrowse = await store.retrieveToolTraces(project.id, live.id, {
        scope: "project",
        updatedAfter: new Date(Date.now() + 60_000).toISOString(),
      })
      expect(futureBrowse.results).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("creates lean Socrates memory files, exposes docs tools, and keeps recall routing in the stable prompt", async () => {
    const requests: unknown[] = []
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const scaffoldedToolDoc = [
      "---",
      "socrates_doc: tool_doc",
      "schema_version: 1",
      "owner_tool: tool_docs",
      "scope: global",
      "index_tags: [tool_usage]",
      "---",
      "",
      "# read search Usage Guide",
      "",
      '<!-- socrates:section id="purpose" kind="purpose" tags="tools" -->',
      "## Purpose",
      "",
      "- What this tool guidance is for.",
      "<!-- /socrates:section -->",
      "",
      '<!-- socrates:section id="legacy_content" kind="legacy" tags="migration" -->',
      "## Legacy Content",
      "",
      "# read_search Usage Guide",
      "",
      "Use `search` to find candidate files or lines.",
      "<!-- /socrates:section -->",
      "",
    ].join("\n")
    fs.mkdirSync(path.join(socratesHome, "tool_usage"), { recursive: true })
    fs.writeFileSync(path.join(socratesHome, "tool_usage", "read_search.md"), scaffoldedToolDoc)
    fs.writeFileSync(path.join(socratesHome, "operating_principles.md"), "# Retired\n\nThis file should be deleted.")
    fs.mkdirSync(path.join(socratesHome, "primary"), { recursive: true })
    fs.writeFileSync(path.join(socratesHome, "primary", "operating_principles.md"), "# Retired Primary\n\nThis file should not be copied forward.")
    const app = await buildTestServer(dbPath, createCapturingAgent(requests), { socratesHome })
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    fs.writeFileSync(path.join(primaryWorkspace.path as string, ".socrates", "MEMORY.md"), "# Project Memory\n\nDurable recall key: WAKE-LEAN-42.\n")
    fs.writeFileSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "CORE_IDEA.md"), "# Core Idea\n\nCurrent focus: lean memory architecture.\n")
    const conversation = await createConversation(app, project.id, "Memory Stable Prompt")

    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "start with memory"))
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "continue with the startup map"))
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")
    } finally {
      socket.close()
    }

    expect(fs.existsSync(path.join(socratesHome, "identity.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "operating_principles.md"))).toBe(false)
    expect(fs.existsSync(path.join(socratesHome, "primary", "operating_principles.md"))).toBe(false)
    expect(fs.existsSync(path.join(socratesHome, "user_profile.md"))).toBe(true)
    expect(fs.readFileSync(path.join(socratesHome, "identity.md"), "utf8")).toContain("user_profile.md")
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "trace_retrieve.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_docs.md"))).toBe(false)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "project_docs.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "repo_docs.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "skills.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "mcp_registry.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "soul.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "user_profile.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "tool_docs.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "current_time.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "trace_retrieve.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "trace_retrieve_global.md"))).toBe(false)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "tool_docs.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "skills.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "soul.md"))).toBe(true)
	    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "user_profile.md"))).toBe(true)
    const readSearchToolDoc = expectStructuredToolDoc(socratesHome, "read_search.md")
    expect(readSearchToolDoc).toContain("Use read/search tools to find candidate workspace files")
	    const projectDocsToolDoc = expectStructuredToolDoc(socratesHome, "project_docs.md")
	    expect(projectDocsToolDoc).toContain("`.socrates/MEMORY.md`")
	    expectStructuredToolDoc(socratesHome, "user_profile.md")
	    const traceToolDoc = expectStructuredToolDoc(socratesHome, "trace_retrieve.md")
	    expect(traceToolDoc).toContain('mode: "lexical"')
	    expect(traceToolDoc).toContain("cross-project selectors are unavailable")
	    expectStructuredToolDoc(socratesHome, path.join("memory_agent", "edit_files.md"))
	    expectStructuredToolDoc(socratesHome, path.join("memory_agent", "user_profile.md"))
	    const memoryNotesToolDoc = expectStructuredToolDoc(socratesHome, path.join("memory_agent", "memory_notes.md"))
	    expect(memoryNotesToolDoc).toContain("inspect the exact full Q&A parent")
	    expect(memoryNotesToolDoc).toContain("Interpret intent semantically")
	    expect(memoryNotesToolDoc).toContain("ordinary workspace-artifact restrictions")
	    const memoryTraceToolDoc = expectStructuredToolDoc(socratesHome, path.join("memory_agent", "trace_retrieve.md"))
	    expect(memoryTraceToolDoc).toContain("cross-project scope")
	    expect(memoryTraceToolDoc).toContain("Legacy `exact`")
    expect(fs.existsSync(path.join(socratesHome, "skills"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "useful_patterns"))).toBe(false)
    expect(fs.existsSync(path.join(socratesHome, "projects", project.id))).toBe(false)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "MEMORY.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"))).toBe(true)
    expect(fs.readFileSync(path.join(primaryWorkspace.path as string, ".socrates", "MEMORY.md"), "utf8")).toContain("socrates_doc: project_memory")
    expect(fs.readFileSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"), "utf8")).toContain("socrates_doc: project_notes")
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "skills"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "CORE_IDEA.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "REPO_NAVIGATION.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "REPO_RULES.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "CONTRACTS.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "APP_FLOW.md"))).toBe(false)
    const requestTexts = requests.flatMap((request) => {
      const item = request as { system?: unknown; messages?: Array<{ role?: string; content?: unknown }> }
      return [String(item.system ?? ""), ...(item.messages ?? []).map((message) => String(message.content ?? ""))]
    })
    const allRequestText = requestTexts.join("\n")
    const systemText = requests.map((request) => String((request as { system?: unknown }).system ?? "")).join("\n")
    const developerText = requests
      .flatMap((request) => ((request as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? []).filter((message) => message.role === "developer").map((message) => String(message.content ?? "")))
      .join("\n")
    const controlText = `${systemText}\n${developerText}`
    expect(allRequestText).not.toContain("<socrates_wake_context>")
    expect(allRequestText).not.toContain("Stable project recall map")
    expect(allRequestText).not.toContain("Skill counts:")
    expect(controlText).not.toContain("WAKE-LEAN-42")
    expect(controlText).not.toContain("lean memory architecture")
    expect(controlText).not.toContain("Socrates State Ledger")
    expect(controlText).not.toContain("Last turn: completed")
    expect(systemText).toContain("Mandatory first-turn active recall")
    expect(systemText).toContain("Stable recall routing")
    expect(systemText).toContain("project_docs notes active_context for project-local open loops and active recall")
    expect(systemText).toContain("For project-local \"remember/keep in mind\" items, update notes `active_context`")
    expect(systemText).toContain("project_docs memory for durable project state")
    expect(systemText).toContain("repo_docs for repo doctrine")
    expect(systemText).toContain("skills for reusable workflows")
    expect(systemText).toContain("mcp_registry for external tool servers")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome })
    try {
      const listedSkills = store.runSkillsTool(project.id, { operation: "list" })
      expect(listedSkills.skills.some((skill) => skill.name === "socrates-skill-writer")).toBe(false)
      expect(() => store.runSkillsTool(project.id, { operation: "describe", id: "socrates-skill-writer", scope: "builtin" })).toThrow(/Skill was not found/)
      const soulSectionRead = store.runSoulTool(project.id, { operation: "read_section", sectionId: "operating_principles" })
      expect(soulSectionRead.content).toContain("Prefer evidence")
      const soulFullRead = store.runSoulTool(project.id, { operation: "read", charLimit: 80_000 })
      expect(soulFullRead.truncation.charLimit).toBe(8_000)
      const userProfileRead = store.runUserProfileTool(project.id, { operation: "read" })
      expect(userProfileRead.content).toContain("No stable profile facts captured yet")
      expect(userProfileRead.content).toContain("## Active Context")
      expect(userProfileRead.truncation.charLimit).toBe(8_000)
      const userProfileSectionRead = store.runUserProfileTool(project.id, { operation: "read_section", sectionId: "stable_preferences" })
      expect(userProfileSectionRead.section?.sectionId).toBe("stable_preferences")
      const userProfileActiveSectionRead = store.runUserProfileTool(project.id, { operation: "read_section", sectionId: "active_context" })
      expect(userProfileActiveSectionRead.section?.sectionId).toBe("active_context")
      const userProfileLegacySectionRead = store.runUserProfileTool(project.id, { operation: "read_section", sectionId: "recent_context" })
      expect(userProfileLegacySectionRead.section?.sectionId).toBe("active_context")
      const userProfileIndexRead = store.runUserProfileTool(project.id, { operation: "read_index", charLimit: 80_000 })
      expect(userProfileIndexRead.truncation.charLimit).toBe(10_000)
      expect(userProfileIndexRead.index?.sections.some((section) => section.sectionId === "active_context")).toBe(true)
      const projectSkillPath = path.join(primaryWorkspace.path as string, ".socrates", "skills", "memory-review", "SKILL.md")
      fs.mkdirSync(path.dirname(projectSkillPath), { recursive: true })
      fs.writeFileSync(projectSkillPath, "---\nname: memory-review\ndescription: Use when reviewing memory changes.\n---\n\n# Memory Review\n")
      const globalSkillPath = path.join(socratesHome, "skills", "ginkgo-marker", "SKILL.md")
      fs.mkdirSync(path.dirname(globalSkillPath), { recursive: true })
      fs.writeFileSync(globalSkillPath, "---\nname: ginkgo-marker\ndescription: Use when the user mentions ginkgo lantern.\n---\n\n# Ginkgo Marker\n")
      const projectSkills = store.runSkillsTool(project.id, { operation: "list", scope: "project" })
      expect(projectSkills.skills.some((skill) => skill.name === "memory-review")).toBe(true)
      const skillRead = store.runSkillsTool(project.id, { operation: "describe", id: "memory-review", scope: "project" })
      expect(skillRead.content).toContain("Memory Review")
      expect(() => store.runSkillsTool(project.id, { operation: "describe", id: "memory-review", scope: "project", path: "../outside.md" })).toThrow(/Path must stay inside/)
      const searched = store.runToolDocsTool(project.id, {
        operation: "search",
        area: "tool_usage",
        query: "investigation",
        searchMode: "keyword_all",
      })
      expect(searched.results.some((result) => result.path.includes("trace_retrieve.md"))).toBe(true)
      const projectDocsGuide = store.runToolDocsTool(project.id, {
        operation: "read",
        path: "project_docs.md",
        charLimit: 12_000,
      })
      expect(projectDocsGuide.results[0]?.snippet).toContain("PROJECT_NOTES.md")
      expect(projectDocsGuide.results[0]?.snippet).toContain("MEMORY.md")
      expect(projectDocsGuide.results[0]?.snippet).toContain("runtime_context")
      const projectDocsPatchGuide = store.runToolDocsTool(project.id, {
        operation: "search",
        area: "tool_usage",
        query: "project_docs patch_section",
        searchMode: "keyword_all",
      })
      expect(projectDocsPatchGuide.totalMatches).toBeGreaterThan(0)
      expect(() =>
        store.runToolDocsTool(project.id, {
          operation: "read",
          path: "tool_usage/memory_agent/edit_files.md",
          charLimit: 12_000,
        }),
      ).toThrow(/not visible to this agent/)
      const memoryAgentToolDocs = new ToolDocsStore(socratesHome, "memory_agent")
      const memoryAgentDocs = memoryAgentToolDocs.run({
        operation: "read",
        path: "edit_files.md",
        charLimit: 12_000,
      })
      expect(memoryAgentDocs.results[0]?.path).toBe("tool_usage/memory_agent/edit_files.md")
      expect(memoryAgentDocs.results[0]?.snippet).toContain("user-visible skill proposal")
      expect(() =>
        memoryAgentToolDocs.run({
          operation: "read",
          path: "tool_usage/project_docs.md",
          charLimit: 12_000,
        }),
      ).toThrow(/not visible to this agent/)
      const notesRead = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, { operation: "read", area: "notes" })
      expect(notesRead.runtime?.source).toBe("system")
      expect(notesRead.runtime?.currentDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(notesRead.content).toContain("socrates_doc: project_notes")
      expect(notesRead.content).toContain("# Project Notes")
      expect(notesRead.content).toContain("## Runtime Context")
      expect(notesRead.content).toContain("terminal_state: omitted")
      const notesIndex = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, { operation: "read_index", area: "notes" })
      expect(notesIndex.index?.sections.some((section) => section.sectionId === "runtime_context")).toBe(true)
      expect(notesIndex.index?.sections.some((section) => section.sectionId === "state_ledger")).toBe(true)
      expect(notesIndex.index?.sections.some((section) => section.sectionId === "active_context")).toBe(true)
      expect(() =>
        store.runProjectDocsTool(project.id, primaryWorkspace.path as string, {
          operation: "patch_section",
          area: "notes",
          sectionId: "runtime_context",
          oldText: "terminal_state: omitted",
          newText: "terminal_state: captured",
        }),
      ).toThrow(/system-owned/)
      const notesSection = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, { operation: "read_section", area: "notes", sectionId: "active_todos" })
      expect(notesSection.section?.sectionId).toBe("active_todos")
      const activeContextSection = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, { operation: "read_section", area: "notes", sectionId: "active_context" })
      expect(activeContextSection.section?.sectionId).toBe("active_context")
      const notesPatch = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, {
        operation: "edit",
        area: "notes",
        editMode: "append",
        text: "- Memory tool smoke note.",
      })
      expect(notesPatch.changed).toBe(true)
      const projectNotesAfterPatch = fs.readFileSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"), "utf8")
      expect(projectNotesAfterPatch).toContain("Memory tool smoke note")
      expect(projectNotesAfterPatch).toContain('updated_by: "project_docs"')
      expect(projectNotesAfterPatch).toContain('last_edited_section: "document"')
      expect(() =>
        store.runProjectDocsTool(project.id, primaryWorkspace.path as string, {
          operation: "patch_section",
          area: "notes",
          sectionId: "state_ledger",
          oldText: "Machine-managed compact state",
          newText: "Agent-managed state",
        }),
      ).toThrow(/system-owned/)
      const projectNotesPath = path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md")
      fs.appendFileSync(projectNotesPath, "\n<!-- socrates-state-ledger:start -->\nSTALE DUPLICATE LEDGER\n<!-- socrates-state-ledger:end -->\n")
      store.recordProjectStateLedgerTurn(project.id, conversation.id, "synthetic_cancelled_turn", "cancelled", "Cancelled after reading evidence.")
      const notesAfterCancelledLedger = fs.readFileSync(projectNotesPath, "utf8")
      expect(notesAfterCancelledLedger.match(/<!-- socrates-state-ledger:start -->/g)).toHaveLength(1)
      expect(notesAfterCancelledLedger).not.toContain("STALE DUPLICATE LEDGER")
      expect(notesAfterCancelledLedger).toContain("Last turn: cancelled")
      expect(notesAfterCancelledLedger).toContain("Outcome: turn cancelled")
      expect(notesAfterCancelledLedger).toContain("Docs touched: none")
      expect(notesAfterCancelledLedger).toContain("Recent failed tool attempts: none")
      expect(notesAfterCancelledLedger).not.toContain("Assistant/status preview")
      store.appendEvent({
        projectId: project.id,
        conversationId: conversation.id,
        sessionId: "synthetic_session",
        turnId: "synthetic_failed_turn",
        type: "tool.call.failed",
        source: "tool",
        payload: {
          error: {
            code: "invalid_tool_input",
            message: "Tool input did not match the schema",
            details: { formErrors: ["patch_section requires oldText and newText."] },
          },
        },
      })
      store.recordProjectStateLedgerTurn(project.id, conversation.id, "synthetic_failed_turn", "failed")
      const notesAfterFailedLedger = fs.readFileSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"), "utf8")
      expect(notesAfterFailedLedger).toContain("Outcome: turn failed; 1 failed/rejected attempt recorded")
      expect(notesAfterFailedLedger).toContain("Recent failed tool attempts: unknown_tool invalid_tool_input: patch_section requires oldText and newText.")
      const memoryRead = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, { operation: "read", area: "memory" })
      expect(memoryRead.content).toContain("WAKE-LEAN-42")
      const memorySectionPatch = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, {
        operation: "patch_section",
        area: "memory",
        sectionId: "handoff",
        oldText: "- Restart-ready handoff facts belong here.",
        newText: "- Restart with project_docs.read_index before broad reading.",
      })
      expect(memorySectionPatch.section?.content).toContain("project_docs.read_index")
      const memoryReplace = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, {
        operation: "edit",
        area: "memory",
        editMode: "replace",
        oldText: "Durable recall key: WAKE-LEAN-42.",
        newText: "Durable recall key: WAKE-LEAN-43.",
      })
      expect(memoryReplace.changed).toBe(true)
      const repoDocsIndex = store.runRepoDocsTool(project.id, primaryWorkspace.path as string, { operation: "read" })
      expect(repoDocsIndex.runtime?.source).toBe("system")
      expect(repoDocsIndex.paths).toContain(".socrates/repo_docs/REPO_RULES.md")
      expect(repoDocsIndex.paths).toContain(".socrates/repo_docs/CONTRACTS.md")
      const repoStructuredIndex = store.runRepoDocsTool(project.id, primaryWorkspace.path as string, { operation: "read_index", path: "REPO_RULES.md" })
      expect(repoStructuredIndex.index?.sections.some((section) => section.sectionId === "hard_rules")).toBe(true)
      const repoSectionPatch = store.runRepoDocsTool(project.id, primaryWorkspace.path as string, {
        operation: "patch_section",
        path: "REPO_RULES.md",
        sectionId: "hard_rules",
        oldText: "- Preserve user work; do not revert unrelated changes.",
        newText: "- Preserve user work; do not revert unrelated changes unless explicitly instructed.",
      })
      expect(repoSectionPatch.section?.content).toContain("explicitly instructed")
      const repoDocsSearch = store.runRepoDocsTool(project.id, primaryWorkspace.path as string, { operation: "search", query: "durable", path: "REPO_RULES.md" })
      expect(repoDocsSearch.matches?.[0]?.path).toBe(".socrates/repo_docs/REPO_RULES.md")
      const repoDocsPatch = store.runRepoDocsTool(project.id, primaryWorkspace.path as string, {
        operation: "edit",
        path: "REPO_RULES.md",
        oldText: "Keep it short, current, and practical.",
        newText: "Keep it short, current, practical, and easy for future agents to trust.",
      })
      expect(repoDocsPatch.changed).toBe(true)
      const repoRulesAfterPatch = fs.readFileSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "REPO_RULES.md"), "utf8")
      expect(repoRulesAfterPatch).toContain("future agents")
      expect(repoRulesAfterPatch).toContain('updated_by: "repo_docs"')
      expect(repoRulesAfterPatch).toContain('last_edited_section: "document"')
      expect(() =>
        store.runRepoDocsTool(project.id, primaryWorkspace.path as string, {
          operation: "edit",
          path: "REPO_RULES.md",
          oldText: "- ",
          newText: "- changed ",
        }),
      ).toThrow(/oldText matched more than once/)
      const indexedRows = handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_doc_indexes WHERE project_id = ?").get(project.id) as { count: number }
      const sectionRows = handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_doc_sections WHERE project_id = ? AND section_id IN ('handoff', 'hard_rules')").get(project.id) as { count: number }
      expect(indexedRows.count).toBeGreaterThanOrEqual(6)
      expect(sectionRows.count).toBeGreaterThanOrEqual(2)
    } finally {
      await store.close()
    }
  })

  it("creates human-facing memory notes with source refs, normalized dedupe, per-turn cap, and outcomes", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app, "Memory Notes Project")
    const conversation = await createConversation(app, project.id, "Memory Note Source")
    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome })
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const turn = insertCompletedTestTurn(
        handle.sqlite,
        conversation.id,
        sessionId,
        "I am comparing fans for the apartment, and please remember that I am allergic to shellfish.",
        "I can help compare fan options.",
        nowIso(),
      )

      const first = store.createMemoryNote(
        project.id,
        {
          note: "User mentioned a shellfish allergy and current fan-shopping context in the same natural turn.",
          importance: "high",
        },
        { conversationId: conversation.id, sessionId, turnId: turn.turnId },
      )
      expect(first).toMatchObject({ noteNumber: 1, status: "open", result: "created" })

      const duplicate = store.createMemoryNote(
        project.id,
        {
          note: "USER MENTIONED A SHELLFISH ALLERGY AND CURRENT FAN SHOPPING CONTEXT IN THE SAME NATURAL TURN!!!",
          importance: "high",
        },
        { conversationId: conversation.id, sessionId, turnId: turn.turnId },
      )
      expect(duplicate).toMatchObject({ noteNumber: 1, status: "open", result: "already_recorded" })

      const paraphrasedDuplicate = store.createMemoryNote(
        project.id,
        {
          note: "User mentioned current fan-shopping context and a shellfish allergy in this same natural turn.",
          importance: "high",
        },
        { conversationId: conversation.id, sessionId, turnId: turn.turnId },
      )
      expect(paraphrasedDuplicate).toMatchObject({ noteNumber: 1, status: "open", result: "already_recorded" })

      const second = store.createMemoryNote(
        project.id,
        { note: "User also wants apartment fan recommendations to account for quiet operation." },
        { conversationId: conversation.id, sessionId, turnId: turn.turnId },
      )
      expect(second).toMatchObject({ noteNumber: 2, status: "open", result: "created" })

      expect(() =>
        store.createMemoryNote(
          project.id,
          { note: "User has a third unrelated durable preference candidate in the same turn." },
          { conversationId: conversation.id, sessionId, turnId: turn.turnId },
        ),
      ).toThrow(/two distinct memory notes/)

      const stored = handle.sqlite
        .prepare("SELECT priority, intent, normalized_note_key AS normalizedNoteKey, message_id AS messageId, message_excerpt AS messageExcerpt, metadata_json AS metadataJson FROM memory_notes WHERE note_number = 1")
        .get() as { priority: string; intent: string; normalizedNoteKey: string; messageId: string; messageExcerpt: string; metadataJson: string }
      expect(stored.priority).toBe("high")
      expect(stored.intent).toBe("review_current_turn")
      expect(stored.normalizedNoteKey).toHaveLength(64)
      expect(stored.messageId).toBe(turn.userMessageId)
      expect(stored.messageExcerpt).toContain("allergic to shellfish")
      expect(JSON.parse(stored.metadataJson)).toMatchObject({
        attachedSource: "current_user_message",
        defaultSkillScope: "project",
        projectName: "Memory Notes Project",
        workspacePath: primaryWorkspace.path,
      })

      const createdEvent = handle.sqlite.prepare("SELECT payload_json AS payloadJson FROM events WHERE type = 'memory.note.created' ORDER BY sequence LIMIT 1").get() as { payloadJson: string }
      expect(JSON.parse(createdEvent.payloadJson)).toMatchObject({ noteNumber: 1, importance: "high", defaultSkillScope: "project", normalizedNoteKey: stored.normalizedNoteKey })
      const deduplicatedEvent = handle.sqlite.prepare("SELECT payload_json AS payloadJson FROM events WHERE type = 'memory.note.deduplicated' ORDER BY sequence LIMIT 1").get() as { payloadJson: string }
      expect(JSON.parse(deduplicatedEvent.payloadJson)).toMatchObject({ noteNumber: 1, normalizedNoteKey: stored.normalizedNoteKey })
      const noteCount = handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_notes WHERE turn_id = ?").get(turn.turnId) as { count: number }
      expect(noteCount.count).toBe(2)

      const listed = store.runMemoryNotesTool({ operation: "list", limit: 10 })
      expect(listed.notes).toHaveLength(2)
      expect(listed.totalMatches).toBe(2)
      expect(listed.notes[0]).toMatchObject({
        noteNumber: 1,
        status: "open",
        importance: "high",
        notePreview: expect.stringContaining("shellfish allergy"),
        projectId: project.id,
        projectName: "Memory Notes Project",
        defaultSkillScope: "project",
        workspacePath: primaryWorkspace.path,
      })
      expect(listed.notes[0] as Record<string, unknown>).not.toHaveProperty("intent")
      expect(listed.notes[0] as Record<string, unknown>).not.toHaveProperty("priority")

      const read = store.runMemoryNotesTool({ operation: "read", noteNumber: 1 })
      expect(read.notes[0]).toMatchObject({
        status: "processing",
        note: expect.stringContaining("shellfish allergy"),
        conversationId: conversation.id,
        turnId: turn.turnId,
        messageId: turn.userMessageId,
        messageExcerpt: expect.stringContaining("allergic to shellfish"),
      })

      expect(() => store.runMemoryNotesTool({ operation: "mark_done", noteNumber: 1 })).toThrow(/outcome/)
      expect(() => store.runMemoryNotesTool({ operation: "mark_done", noteNumber: 1, outcome: "applied" })).toThrow(/resolution/)
      const completed = store.runMemoryNotesTool({ operation: "mark_done", noteNumber: 1, outcome: "applied", resolution: "classified to user_profile.active_context: shellfish allergy is globally useful" })
      expect(completed.notes[0]).toMatchObject({ noteNumber: 1, status: "done", outcome: "applied", resolution: "classified to user_profile.active_context: shellfish allergy is globally useful" })
      const completedRow = handle.sqlite.prepare("SELECT outcome, resolution FROM memory_notes WHERE note_number = 1").get() as { outcome: string; resolution: string }
      expect(completedRow.outcome).toBe("applied")
      expect(completedRow.resolution).toContain("user_profile.active_context")
      const completedEvent = handle.sqlite.prepare("SELECT payload_json AS payloadJson FROM events WHERE type = 'memory.note.completed' ORDER BY sequence DESC LIMIT 1").get() as { payloadJson: string }
      expect(JSON.parse(completedEvent.payloadJson)).toEqual({ noteNumber: 1, outcome: "applied", resolution: "classified to user_profile.active_context: shellfish allergy is globally useful" })
    } finally {
      await store.close()
    }
  })

  it("defaults Memory Agent skill proposals to project scope when source evidence has a workspace", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app, "Project Scoped Skills")
    const conversation = await createConversation(app, project.id, "Project Skill Source")
    const handle = openDatabase(dbPath)
    let sourceTurnId = ""
    let callIndex = 0
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return { output: validMemoryAgentJournal({ skillsAffected: [{ action: "proposed_create", note: "Proposed a project skill." }] }) as TOutput }
      },
      async *stream() {
        callIndex += 1
        if (callIndex === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "memory_project_skill_proposal",
              toolName: "edit_files",
              input: {
                target: "skill",
                name: "fan-buying-guidance",
                editMode: "create",
                newText: "Create a project skill for comparing fan purchases in this workspace when the user is actively shopping.",
                rationale: "The pattern is tied to this project's current appliance-buying work.",
                sourceTurnIds: [sourceTurnId],
              },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nReviewed the source turn.\n\n## Changed\nProposed a project skill.\n\n## Skipped\nNone.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      for (let index = 0; index < 4; index += 1) {
        const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, `Fan buying workflow source ${index + 1}`, "Queued for memory.", nowIso())
        if (index === 0) {
          sourceTurnId = turn.turnId
        }
        insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: conversation.id, sessionId, turnId: turn.turnId })
      }

      await store.runGlobalMemoryAgent("manual")
      const proposedSkill = handle.sqlite
        .prepare("SELECT project_id AS projectId, status, target_path AS targetPath, metadata_json AS metadataJson FROM memory_agent_actions WHERE target_kind = 'skill_request'")
        .get() as { projectId: string; status: string; targetPath: string; metadataJson: string }
      expect(proposedSkill.status).toBe("proposed")
      expect(proposedSkill.projectId).toBe(project.id)
      expect(proposedSkill.targetPath).toBe(path.join(primaryWorkspace.path as string, ".socrates", "skills", "fan-buying-guidance", "SKILL.md"))
      expect(JSON.parse(proposedSkill.metadataJson)).toMatchObject({
        scope: "project",
        operation: "create",
        skillName: "fan-buying-guidance",
        projectName: "Project Scoped Skills",
        workspacePath: primaryWorkspace.path,
      })
      const notification = handle.sqlite.prepare("SELECT project_id AS projectId, payload_json AS payloadJson FROM notifications WHERE type = 'memory.skill.proposed'").get() as {
        projectId: string
        payloadJson: string
      }
      expect(notification.projectId).toBe(project.id)
      expect(JSON.parse(notification.payloadJson)).toMatchObject({
        scope: "project",
        operation: "create",
        skillName: "fan-buying-guidance",
        skillTitle: "Fan Buying Guidance",
        projectId: project.id,
        projectName: "Project Scoped Skills",
      })
      expect(fs.existsSync(path.join(socratesHome, "skills", "fan-buying-guidance", "SKILL.md"))).toBe(false)
    } finally {
      await store.close()
    }
  })

  it("self-heals a clearly misplaced global rule with one atomic evidence-backed move", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app, "Memory Self Healing")
    const conversation = await createConversation(app, project.id, "Misplaced Profile Rule")
    const handle = openDatabase(dbPath)
    const misplaced = "- **Code Implementation (Hard Rule)**: Discuss and plan before modifying files unless the user explicitly asks for implementation."
    const canonical = "- **Implementation Approval**: Discuss and plan before modifying files unless the user explicitly asks for implementation."
    let sourceTurnId = ""
    let callIndex = 0
    const modelInputs: string[] = []
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return { output: validMemoryAgentJournal({ decisions: ["Moved the misplaced hard rule."] }) as TOutput }
      },
      async *stream(request) {
        modelInputs.push(serializedRequestMessages(request))
        callIndex += 1
        if (callIndex === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "memory_self_heal_profile_rule",
              toolName: "edit_files",
              input: {
                target: "user_profile",
                editMode: "move",
                sourceSectionId: "collaboration_style",
                destinationSectionId: "global_always_apply_rules",
                sourceText: misplaced,
                destinationText: canonical,
                rationale: "The source says Hard Rule and explicitly governs implementation behavior across projects.",
                sourceTurnIds: [sourceTurnId],
              },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nAudited profile and identity.\n\n## Changed\nMoved the implementation hard rule to global always-apply rules.\n\n## Skipped\nNone.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      store.runUserProfileTool(project.id, { operation: "read" })
      const profilePath = path.join(socratesHome, "user_profile.md")
      const profile = {
        docType: "user_profile" as const,
        ownerTool: "user_profile" as const,
        scope: "global" as const,
        path: "user_profile.md",
        projectId: "global",
        indexTags: ["profile"],
      }
      const before = fs.readFileSync(profilePath, "utf8")
      const beforeIndex = parseMemoryDoc(before, profile)
      const collaboration = beforeIndex.sections.find((section) => section.sectionId === "collaboration_style")!
      const seeded = patchMemoryDocSection(before, profile, "collaboration_style", collaboration.content, `${collaboration.content}\n${misplaced}`)
      fs.writeFileSync(profilePath, seeded)

      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      for (let index = 0; index < 4; index += 1) {
        const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, `Implementation preference evidence ${index + 1}`, "The preference is durable.", nowIso())
        sourceTurnId ||= turn.turnId
        insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: conversation.id, sessionId, turnId: turn.turnId })
      }
      const withRule = fs.readFileSync(profilePath, "utf8")
      const withRuleIndex = parseMemoryDoc(withRule, profile)
      const evidence = withRuleIndex.sections.find((section) => section.sectionId === "evidence_index")!
      const evidenceEntry = [
        `- 2026-07-10 | project: Memory Self Healing | conversation: Misplaced Profile Rule | turnId: ${sourceTurnId}`,
        "  supports: The user requires explicit approval before implementation.",
        "  used_by: collaboration_style, stable_preferences",
      ].join("\n")
      fs.writeFileSync(profilePath, patchMemoryDocSection(withRule, profile, "evidence_index", evidence.content, `${evidence.content}\n${evidenceEntry}`))

      const result = await store.runGlobalMemoryAgent("manual")
      expect(result.item?.status).toBe("completed")
      const after = fs.readFileSync(profilePath, "utf8")
      const afterIndex = parseMemoryDoc(after, profile)
      expect(afterIndex.sections.find((section) => section.sectionId === "collaboration_style")?.content).not.toContain(misplaced)
      expect(afterIndex.sections.find((section) => section.sectionId === "global_always_apply_rules")?.content).toContain(canonical)
      expect(after.split(canonical).length - 1).toBe(1)
      expect(afterIndex.sections.find((section) => section.sectionId === "evidence_index")?.content).toContain("used_by: global_always_apply_rules, stable_preferences")
      expect(afterIndex.sections.find((section) => section.sectionId === "evidence_index")?.content).not.toContain("used_by: collaboration_style, stable_preferences")
      expect(modelInputs[0]).toContain("Required Global Memory Self-Healing Audit")
      expect(modelInputs[0]).toContain("Mandatory Audit Queue")
      expect(modelInputs[0]).toContain("user_profile.md/collaboration_style")
      expect(modelInputs[0]).toContain("Do not silently leave this queue item unresolved")
      expect(modelInputs[0]).toContain(misplaced)
      const action = handle.sqlite.prepare("SELECT status, patch_json AS patchJson, rationale FROM memory_agent_actions WHERE target_kind = 'user_profile' ORDER BY created_at DESC LIMIT 1").get() as {
        status: string
        patchJson: string
        rationale: string
      }
      expect(action.status).toBe("applied")
      expect(action.rationale).toContain("Hard Rule")
      expect(JSON.parse(action.patchJson).sourceTurnIds).toContain(sourceTurnId)
    } finally {
      await store.close()
    }
  })

  it("leaves ambiguous self-healing entries and cap-blocked moves unchanged", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app, "Memory Self Healing Guardrails")
    const conversation = await createConversation(app, project.id, "Ambiguous Profile Rules")
    const handle = openDatabase(dbPath)
    const duplicate = "Ask before changing files"
    const capBlocked = "- **Cap Blocked Hard Rule**: Explain implementation before editing."
    let callIndex = 0
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return { output: validMemoryAgentJournal({ decisions: ["Left ambiguous and cap-blocked entries unchanged."] }) as TOutput }
      },
      async *stream() {
        callIndex += 1
        if (callIndex === 1) {
          for (const [toolCallId, sourceText, destinationText] of [
            ["memory_move_ambiguous", duplicate, "- **Ask Before Editing**: Ask before changing files."],
            ["memory_move_cap_blocked", capBlocked, "- **Explain Before Editing**: Explain implementation before editing."],
          ] as const) {
            yield {
              type: "model.tool_call.completed",
              toolCall: {
                toolCallId,
                toolName: "edit_files",
                input: {
                  target: "user_profile",
                  editMode: "move",
                  sourceSectionId: "collaboration_style",
                  destinationSectionId: "global_always_apply_rules",
                  sourceText,
                  destinationText,
                  rationale: "Guardrail test with existing profile evidence.",
                },
              },
            }
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "## Investigated\nAudited ambiguous and cap-blocked entries.\n\n## Changed\nNone.\n\n## Skipped\nBoth entries were left unchanged.\n\n## Blocked\nOne ambiguous match and one full rule section." }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      store.runUserProfileTool(project.id, { operation: "read" })
      const profilePath = path.join(socratesHome, "user_profile.md")
      const profile = {
        docType: "user_profile" as const,
        ownerTool: "user_profile" as const,
        scope: "global" as const,
        path: "user_profile.md",
        projectId: "global",
        indexTags: ["profile"],
      }
      const original = fs.readFileSync(profilePath, "utf8")
      const index = parseMemoryDoc(original, profile)
      const sectionBodies = Object.fromEntries(index.sections.map((section) => [section.sectionId, section.content]))
      sectionBodies.global_always_apply_rules = Array.from({ length: 10 }, (_, ruleIndex) => `- **Established Rule ${ruleIndex + 1}**: Keep behavior ${ruleIndex + 1}.`).join("\n")
      sectionBodies.collaboration_style = `${sectionBodies.collaboration_style}\n- **Ambiguous Rule A**: ${duplicate}.\n- **Ambiguous Rule B**: ${duplicate} in every project.\n${capBlocked}`
      const content = buildStructuredMemoryDoc(profile, { sectionBodies })
      fs.writeFileSync(profilePath, content)

      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      for (let turnIndex = 0; turnIndex < 4; turnIndex += 1) {
        const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, `Guardrail evidence ${turnIndex + 1}`, "Review only clear repairs.", nowIso())
        insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: conversation.id, sessionId, turnId: turn.turnId })
      }
      await store.runGlobalMemoryAgent("manual")

      const after = fs.readFileSync(profilePath, "utf8")
      expect(after.split(duplicate).length - 1).toBe(2)
      expect(after).toContain(capBlocked)
      const actions = handle.sqlite.prepare("SELECT status, error FROM memory_agent_actions WHERE target_kind = 'user_profile' ORDER BY created_at").all() as Array<{ status: string; error: string }>
      expect(actions).toHaveLength(2)
      expect(actions.every((action) => action.status === "rejected")).toBe(true)
      expect(actions.map((action) => action.error).join(" ")).toContain("ambiguous")
      expect(actions.map((action) => action.error).join(" ")).toContain("10-rule cap")
    } finally {
      await store.close()
    }
  })

  it("rejects scheduled skill and tool-doc writes while applying scoped profile edits", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Memory Source")
    const handle = openDatabase(dbPath)
    const modelRequests: Array<{ providerId: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: string }> = []
    const evidenceTurnIds: string[] = []
    let memoryCallIndex = 0
    let skillWriteIndex = 0
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return { output: validMemoryAgentJournal() as TOutput }
      },
      async *stream(request) {
        modelRequests.push({
          providerId: request.providerId,
          modelId: request.modelId,
          thinkingEnabled: request.runtimeConfig.thinkingEnabled,
          ...(request.runtimeConfig.thinkingEffort ? { thinkingEffort: request.runtimeConfig.thinkingEffort } : {}),
        })
        const hasSkillWrite = request.tools?.some((tool) => tool.name === "skill_write") ?? false
        const serialized = serializedRequestMessages(request)
        if (hasSkillWrite && evidenceTurnIds.length > 0 && !serialized.includes("memory_skill_writer_trace")) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "memory_skill_writer_trace",
              toolName: "trace_retrieve",
              input: { operation: "inspect", turnId: evidenceTurnIds[0] },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        if (hasSkillWrite && !serialized.includes("memory_skill_writer_write")) {
          skillWriteIndex += 1
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: `memory_skill_writer_write_${skillWriteIndex}`,
              toolName: "skill_write",
              input: {
                scope: "global",
                operation: "create",
                name: "general",
                changeSummary: "Create the approved configured memory worker workflow.",
                evidenceTurnIds: evidenceTurnIds.slice(0, 1),
                content:
                  "---\nname: general\ndescription: Use when preserving configured memory worker workflow guidance.\n---\n\n# General\n\nConfigured memory worker approved this global skill for repeatable evidence-based work.\n\n## Workflow\n\n- Inspect the exact source context before acting.\n- Apply only the approved reusable guidance.\n- Verify the result with a focused check and report the evidence.\n",
              },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        if (hasSkillWrite) {
          yield { type: "model.answer.delta", text: "Created general." }
          yield { type: "model.completed" }
          return
        }
        memoryCallIndex += 1
        if (memoryCallIndex === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "memory_edit_skill",
              toolName: "edit_files",
              input: {
                target: "skill",
                name: "general",
                scope: "global",
                editMode: "create",
                newText: "Create a global skill named general for preserving configured memory worker workflow guidance.",
                rationale: "Test skill creation.",
                sourceTurnIds: evidenceTurnIds.slice(0, 1),
              },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "memory_edit_tool_doc",
              toolName: "edit_files",
              input: {
                target: "tool_doc",
                name: "read_search",
                editMode: "replace",
                oldText: "Use `search` to find candidate files or lines, then `read` the exact files needed for evidence.",
                newText:
                  "Use `search` to find candidate files or lines, then `read` the exact files needed for evidence.\n\nConfigured memory worker can refine global tool guidance.",
                rationale: "Test tool usage update.",
              },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "memory_edit_user_profile",
              toolName: "edit_files",
              input: {
	                target: "user_profile",
	                editMode: "replace",
	                sectionId: "profile_summary",
	                oldText: "- No stable profile facts captured yet.",
	                newText:
	                  "- No stable profile facts captured yet.\n- Configured memory worker can update narrow user profile notes.",
	                rationale: "Test scoped user profile update.",
              },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nInspected configured memory worker test evidence.\n\n## Changed\nUpdated user profile and proposed a skill.\n\n## Skipped\nTool-doc edits are read-only in v1.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      store.updateWorkerModelSettings("skill_writer", {
        providerId: "google",
        modelId: "gemini-3.3-flash-preview",
        thinkingEnabled: false,
      })
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      for (let index = 0; index < 4; index += 1) {
        const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, `Memory user message ${index + 1}`, "Memory assistant answer", nowIso())
        evidenceTurnIds.push(turn.turnId)
        insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: conversation.id, sessionId, turnId: turn.turnId })
      }
      await store.runGlobalMemoryAgent("manual")
      const usefulPatternFile = path.join(socratesHome, "skills", "general", "SKILL.md")
      const toolUsageFile = path.join(socratesHome, "tool_usage", "read_search.md")
      const userProfileFile = path.join(socratesHome, "user_profile.md")
      await waitForFileText(userProfileFile, "Configured memory worker can update narrow user profile notes")
      const toolUsageContent = fs.readFileSync(toolUsageFile, "utf8")
      expectStructuredToolDoc(socratesHome, "read_search.md")
      expect(toolUsageContent).not.toContain("Configured memory worker can refine global tool guidance")
      expect(toolUsageContent).not.toContain("Legacy Content")
      expect(toolUsageContent).not.toContain("What this tool guidance is for.")
      expect(fs.existsSync(usefulPatternFile)).toBe(false)
      const proposedSkill = handle.sqlite.prepare("SELECT id, status, metadata_json AS metadataJson FROM memory_agent_actions WHERE target_kind = 'skill_request'").get() as { id: string; status: string; metadataJson: string }
      expect(proposedSkill.status).toBe("proposed")
      expect(JSON.parse(proposedSkill.metadataJson)).toMatchObject({ scope: "global", operation: "create", skillName: "general" })
      const notification = handle.sqlite.prepare("SELECT type, payload_json AS payloadJson FROM notifications WHERE type = 'memory.skill.proposed'").get() as { type: string; payloadJson: string }
      expect(notification.type).toBe("memory.skill.proposed")
      expect(JSON.parse(notification.payloadJson)).toMatchObject({ actionId: proposedSkill.id, skillName: "general" })
      const toolDocActions = handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_agent_actions WHERE target_kind = 'tool_usage'").get() as { count: number }
      expect(toolDocActions.count).toBe(0)
      const failedToolDocCall = handle.sqlite.prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'tool.call.failed' AND payload_json LIKE '%memory_edit_tool_doc%'").get() as { count: number }
      expect(failedToolDocCall.count).toBeGreaterThan(0)
      const profileAction = handle.sqlite.prepare("SELECT status FROM memory_agent_actions WHERE target_kind = 'user_profile'").get() as { status: string }
      expect(profileAction.status).toBe("applied")
      const profileSection = handle.sqlite.prepare("SELECT section_id AS sectionId FROM memory_doc_sections WHERE path = 'user_profile.md' AND section_id = 'profile_summary'").get() as { sectionId: string }
      expect(profileSection.sectionId).toBe("profile_summary")
      expect(modelRequests[0]).toEqual({ providerId: "openrouter", modelId: "xiaomi/mimo-v2.5-pro", thinkingEnabled: false })
      expect(fs.existsSync(path.join(socratesHome, "projects", project.id, "diary"))).toBe(false)
      expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"))).toBe(true)
      const approved = await store.approveMemorySkillProposal(proposedSkill.id)
      expect(approved.skill).toMatchObject({ name: "general", scope: "global" })
      expect(fs.readFileSync(usefulPatternFile, "utf8")).toContain("Configured memory worker approved this global skill")
      expect(modelRequests).toContainEqual({ providerId: "google", modelId: "gemini-3.3-flash-preview", thinkingEnabled: false })
      const appliedSkill = handle.sqlite.prepare("SELECT status FROM memory_agent_actions WHERE id = ?").get(proposedSkill.id) as { status: string }
      expect(appliedSkill.status).toBe("applied")
      const approvedNotification = store.listNotifications({ limit: 10 }).notifications.find((item) => item.type === "memory.skill.proposed")
      expect(approvedNotification?.readAt).toBeDefined()
      expect(approvedNotification?.payload).toMatchObject({
        actionId: proposedSkill.id,
        actionStatus: "applied",
        proposalStatus: "approved",
        skillExists: true,
      })
      const skillWriterJob = handle.sqlite.prepare("SELECT status, skill_name AS skillName FROM skill_writer_jobs WHERE source_id = ?").get(proposedSkill.id) as { status: string; skillName: string }
      expect(skillWriterJob).toEqual({ status: "completed", skillName: "general" })
    } finally {
      await store.close()
    }
  })

  it("rejects pending memory skill proposals and reports stale proposal status in notifications", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath, createTestAgent(), { socratesHome })
    const handle = openDatabase(dbPath)
    try {
      const now = nowIso()
      const actionId = createId("memact")
      const notificationId = createId("note")
      const targetPath = path.join(socratesHome, "skills", "reject-me", "SKILL.md")
      handle.sqlite
        .prepare(
          `INSERT INTO memory_agent_actions (
            id, job_id, project_id, target_kind, target_path, status, requires_confirmation, patch_json, created_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          actionId,
          createId("memjob"),
          "global",
          "skill_request",
          targetPath,
          "proposed",
          0,
          JSON.stringify({ oldText: "", newText: "Create a test skill." }),
          now,
          JSON.stringify({ scope: "global", operation: "create", skillName: "reject-me" }),
        )
      handle.sqlite
        .prepare(
          `INSERT INTO notifications (
            id, type, title, body, severity, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          notificationId,
          "memory.skill.proposed",
          "Socrates proposed a new skill",
          "Reject me.",
          "info",
          JSON.stringify({ actionId, scope: "global", operation: "create", skillName: "reject-me" }),
          now,
        )

      const pending = await app.inject({ method: "GET", url: "/api/notifications" })
      expect(pending.statusCode).toBe(200)
      expect(JSON.parse(pending.body).data.notifications[0].payload).toMatchObject({
        actionId,
        proposalStatus: "pending",
        actionStatus: "proposed",
      })

      const rejected = await app.inject({ method: "POST", url: `/api/memory-agent/skill-proposals/${actionId}/reject` })
      expect(rejected.statusCode).toBe(200)
      expect(JSON.parse(rejected.body).data).toEqual({ actionId, status: "rejected" })
      const rejectedAction = handle.sqlite.prepare("SELECT status, error FROM memory_agent_actions WHERE id = ?").get(actionId) as { status: string; error: string }
      expect(rejectedAction).toEqual({ status: "rejected", error: "Rejected by user." })
      const readNotification = handle.sqlite.prepare("SELECT read_at AS readAt FROM notifications WHERE id = ?").get(notificationId) as { readAt: string | null }
      expect(readNotification.readAt).toBeTruthy()
      const rejectedList = await app.inject({ method: "GET", url: "/api/notifications" })
      expect(JSON.parse(rejectedList.body).data.notifications[0].payload).toMatchObject({
        actionId,
        proposalStatus: "rejected",
        actionStatus: "rejected",
      })

      const deletedActionId = createId("memact")
      const deletedNotificationId = createId("note")
      handle.sqlite
        .prepare(
          `INSERT INTO memory_agent_actions (
            id, job_id, project_id, target_kind, target_path, status, requires_confirmation, patch_json, created_at, applied_at, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deletedActionId,
          createId("memjob"),
          "global",
          "skill_request",
          path.join(socratesHome, "skills", "deleted-skill", "SKILL.md"),
          "applied",
          0,
          JSON.stringify({ oldText: "", newText: "Create a deleted skill." }),
          nowIso(),
          nowIso(),
          JSON.stringify({ scope: "global", operation: "create", skillName: "deleted-skill" }),
        )
      handle.sqlite
        .prepare(
          `INSERT INTO notifications (
            id, type, title, body, severity, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          deletedNotificationId,
          "memory.skill.proposed",
          "Socrates proposed a new skill",
          "Deleted skill.",
          "info",
          JSON.stringify({ actionId: deletedActionId, scope: "global", operation: "create", skillName: "deleted-skill" }),
          nowIso(),
        )
      const stale = await app.inject({ method: "GET", url: "/api/notifications" })
      expect(JSON.parse(stale.body).data.notifications[0].payload).toMatchObject({
        actionId: deletedActionId,
        proposalStatus: "deleted",
        actionStatus: "applied",
        skillExists: false,
      })
    } finally {
      handle.close()
    }
  })

  it("runs the backend memory worker through the Socrates agent loop with trace retrieval", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const sourceConversation = await createConversation(app, project.id, "Trace Evidence Source")
    const memoryConversation = await createConversation(app, project.id, "Memory Worker Source")
    const handle = openDatabase(dbPath)
    const requests: Array<{ providerId: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: string; system?: string; tools?: unknown; messages: unknown[] }> = []
    let callIndex = 0
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return { output: validMemoryAgentJournal() as TOutput }
      },
      async *stream(request) {
        requests.push({
          providerId: request.providerId,
          modelId: request.modelId,
          thinkingEnabled: request.runtimeConfig.thinkingEnabled,
          ...(request.runtimeConfig.thinkingEffort ? { thinkingEffort: request.runtimeConfig.thinkingEffort } : {}),
          system: request.system,
          tools: request.tools,
          messages: request.messages,
        })
        callIndex += 1
        if (callIndex === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "trace_memory_worker_1",
              toolName: "trace_retrieve",
              input: {
                operation: "search",
                mode: "exact",
                projectId: project.id,
                query: "memory-agent trace marker",
                limit: 5,
              },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nUsed trace retrieval for the memory-agent trace marker.\n\n## Changed\nNone.\n\n## Skipped\nNo durable update.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      store.updateMemoryAgentSettings({
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: true,
        thinkingEffort: "low",
      })
      const sourceSessionId = insertTestSession(handle.sqlite, project.id, sourceConversation.id)
      const sourceTurn = insertCompletedTestTurn(
        handle.sqlite,
        sourceConversation.id,
        sourceSessionId,
        "Please remember this.",
        "Durable memory-agent trace marker from a prior conversation.",
        new Date(Date.now() - 5_000).toISOString(),
      )
      store.indexTurnTraceDocuments(project.id, sourceConversation.id, sourceTurn.turnId)

      const memorySessionId = insertTestSession(handle.sqlite, project.id, memoryConversation.id)
      for (let index = 0; index < 4; index += 1) {
        const memoryTurn = insertCompletedTestTurn(handle.sqlite, memoryConversation.id, memorySessionId, `Memory worker should investigate ${index + 1}.`, "Queued.", nowIso())
        insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: memoryConversation.id, sessionId: memorySessionId, turnId: memoryTurn.turnId })
      }

      const result = await store.runGlobalMemoryAgent("manual")
      expect(result.item?.status).toBe("completed")
      const job = handle.sqlite.prepare("SELECT status FROM memory_agent_jobs ORDER BY started_at DESC LIMIT 1").get() as { status: string }
      expect(job.status).toBe("completed")
      expect(requests[0]).toMatchObject({
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: true,
        thinkingEffort: "low",
      })
      const toolNames = ((requests[0]?.tools as Array<{ name: string }> | undefined) ?? []).map((tool) => tool.name)
      expect(requests[0]?.system).toContain("You are the Socrates Global Memory Agent")
      expect(requests[0]?.system).toContain("edit_files: the only write tool")
      expect(toolNames).toEqual(expect.arrayContaining(["trace_retrieve", "projects", "tool_docs", "skills", "memory_notes", "soul", "user_profile", "edit_files"]))
      expect(toolNames).not.toContain("bash")
      expect(toolNames).not.toContain("edit")
      expect(JSON.stringify(requests[1]?.messages)).toContain("memory-agent trace marker")
    } finally {
      await store.close()
    }
  })

  it("compacts backend memory-agent context with the memory compressor at 170k", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const sourceConversation = await createConversation(app, project.id, "Memory Compression Trace Source")
    const memoryConversation = await createConversation(app, project.id, "Memory Compression Worker Source")
    const handle = openDatabase(dbPath)
    const streamRequests: Array<{ messages: unknown[] }> = []
    const structuredSystems: string[] = []
    let callIndex = 0
    const memoryProvider: ModelProvider = {
      countTokens: async (request) => {
        const hasMemoryCompaction = hasMemoryCompactionMessage(request.messages)
        const hasToolResult = hasToolResultPart(request.messages)
        const inputTokens = hasMemoryCompaction
          ? 60_000
          : hasToolResult
            ? 170_000
            : 100
        return {
          providerId: request.providerId,
          modelId: request.modelId,
          inputTokens,
          baseTokens: inputTokens,
          method: "local_tiktoken",
          safetyMarginPercent: 0,
        }
      },
      async generateStructured<TOutput>(request: StructuredModelRequest<TOutput>): Promise<StructuredModelResult<TOutput>> {
        structuredSystems.push(request.system)
        if (!request.system.includes("Socrates Memory Agent Compressor")) {
          return { output: validMemoryAgentJournal() as TOutput }
        }
        return {
          output: validServerMemoryCompaction({
            manifestScope: ["Covered memory-agent context after trace retrieval."],
            toolState: ["Compacted after the memory-agent context crossed 170k estimated tokens."],
          }) as TOutput,
        }
      },
      async *stream(request) {
        streamRequests.push({ messages: request.messages })
        callIndex += 1
        if (callIndex === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "trace_memory_compression_1",
              toolName: "trace_retrieve",
              input: {
                operation: "search",
                mode: "exact",
                projectId: project.id,
                query: "memory compression trace marker",
                limit: 5,
              },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nUsed compacted memory-agent context.\n\n## Changed\nNone.\n\n## Skipped\nNo durable update.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      const sourceSessionId = insertTestSession(handle.sqlite, project.id, sourceConversation.id)
      const sourceTurn = insertCompletedTestTurn(
        handle.sqlite,
        sourceConversation.id,
        sourceSessionId,
        "Please remember this compression marker.",
        "Durable memory compression trace marker from a prior conversation.",
        new Date(Date.now() - 5_000).toISOString(),
      )
      store.indexTurnTraceDocuments(project.id, sourceConversation.id, sourceTurn.turnId)

      const memorySessionId = insertTestSession(handle.sqlite, project.id, memoryConversation.id)
      for (let index = 0; index < 4; index += 1) {
        const memoryTurn = insertCompletedTestTurn(handle.sqlite, memoryConversation.id, memorySessionId, `Memory compression should investigate ${index + 1}.`, "Queued.", nowIso())
        insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: memoryConversation.id, sessionId: memorySessionId, turnId: memoryTurn.turnId })
      }

      const result = await store.runGlobalMemoryAgent("manual")
      expect(result.item?.status).toBe("completed")
      expect(structuredSystems.some((system) => system.includes("Socrates Memory Agent Compressor"))).toBe(true)
      expect(streamRequests).toHaveLength(2)
      expect(JSON.stringify(streamRequests[1]?.messages)).toContain("socrates_internal_memory_context_compaction")
      expect(JSON.stringify(streamRequests[1]?.messages)).toContain("Covered memory-agent context after trace retrieval.")
    } finally {
      await store.close()
    }
  })

  it("packs global memory-agent evidence one turn at a time and stops at 80 turns", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Memory Packing Source")
    const handle = openDatabase(dbPath)
    const evidencePrompts: string[] = []
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return { output: validMemoryAgentJournal() as TOutput }
      },
      async *stream(request) {
        evidencePrompts.push(String(request.messages[0]?.content ?? ""))
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nPacked memory evidence.\n\n## Changed\nNone.\n\n## Skipped\nNone.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const sequences: number[] = []
      for (let index = 0; index < 85; index += 1) {
        const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, `Pack memory turn ${index + 1}`, "Done.", nowIso())
        sequences.push(insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: conversation.id, sessionId, turnId: turn.turnId }))
      }

      const result = await store.runGlobalMemoryAgent("manual")
      const evidence = evidencePrompts[0] ?? ""
      expect(result.state.lastProcessedEventSequence).toBe(sequences[79])
      expect(evidence).toContain("Included turn count: 80")
      expect(evidence).toContain(`event sequence ${sequences[79]}`)
      expect(evidence).not.toContain(`event sequence ${sequences[80]}`)
    } finally {
      await store.close()
    }
  })

  it("stops global memory-agent evidence before the 60k token cap and advances only to the included sequence", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Memory Token Packing Source")
    const handle = openDatabase(dbPath)
    const evidencePrompts: string[] = []
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return { output: validMemoryAgentJournal() as TOutput }
      },
      async *stream(request) {
        evidencePrompts.push(String(request.messages[0]?.content ?? ""))
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nPacked memory evidence under token cap.\n\n## Changed\nNone.\n\n## Skipped\nNone.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      const largeProjectName = Array.from({ length: 1_600 }, (_, index) => `manifest_token_${index}`).join(" ")
      handle.sqlite.prepare("UPDATE projects SET name = ? WHERE id = ?").run(`Huge Project ${largeProjectName}`, project.id)
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const sequences: number[] = []
      for (let index = 0; index < 40; index += 1) {
        const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, `Token-capped memory turn ${index + 1}`, "Done.", nowIso())
        sequences.push(insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: conversation.id, sessionId, turnId: turn.turnId }))
      }

      const result = await store.runGlobalMemoryAgent("manual")
      const evidence = evidencePrompts[0] ?? ""
      const included = Number(evidence.match(/Included turn count: (\d+)/)?.[1] ?? "0")
      const job = handle.sqlite
        .prepare("SELECT evidence_tokens_estimate AS evidenceTokensEstimate FROM memory_agent_jobs ORDER BY started_at DESC LIMIT 1")
        .get() as { evidenceTokensEstimate: number }
      expect(included).toBeGreaterThan(0)
      expect(included).toBeLessThan(40)
      expect(job.evidenceTokensEstimate).toBeLessThanOrEqual(60_000)
      expect(result.state.lastProcessedEventSequence).toBe(sequences[included - 1])
      expect(evidence).not.toContain(`event sequence ${sequences[included]}`)
    } finally {
      await store.close()
    }
  })

  it("confirms soul updates internally before applying them and creates a notification", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Soul Source")
    const handle = openDatabase(dbPath)
    const seenPrompts: string[] = []
    let callIndex = 0
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured<TOutput>(): Promise<StructuredModelResult<TOutput>> {
        return { output: validMemoryAgentJournal({ decisions: ["Applied the confirmed identity update."] }) as TOutput }
      },
      async *stream(request) {
        seenPrompts.push(`${request.system}\n\n${request.messages.map((message) => message.content).join("\n")}`)
        callIndex += 1
        if (callIndex === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "memory_edit_soul",
              toolName: "edit_files",
              input: {
                target: "identity",
                editMode: "replace",
                oldText: "Socrates is a local-first project partner.",
                newText: "Socrates is a local-first project partner with evidence-backed memory.",
                rationale: "The backend memory-agent flow is now a durable identity capability.",
                sourceTurnIds: [],
              },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        if (callIndex === 2) {
          yield { type: "model.answer.delta", text: "yes" }
          yield { type: "model.completed" }
          return
        }
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nInspected soul update evidence.\n\n## Changed\nUpdated identity.\n\n## Skipped\nNone.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      for (let index = 0; index < 4; index += 1) {
        const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, `Update soul carefully ${index + 1}`, "I will use the backend memory agent.", nowIso())
        insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: conversation.id, sessionId, turnId: turn.turnId })
      }
      await store.runGlobalMemoryAgent("manual")
      const identityPath = path.join(socratesHome, "identity.md")
      await waitForFileText(identityPath, "evidence-backed memory")
      const confirmation = handle.sqlite.prepare("SELECT decision, response_text FROM memory_agent_confirmations").get() as {
        decision: string
        response_text: string
      }
      expect(confirmation.decision).toBe("yes")
      expect(confirmation.response_text).toBe("yes")
      const action = handle.sqlite.prepare("SELECT status, target_kind FROM memory_agent_actions").get() as { status: string; target_kind: string }
      expect(action).toMatchObject({ status: "applied", target_kind: "soul" })
      const notifications = store.listNotifications()
      expect(notifications.unreadCount).toBe(1)
      expect(notifications.notifications[0]?.type).toBe("memory.soul.updated")
      expect(JSON.stringify(notifications.notifications[0]?.payload)).toContain("evidence-backed memory")
      expect(seenPrompts[0]).toContain("strict structured journal object enforced by the runtime")
      expect(seenPrompts[1]).toContain("You are about to make changes to the soul. Are you sure?")
    } finally {
      await store.close()
    }
  })

  it("marks secondary attachment mentions so deleted-source provenance is not invented", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const source = await createConversation(app, project.id, "trace retrieve recap")
    const live = await createConversation(app, project.id, "deleted screenshot lookup")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle)
    try {
      const sourceSession = insertTestSession(handle.sqlite, project.id, source.id)
      const recap = insertCompletedTestTurn(
        handle.sqlite,
        source.id,
        sourceSession,
        "Please continue.",
        "I found traces from a previous conversation was titled \"The\" and screenshots you shared previously, including Screenshot 2026-05-31 at 1.16.46 PM.png.",
        new Date(Date.now() - 3_000).toISOString(),
      )
      store.indexTurnTraceDocuments(project.id, source.id, recap.turnId)

      const search = await store.retrieveToolTraces(project.id, live.id, {
        query: "Screenshot 2026-05-31",
        scope: "project",
        mode: "exact",
        limit: 10,
      })

      expect(search.results.length).toBeGreaterThan(0)
      expect(search.results[0]?.entryType).toBe("assistant_response")
      expect(search.results[0]?.provenanceKind).toBe("secondary_mention")
      expect(search.warnings?.join(" ")).toContain("Only secondary mentions")
      expect(search.warnings?.join(" ")).toContain("No original visible message attachment provenance")
    } finally {
      await store.close()
    }
  })

  it("uses LanceDB semantic and combined retrieval over canonical Q&A parents", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Semantic Source")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, createTestEmbeddingProvider(), undefined, { socratesHome: tempDir() })
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
      await store.configureProjectEmbeddings(project.id, {
        providerId: "ollama",
        modelId: "embeddinggemma",
        credentialSource: "none",
      })
      const status = await waitForProjectEmbeddingStatus(store, project.id, (candidate) => candidate.retrieval.vectorReady)
      expect(status.retrieval.qaParents).toBe(2)
      expect(status.retrieval.qaChunks).toBeGreaterThanOrEqual(4)
      expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM trace_embeddings").get()).toEqual({ count: 0 })

      const semantic = await store.retrieveMainToolTraces(project.id, conversation.id, {
        query: "BLUE-LANTERN-42",
        mode: "semantic",
        scope: "current_conversation",
      })
      expect(semantic.results[0]?.turnId).toBe(target.turnId)
      expect(semantic.results[0]?.matchedRole).toBe("user")

      const combined = await store.retrieveMainToolTraces(project.id, conversation.id, {
        query: "fuzzy blue memory",
        mode: "combined",
        scope: "current_conversation",
      })
      expect(combined.results[0]?.turnId).toBe(target.turnId)
      const runs = handle.sqlite.prepare("SELECT mode, corpus_kind AS corpusKind, status FROM retrieval_runs ORDER BY created_at").all() as Array<{ mode: string; corpusKind: string; status: string }>
      expect(runs).toEqual(expect.arrayContaining([
        expect.objectContaining({ mode: "semantic", corpusKind: "trace_turn", status: "completed" }),
        expect.objectContaining({ mode: "combined", corpusKind: "trace_turn", status: "completed" }),
      ]))
    } finally {
      await store.close()
    }
  })

  it("uses one clean retrieval contract globally with cross-project scope as the only difference", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project: projectA } = await createProject(app, "Global Trace Alpha")
    const { project: projectB } = await createProject(app, "Global Trace Beta")
    const conversationA = await createConversation(app, projectA.id, "Alpha Evidence")
    const conversationB = await createConversation(app, projectB.id, "Beta Evidence")
    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, createTestEmbeddingProvider(), undefined, { socratesHome })
    try {
      const sessionA = insertTestSession(handle.sqlite, projectA.id, conversationA.id)
      const sessionB = insertTestSession(handle.sqlite, projectB.id, conversationB.id)
      const alpha = insertCompletedTestTurn(
        handle.sqlite,
        conversationA.id,
        sessionA,
        "GLOBALALPHA77 is the blue-lantern-42 retrieval evidence.",
        "Alpha evidence recorded.",
        new Date(Date.now() - 2_000).toISOString(),
      )
      const beta = insertCompletedTestTurn(
        handle.sqlite,
        conversationB.id,
        sessionB,
        "GLOBALBETA88 is separate project evidence.",
        "Beta evidence recorded.",
        new Date(Date.now() - 1_000).toISOString(),
      )
      const now = nowIso()
      handle.sqlite
        .prepare(
          `INSERT INTO tool_calls (
            id, conversation_id, session_id, turn_id, tool_name, status, arguments_json, result_json,
            requires_approval, started_at, completed_at
          ) VALUES (?, ?, ?, ?, 'read', 'completed', ?, ?, 0, ?, ?)`,
        )
        .run(
          createId("tcall"),
          conversationB.id,
          sessionB,
          beta.turnId,
          JSON.stringify({ path: "GLOBALAUDIT88.txt" }),
          JSON.stringify({ path: "GLOBALAUDIT88.txt", kind: "file" }),
          now,
          now,
        )
      store.indexTurnTraceDocuments(projectA.id, conversationA.id, alpha.turnId)
      store.indexTurnTraceDocuments(projectB.id, conversationB.id, beta.turnId)
      for (const projectId of [projectA.id, projectB.id]) {
        await store.configureProjectEmbeddings(projectId, {
          providerId: "ollama",
          modelId: "embeddinggemma",
          credentialSource: "none",
        })
        await waitForProjectEmbeddingStatus(store, projectId, (candidate) => candidate.retrieval.vectorReady)
      }

      const lexical = await store.retrieveGlobalToolTraces({ mode: "lexical", query: "GLOBALALPHA77" })
      expect(lexical.results).toHaveLength(1)
      expect(lexical.results[0]).toEqual(expect.objectContaining({
        projectTitle: "Global Trace Alpha",
        conversationTitle: "Alpha Evidence",
        turnId: alpha.turnId,
        matchedRole: "user",
      }))
      expect(lexical.results[0]).not.toHaveProperty("projectId")
      expect(lexical.results[0]).not.toHaveProperty("entryType")
      expect(lexical.results[0]).not.toHaveProperty("handle")

      const inspected = await store.retrieveGlobalToolTraces({ operation: "inspect", resultNumber: 1 })
      expect(inspected.results[0]?.content).toContain("User:\nGLOBALALPHA77")
      expect(inspected.results[0]?.content).toContain("Assistant:\nAlpha evidence recorded.")

      const isolated = await store.retrieveGlobalToolTraces({
        mode: "lexical",
        query: "GLOBALALPHA77",
        scope: "project",
        projectId: projectB.id,
      })
      expect(isolated.results).toHaveLength(0)

      const semantic = await store.retrieveGlobalToolTraces({ mode: "semantic", query: "fuzzy blue memory" })
      expect(semantic.results[0]?.turnId).toBe(alpha.turnId)
      const combined = await store.retrieveGlobalToolTraces({ mode: "combined", query: "GLOBALALPHA77" })
      expect(combined.results[0]?.turnId).toBe(alpha.turnId)

      const audit = await store.retrieveGlobalToolTraces({ mode: "audit", query: "GLOBALAUDIT88", include: ["tool_calls"] })
      expect(audit.results[0]).toEqual(expect.objectContaining({ projectTitle: "Global Trace Beta", turnId: beta.turnId }))
      expect(audit.results[0]?.content).toContain("GLOBALAUDIT88.txt")
      expect(audit.results).toHaveLength(1)
    } finally {
      await store.close()
    }
  })

  it("recalls turns beyond the former 200-document window while preserving project isolation", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project: projectA } = await createProject(app, "Long Recall A")
    const { project: projectB } = await createProject(app, "Long Recall B")
    const conversationA = await createConversation(app, projectA.id, "Long Recall Source")
    const conversationB = await createConversation(app, projectB.id, "Isolation Source")
    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, createTestEmbeddingProvider(), undefined, { socratesHome })
    try {
      const sessionA = insertTestSession(handle.sqlite, projectA.id, conversationA.id)
      const oldest = insertCompletedTestTurn(
        handle.sqlite,
        conversationA.id,
        sessionA,
        "The oldest durable key is BLUE-LANTERN-42 and must remain fully retrievable.",
        "Recorded in the first turn.",
        new Date(Date.now() - 500_000).toISOString(),
      )
      for (let index = 0; index < 220; index += 1) {
        insertCompletedTestTurn(
          handle.sqlite,
          conversationA.id,
          sessionA,
          `Ordinary later turn ${index + 1}.`,
          `Ordinary later answer ${index + 1}.`,
          new Date(Date.now() - 400_000 + index * 1_000).toISOString(),
        )
      }
      const sessionB = insertTestSession(handle.sqlite, projectB.id, conversationB.id)
      const isolated = insertCompletedTestTurn(
        handle.sqlite,
        conversationB.id,
        sessionB,
        "BLUE-LANTERN-42 exists in another project too.",
        "This turn must stay isolated.",
        nowIso(),
      )

      await store.configureProjectEmbeddings(projectA.id, { providerId: "ollama", modelId: "embeddinggemma", credentialSource: "none" })
      await store.waitForRetrievalIdle(projectA.id)
      const semantic = await store.retrieveMainToolTraces(projectA.id, conversationA.id, { mode: "semantic", query: "BLUE-LANTERN-42", scope: "project", limit: 8 })
      expect(semantic.results[0]?.turnId).toBe(oldest.turnId)
      expect(semantic.results.map((result) => result.turnId)).not.toContain(isolated.turnId)
      expect(semantic.results.length).toBeLessThanOrEqual(8)
      const status = store.getProjectEmbeddingStatus(projectA.id)
      expect(status.retrieval.qaParents).toBe(221)
    } finally {
      await store.close()
    }
  })

  it("re-embeds only changed memory sections and removes retired documents from recall", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app, "Memory Retrieval Index")
    let embeddedValues = 0
    const provider: EmbeddingProvider = {
      async check() {
        return { ok: true, dimensions: 3, message: "Test embeddings are reachable." }
      },
      async embed(request) {
        return { embeddings: [testEmbeddingVector(request.value)], dimensions: 3 }
      },
      async embedMany(request) {
        embeddedValues += request.values.length
        return { embeddings: request.values.map(testEmbeddingVector), dimensions: 3 }
      },
    }
    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, provider, undefined, { socratesHome })
    try {
      store.ensureProjectMemory(project.id)
      await store.configureProjectEmbeddings(project.id, { providerId: "ollama", modelId: "embeddinggemma", credentialSource: "none" })
      await store.waitForRetrievalIdle(project.id)
      const baselineEmbeddedValues = embeddedValues

      const profilePath = path.join(socratesHome, "user_profile.md")
      const profile = {
        docType: "user_profile" as const,
        ownerTool: "user_profile" as const,
        scope: "global" as const,
        path: "user_profile.md",
        projectId: "global",
        indexTags: ["profile"],
      }
      const before = fs.readFileSync(profilePath, "utf8")
      const collaboration = parseMemoryDoc(before, profile).sections.find((section) => section.sectionId === "collaboration_style")!
      fs.writeFileSync(profilePath, patchMemoryDocSection(before, profile, "collaboration_style", collaboration.content, `${collaboration.content}\n- Slow mode means discuss the plan before implementation.`))
      store.runUserProfileTool(project.id, { operation: "read_section", sectionId: "collaboration_style" })
      await store.waitForRetrievalIdle(project.id)
      expect(embeddedValues - baselineEmbeddedValues).toBe(1)
      const recalled = await store.searchMemory(project.id, { query: "slow mode", mode: "combined", scope: "global", limit: 8 })
      expect(recalled.results[0]).toMatchObject({ fileName: "user_profile.md", sectionId: "collaboration_style" })

      const now = nowIso()
      const staleIndexId = createId("mdoc")
      handle.sqlite.prepare(
        `INSERT INTO memory_doc_indexes
          (id, scope, project_id, path, doc_type, owner_tool, schema_version, content_hash, section_count, indexed_at, metadata_json)
         VALUES (?, 'global', 'global', 'operating_principles.md', 'identity', 'soul', 1, 'stale-hash', 1, ?, '{}')`,
      ).run(staleIndexId, now)
      handle.sqlite.prepare(
        `INSERT INTO memory_doc_sections
          (id, doc_index_id, scope, project_id, path, doc_type, section_id, kind, tags_json, heading, line_start, line_end, content, content_hash, summary, token_estimate, updated_at, metadata_json)
         VALUES (?, ?, 'global', 'global', 'operating_principles.md', 'identity', 'operating_principles', 'principles', '[]', 'Operating Principles', 1, 2, 'RETIRED-MEMORY-MARKER', 'stale-section-hash', 'retired marker', 4, ?, '{}')`,
      ).run(createId("mdsec"), staleIndexId, now)
      store.reindexProjectEmbeddings(project.id)
      await store.waitForRetrievalIdle(project.id)
      expect((await store.searchMemory(project.id, { query: "RETIRED-MEMORY-MARKER", mode: "lexical", scope: "global", limit: 8 })).results.length).toBeGreaterThan(0)

      store.ensureProjectMemory(project.id)
      await store.waitForRetrievalIdle(project.id)
      expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_doc_indexes WHERE path = 'operating_principles.md'").get()).toEqual({ count: 0 })
      const afterRetiredSearch = await store.searchMemory(project.id, { query: "RETIRED-MEMORY-MARKER", mode: "lexical", scope: "global", limit: 8 })
      expect(
        afterRetiredSearch.results,
        JSON.stringify({ status: store.getProjectEmbeddingStatus(project.id), afterRetiredSearch }),
      ).toHaveLength(0)
    } finally {
      await store.close()
    }
  })

  it("rebuilds one active LanceDB embedding space when configuration changes", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Embedding Switch")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, createTestEmbeddingProvider(), undefined, { socratesHome: tempDir() })
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, "Switch this project from OpenAI.", "Index with Ollama.", nowIso())
      store.indexTurnTraceDocuments(project.id, conversation.id, turn.turnId)

      await store.configureProjectEmbeddings(project.id, {
        providerId: "ollama",
        modelId: "old-local",
        credentialSource: "none",
      })
      const oldReady = await waitForProjectEmbeddingStatus(store, project.id, (status) => status.modelId === "old-local" && status.retrieval.vectorReady)
      const oldState = handle.sqlite.prepare("SELECT table_name AS tableName, embedding_fingerprint AS fingerprint FROM retrieval_index_states WHERE project_id = ?").get(project.id) as { tableName: string; fingerprint: string }
      expect(oldReady.retrieval.qaParents).toBe(1)

      await store.configureProjectEmbeddings(project.id, {
        providerId: "ollama",
        modelId: "new-local",
        credentialSource: "none",
      })
      const completed = await waitForProjectEmbeddingStatus(store, project.id, (status) => status.modelId === "new-local" && status.retrieval.vectorReady)
      const newState = handle.sqlite.prepare("SELECT table_name AS tableName, embedding_fingerprint AS fingerprint FROM retrieval_index_states WHERE project_id = ?").get(project.id) as { tableName: string; fingerprint: string }
      expect(completed.retrieval.qaParents).toBe(1)
      expect(newState.fingerprint).not.toBe(oldState.fingerprint)
      expect(newState.tableName).not.toBe(oldState.tableName)
      expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM trace_embeddings").get()).toEqual({ count: 0 })
    } finally {
      await store.close()
    }
  })

  it("does not leave a deactivated in-flight LanceDB generation active", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Embedding Switch Race")

    let resolveOldStarted!: () => void
    let releaseOldBatch!: () => void
    const oldStarted = new Promise<void>((resolve) => {
      resolveOldStarted = resolve
    })
    const oldBatchReleased = new Promise<void>((resolve) => {
      releaseOldBatch = resolve
    })
    const provider: EmbeddingProvider = {
      async check() {
        return { ok: true, dimensions: 3, message: "Test embeddings are reachable." }
      },
      async embed(request) {
        return { embeddings: [testEmbeddingVector(request.value)], dimensions: 3 }
      },
      async embedMany(request) {
        if (request.modelId === "old-local") {
          resolveOldStarted()
          await oldBatchReleased
        }
        return { embeddings: request.values.map(testEmbeddingVector), dimensions: 3 }
      },
    }

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, provider, undefined, { socratesHome: tempDir() })
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, "Old batch should not land.", "New index wins.", nowIso())
      store.indexTurnTraceDocuments(project.id, conversation.id, turn.turnId)
      await store.configureProjectEmbeddings(project.id, {
        providerId: "ollama",
        modelId: "old-local",
        credentialSource: "none",
      })
      await oldStarted

      await store.configureProjectEmbeddings(project.id, {
        providerId: "ollama",
        modelId: "new-local",
        credentialSource: "none",
      })
      releaseOldBatch()

      const completed = await waitForProjectEmbeddingStatus(
        store,
        project.id,
        (status) => status.modelId === "new-local" && status.retrieval.vectorReady,
      )
      expect(completed.retrieval.qaParents).toBe(1)
      const activeConfig = handle.sqlite.prepare("SELECT model_id AS modelId FROM project_embedding_configs WHERE project_id = ? AND active = 1").get(project.id) as { modelId: string }
      expect(activeConfig.modelId).toBe("new-local")
      const state = handle.sqlite.prepare("SELECT status, table_name AS tableName FROM retrieval_index_states WHERE project_id = ?").get(project.id) as { status: string; tableName: string }
      expect(state.status).toBe("ready")
      expect(state.tableName).toMatch(/^project_[a-f0-9]{16}_/)
      expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM trace_embeddings").get()).toEqual({ count: 0 })
    } finally {
      releaseOldBatch()
      await store.close()
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

  it("lists Ollama embedding models and recommendations through HTTP without pulling models", async () => {
    let pullCalled = false
    const provider: EmbeddingProvider = {
      async check() {
        return { ok: true, dimensions: 3, message: "Test embeddings are reachable." }
      },
      async embed(request) {
        return { embeddings: [testEmbeddingVector(request.value)], dimensions: 3 }
      },
      async embedMany(request) {
        return { embeddings: request.values.map(testEmbeddingVector), dimensions: 3 }
      },
      async listModels() {
        return {
          models: [
            {
              modelId: "embeddinggemma:latest",
              name: "embeddinggemma:latest",
              status: "embedding",
              embeddingCapable: true,
              sizeBytes: 623000000,
              capabilities: ["embedding"],
            },
            {
              modelId: "glm-ocr:latest",
              name: "glm-ocr:latest",
              status: "not_embedding",
              embeddingCapable: false,
              capabilities: ["completion", "vision", "tools"],
            },
          ],
        }
      },
      async pullModel() {
        pullCalled = true
        return { ok: true, message: "Pulled." }
      },
    }

    const app = await buildTestServer(tempDbPath(), createTestAgent(), { embeddingProvider: provider })
    const response = await app.inject({ method: "GET", url: "/api/embeddings/ollama/models" })
    const body = parseResponse<{
      reachable: boolean
      embeddingModels: Array<{ modelId: string }>
      installedModels: Array<{ modelId: string; embeddingCapable: boolean }>
      recommendedModels: Array<{ modelId: string; installed: boolean; pullCommand?: string }>
    }>(response.payload)

    expect(body.ok).toBe(true)
    if (body.ok) {
      expect(body.data.reachable).toBe(true)
      expect(body.data.embeddingModels).toContainEqual(expect.objectContaining({ modelId: "embeddinggemma:latest" }))
      expect(body.data.installedModels).toContainEqual(expect.objectContaining({ modelId: "glm-ocr:latest", embeddingCapable: false }))
      expect(body.data.recommendedModels).toContainEqual(
        expect.objectContaining({ modelId: "embeddinggemma:latest", installed: true, pullCommand: "ollama pull embeddinggemma:latest" }),
      )
    }
    expect(pullCalled).toBe(false)
  })

  it("clears stale embedding errors after a successful reindex", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Embedding Retry")

    let failNextBatch = true
    const provider: EmbeddingProvider = {
      async check() {
        return { ok: true, dimensions: 3, message: "Test embeddings are reachable." }
      },
      async embed(request) {
        return { embeddings: [testEmbeddingVector(request.value)], dimensions: 3 }
      },
      async embedMany(request) {
        if (failNextBatch) {
          failNextBatch = false
          throw new Error("Invalid 'input[9]': maximum input length is 8192 tokens.")
        }
        return { embeddings: request.values.map(testEmbeddingVector), dimensions: 3 }
      },
    }

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, provider, undefined, { socratesHome: tempDir() })
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, "A long source should retry cleanly.", "Indexed.", nowIso())
      store.indexTurnTraceDocuments(project.id, conversation.id, turn.turnId)

      await store.configureProjectEmbeddings(project.id, {
        providerId: "ollama",
        modelId: "embeddinggemma",
        credentialSource: "none",
      })
      const failed = await waitForProjectEmbeddingStatus(store, project.id, (status) => Boolean(status.retrieval.lastError))
      expect(failed.retrieval.lastError).toContain("maximum input length")

      store.reindexProjectEmbeddings(project.id)
      const completed = await waitForProjectEmbeddingStatus(
        store,
        project.id,
        (status) => status.retrieval.vectorReady && !status.retrieval.lastError,
      )
      expect(completed.retrieval.qaParents).toBe(1)
      expect(completed.retrieval.lastError).toBeUndefined()

      handle.sqlite.prepare("UPDATE project_embedding_configs SET last_error = ? WHERE project_id = ? AND active = 1").run(failed.retrieval.lastError, project.id)
      expect(store.getProjectEmbeddingStatus(project.id)).not.toHaveProperty("lastError")
    } finally {
      await store.close()
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

      const request = requests[0] as { system: string; messages: Array<{ role?: string; content?: string }> }
      const dynamicContext = request.messages.find(
        (message) => message.role === "developer" && message.content?.includes("<socrates_dynamic_project_context>"),
      )?.content
      expect(request.system).not.toContain("Name: Context User")
      expect(request.system).not.toContain("Name: Context Project")
      expect(dynamicContext).toContain("Name: Context User")
      expect(dynamicContext).toContain("Name: Context Project")
      expect(dynamicContext).toContain("A test project")
      expect(dynamicContext).toContain("Always answer from the project instructions.")
      expect(request.system).not.toContain("Workspace Terminal commands run with a sanitized user-workspace environment.")
      expect(request.system).not.toContain("Semantic retrieval: not configured.")
      expect(request.system).not.toContain("Current date:")
      expect(request.system).toContain("If the current date or exact time matters, call current_time")
      expect(request.system).toContain("Project notes include an `active_context` section")
      expect(request.system).toContain("backend-owned `runtime_context` section with compact generated workspace scan facts")
      expect(request.system).toContain("On the first assistant response in a new conversation")
      expect(latestUserContent(request.messages)).toBe("Use the context")
      expect(request.messages.some((message) => message.role === "developer" && message.content?.includes("runtime_socrates_docs_preflight"))).toBe(true)
    } finally {
      socket.close()
    }
  })

  it("keeps semantic retrieval status out of the cache-sensitive system prompt", async () => {
    const dbPath = tempDbPath()
    const requests: unknown[] = []
    const app = await buildTestServer(dbPath, createCapturingAgent(requests))
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Ready Semantic Prompt")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, createTestEmbeddingProvider())
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const turn = insertCompletedTestTurn(
        handle.sqlite,
        conversation.id,
        sessionId,
        "Semantic prompt context should include BLUE-LANTERN-42.",
        "Indexed.",
        nowIso(),
      )
      store.indexTurnTraceDocuments(project.id, conversation.id, turn.turnId)
      const now = nowIso()
      handle.sqlite
        .prepare(
          `INSERT INTO project_embedding_configs
            (id, project_id, provider_id, model_id, dimensions, credential_source, ollama_base_url, status, active, created_at, updated_at)
           VALUES (?, ?, 'ollama', 'embeddinggemma', 3, 'none', 'http://127.0.0.1:11434', 'ready', 1, ?, ?)`,
        )
        .run(createId("embcfg"), project.id, now, now)
      handle.sqlite
        .prepare(
          `INSERT INTO trace_embeddings
            (id, project_id, trace_document_id, provider_id, model_id, dimensions, content_hash, vector_json, status, created_at, updated_at, embedded_at)
           SELECT ?, project_id, id, 'ollama', 'embeddinggemma', 3, content_hash, '[1,0,0]', 'completed', ?, ?, ?
           FROM trace_documents
           WHERE source_id = ?
           LIMIT 1`,
        )
        .run(createId("temb"), now, now, now, turn.userMessageId)
    } finally {
      await store.close()
    }

    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Use semantic context"))
      await waitForEvent(socket, "message.completed")

      const request = requests[0] as { system: string; messages: Array<{ role?: string; content?: string }> }
      expect(request.system).not.toContain("Semantic retrieval: ready")
      expect(request.system).not.toContain("Provider/model: ollama/embeddinggemma")
      expect(request.system).not.toContain("indexed=")
      expect(request.system).toContain("trace_retrieve")
      expect(latestUserContent(request.messages)).toBe("Use semantic context")
      expect(request.messages.some((message) => message.role === "developer" && message.content?.includes("runtime_socrates_docs_preflight"))).toBe(true)
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

  it("runs PTY bash tool calls in the same turn and hydrates tool history", async () => {
    const app = await buildTestServer(tempDbPath(), createPersistentBashAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Use bash state", { approvalMode: "approve_all" }))
      await waitForToolCompletedByProviderId(socket, "tcall_cd")
      await waitForToolCompletedByProviderId(socket, "tcall_state")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{
        toolRuns: Array<{ toolCallId: string; providerToolCallId?: string; shell?: { stdout: string; cwd: string }; durationMs?: number }>
      }>(response.payload)

      expect(body.ok).toBe(true)
      if (body.ok) {
        const stateRun = body.data.toolRuns.find((run) => run.providerToolCallId === "tcall_state")
        expect(stateRun?.toolCallId).toMatch(/^tcall_/)
        expect(stateRun?.shell?.stdout).toBe("Backend-Test-Project")
        expect(stateRun?.shell?.cwd.endsWith("Backend-Test-Project")).toBe(true)
        expect(stateRun?.durationMs).toBeGreaterThanOrEqual(0)
      }
    } finally {
      socket.close()
    }
  })

  it("keeps started terminals across turns and injects terminal context into the next prompt", async () => {
    const requests: unknown[] = []
    const app = await buildTestServer(tempDbPath(), createConversationTerminalAgent(requests))
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start a terminal", { approvalMode: "approve_all" }))
      const startedTerminal = await waitForEvent(socket, "terminal.started")
      expect(startedTerminal.payload.name).toBe("server-test")
      expect(startedTerminal.payload.status).toBe("running")

      await waitForToolCompletedByProviderId(socket, "tcall_terminal_start")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ terminals: Array<{ terminalId: string; name: string; status: string }> }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.terminals.some((terminal) => terminal.terminalId === startedTerminal.payload.terminalId && terminal.status === "running")).toBe(true)
      }

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "What terminals are active?"))
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const nextTurnRequest = requests.at(-1) as { system?: string; messages?: Array<{ role?: string; content?: unknown }> }
      const nextTurnMessages = JSON.stringify(nextTurnRequest.messages ?? [])
      expect(nextTurnRequest.system ?? "").not.toContain(startedTerminal.payload.terminalId)
      expect(nextTurnRequest.system ?? "").not.toContain("name: server-test")
      expect(nextTurnMessages).toContain("<socrates_runtime_context>")
      expect(nextTurnMessages).toContain("name: server-test")
      expect(nextTurnMessages).not.toContain(startedTerminal.payload.terminalId)

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Stop terminal by name"))
      const stoppedByTool = await waitForEvent(socket, "terminal.stopped")
      expect(stoppedByTool.payload.terminalId).toBe(startedTerminal.payload.terminalId)
      await waitForToolCompletedByProviderId(socket, "tcall_terminal_stop_by_name")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const stoppedResponse = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const stoppedBody = parseResponse<{ terminals: Array<{ terminalId: string; name: string; status: string }> }>(stoppedResponse.payload)
      expect(stoppedBody.ok).toBe(true)
      if (stoppedBody.ok) {
        expect(stoppedBody.data.terminals.some((terminal) => terminal.terminalId === startedTerminal.payload.terminalId && terminal.status === "stopped")).toBe(true)
      }

    } finally {
      socket.close()
    }
  })

  it("routes Terminal events only to the subscribed conversation and rejects controls from other sockets", async () => {
    const requests: unknown[] = []
    const app = await buildTestServer(tempDbPath(), createConversationTerminalAgent(requests))
    await onboard(app)
    const { project } = await createProject(app)
    const firstConversation = await createConversation(app, project.id, "Terminal owner")
    const secondConversation = await createConversation(app, project.id, "Terminal observer")
    const ownerSocket = await connectWebSocket(app)
    const observerSocket = await connectWebSocket(app)
    let terminalId: string | undefined
    try {
      await waitForEvent(ownerSocket, "connection.ready")
      await waitForEvent(observerSocket, "connection.ready")
      sendCommand(observerSocket, chatSubscribeCommand(project.id, secondConversation.id))

      sendCommand(ownerSocket, chatMessageCommandWithRuntime(project.id, firstConversation.id, "Start a terminal", { approvalMode: "approve_all" }))
      const started = await waitForEvent(ownerSocket, "terminal.started", 8_000)
      terminalId = started.payload.terminalId
      await waitForEvent(ownerSocket, "turn.completed")
      await delay(350)

      const observerTerminalEvents = (trackedEvents.get(observerSocket) ?? []).filter((event) => event.type.startsWith("terminal."))
      expect(observerTerminalEvents).toEqual([])

      sendCommand(observerSocket, {
        id: createId("evt"),
        type: "terminal.stop",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: firstConversation.id,
        actor: { type: "user" },
        payload: { terminalId },
      })
      const rejected = await waitForEvent(observerSocket, "error.created")
      expect(rejected.payload.error.code).toBe("terminal_conversation_not_subscribed")
    } finally {
      if (ownerSocket.readyState === WebSocket.OPEN && terminalId) {
        sendCommand(ownerSocket, {
          id: createId("evt"),
          type: "terminal.stop",
          schemaVersion: 1,
          timestamp: nowIso(),
          projectId: project.id,
          conversationId: firstConversation.id,
          actor: { type: "user" },
          payload: { terminalId, reason: "Test cleanup" },
        })
      }
      ownerSocket.close()
      observerSocket.close()
    }
  })

  it("stops detached terminal processes when the server closes", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath, createShutdownCleanupTerminalAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    let systemPid: number | undefined
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start cleanup terminal", { approvalMode: "approve_all" }))
      const startedTerminal = await waitForEvent(socket, "terminal.started")
      expect(startedTerminal.payload.name).toBe("shutdown-cleanup-test")
      await waitForToolCompletedByProviderId(socket, "tcall_shutdown_cleanup_start")
      await waitForEvent(socket, "turn.completed")

      const db = new Database(dbPath, { readonly: true })
      try {
        const row = db
          .prepare("SELECT metadata_json FROM terminal_sessions WHERE id = ?")
          .get(startedTerminal.payload.terminalId) as { metadata_json?: string } | undefined
        const metadata = JSON.parse(row?.metadata_json ?? "{}") as { systemPid?: unknown }
        expect(typeof metadata.systemPid).toBe("number")
        systemPid = metadata.systemPid as number
        expect(processExists(systemPid)).toBe(true)
      } finally {
        db.close()
      }
    } finally {
      socket.close()
    }

    expect(systemPid).toBeDefined()
    await closeTestServer(app)
    await waitForProcessExit(systemPid as number)
  })

  it("auto-targets exactly one active terminal when the model stops without an id", async () => {
    const app = await buildTestServer(tempDbPath(), createUntargetedTerminalStopAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start one terminal", { approvalMode: "approve_all" }))
      const startedTerminal = await waitForEvent(socket, "terminal.started")
      expect(startedTerminal.payload.name).toBe("solo-server")
      await waitForToolCompletedByProviderId(socket, "tcall_terminal_start_solo")
      await waitForEvent(socket, "turn.completed")

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Stop the only terminal"))
      const stoppedTerminal = await waitForEvent(socket, "terminal.stopped")
      expect(stoppedTerminal.payload.terminalId).toBe(startedTerminal.payload.terminalId)
      await waitForToolCompletedByProviderId(socket, "tcall_terminal_stop_solo")
      await waitForEvent(socket, "turn.completed")
    } finally {
      socket.close()
    }
  })

  it("suspends and resumes the same task when a waited Terminal completes", async () => {
    let continuationContext = ""
    const app = await buildTestServer(tempDbPath(), createTerminalWaitResumeAgent(2500, (serialized) => {
      continuationContext = serialized
    }))
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Wait for terminal completion", { approvalMode: "approve_all" }))
      const waiting = await waitForEvent(socket, "turn.waiting", 6_000)
      expect(waiting.payload).toMatchObject({ terminalNames: ["wait-resume-tests"], wakeOn: ["completed", "failed"] })
      const resumed = await waitForEvent(socket, "turn.resumed", 6_000)
      expect(resumed.payload).toMatchObject({ terminalName: "wait-resume-tests", wakeEvent: "completed" })
      await waitForEvent(socket, "turn.completed")
      expect(continuationContext).toContain("Task progress before this wake is authoritative lifecycle evidence")
      expect(continuationContext).toContain('\\\"name\\\": \\\"wait-resume-tests\\\"')
      expect(continuationContext).toContain('\\\"status\\\": \\\"exited\\\"')

      const response = await app.inject({ method: "GET", url: `/api/projects/${project.id}/conversations/${conversation.id}` })
      const body = parseResponse<{ messages: Array<{ content: string }> }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.messages.some((message) => message.content === "Background terminal result verified.")).toBe(true)
      }
    } finally {
      socket.close()
    }
  }, 10_000)

  it("keeps a waited Terminal alive across a main-server restart and resumes exactly once", async () => {
    const dbPath = tempDbPath()
    const agent = createTerminalWaitResumeAgent()
    const firstApp = await buildTestServer(dbPath, agent, { preserveTerminalsOnClose: true })
    await onboard(firstApp)
    const { project } = await createProject(firstApp)
    const conversation = await createConversation(firstApp, project.id)
    const firstSocket = await connectWebSocket(firstApp)
    let systemPid: number | undefined
    try {
      await waitForEvent(firstSocket, "connection.ready")
      sendCommand(firstSocket, chatMessageCommandWithRuntime(project.id, conversation.id, "Wait for terminal completion", { approvalMode: "approve_all" }))
      const started = await waitForEvent(firstSocket, "terminal.started", 6_000)
      await waitForEvent(firstSocket, "turn.waiting", 6_000)

      const db = new Database(dbPath, { readonly: true })
      try {
        const row = db.prepare("SELECT metadata_json FROM terminal_sessions WHERE id = ?").get(started.payload.terminalId) as
          | { metadata_json?: string }
          | undefined
        const metadata = JSON.parse(row?.metadata_json ?? "{}") as { systemPid?: unknown }
        expect(typeof metadata.systemPid).toBe("number")
        systemPid = metadata.systemPid as number
      } finally {
        db.close()
      }
    } finally {
      firstSocket.close()
      await closeTestServer(firstApp)
    }

    expect(systemPid).toBeDefined()
    expect(processExists(systemPid as number)).toBe(true)

    const secondApp = await buildTestServer(dbPath, agent)
    const deadline = Date.now() + 8_000
    let matchingMessages: Array<{ content: string }> = []
    while (Date.now() < deadline) {
      const response = await secondApp.inject({ method: "GET", url: `/api/projects/${project.id}/conversations/${conversation.id}` })
      const body = parseResponse<{ messages: Array<{ content: string }> }>(response.payload)
      if (body.ok) {
        matchingMessages = body.data.messages.filter((message) => message.content === "Background terminal result verified.")
        if (matchingMessages.length > 0) break
      }
      await delay(50)
    }
    expect(matchingMessages).toHaveLength(1)

    const db = new Database(dbPath, { readonly: true })
    try {
      const task = db.prepare("SELECT status FROM agent_tasks").get() as { status: string } | undefined
      const continuationCount = db
        .prepare("SELECT COUNT(*) AS count FROM turns WHERE conversation_id = ?")
        .get(conversation.id) as { count: number }
      expect(task?.status).toBe("completed")
      expect(continuationCount.count).toBe(2)
    } finally {
      db.close()
    }
  }, 15_000)

  it("restarts a crashed coordinator and reconnects to the independently hosted PTY", async () => {
    const dbPath = tempDbPath()
    const agent = createTerminalWaitResumeAgent(5_000)
    const firstApp = await buildTestServer(dbPath, agent, { preserveTerminalsOnClose: true })
    await onboard(firstApp)
    const { project } = await createProject(firstApp)
    const conversation = await createConversation(firstApp, project.id)
    const firstSocket = await connectWebSocket(firstApp)
    let supervisorPid: number | undefined
    let terminalSystemPid: number | undefined
    try {
      await waitForEvent(firstSocket, "connection.ready")
      sendCommand(firstSocket, chatMessageCommandWithRuntime(project.id, conversation.id, "Wait for terminal completion", { approvalMode: "approve_all" }))
      const started = await waitForEvent(firstSocket, "terminal.started", 6_000)
      await waitForEvent(firstSocket, "turn.waiting", 6_000)

      const db = new Database(dbPath, { readonly: true })
      try {
        const row = db.prepare("SELECT metadata_json FROM terminal_sessions WHERE id = ?").get(started.payload.terminalId) as
          | { metadata_json?: string }
          | undefined
        const metadata = JSON.parse(row?.metadata_json ?? "{}") as {
          systemPid?: unknown
          supervisor?: { processId?: unknown }
        }
        expect(typeof metadata.supervisor?.processId).toBe("number")
        supervisorPid = metadata.supervisor?.processId as number
        terminalSystemPid = typeof metadata.systemPid === "number" ? metadata.systemPid : undefined
      } finally {
        db.close()
      }
    } finally {
      firstSocket.close()
      await closeTestServer(firstApp)
    }

    expect(supervisorPid).toBeDefined()
    process.kill(supervisorPid as number, "SIGKILL")
    await waitForProcessExit(supervisorPid as number)

    const secondApp = await buildTestServer(dbPath, agent)
    const deadline = Date.now() + 8_000
    let matchingMessages: Array<{ content: string }> = []
    while (Date.now() < deadline) {
      const response = await secondApp.inject({ method: "GET", url: `/api/projects/${project.id}/conversations/${conversation.id}` })
      const body = parseResponse<{ messages: Array<{ content: string }> }>(response.payload)
      if (body.ok) {
        matchingMessages = body.data.messages.filter((message) => message.content === "Background terminal result verified.")
        if (matchingMessages.length > 0) break
      }
      await delay(50)
    }
    expect(matchingMessages).toHaveLength(1)

    const db = new Database(dbPath, { readonly: true })
    try {
      const terminal = db.prepare("SELECT status, metadata_json FROM terminal_sessions").get() as { status: string; metadata_json: string | null }
      const task = db.prepare("SELECT status, metadata_json FROM agent_tasks").get() as { status: string; metadata_json: string | null }
      const terminalMetadata = JSON.parse(terminal.metadata_json ?? "{}") as { supervisorRecovery?: { state?: unknown } }
      const taskMetadata = JSON.parse(task.metadata_json ?? "{}") as { wakeEvent?: unknown }
      expect(terminal.status).toBe("exited")
      expect(terminalMetadata.supervisorRecovery?.state).toBe("reconnected")
      expect(task.status).toBe("completed")
      expect(taskMetadata.wakeEvent).toBe("completed")
    } finally {
      db.close()
      if (terminalSystemPid && processExists(terminalSystemPid)) {
        process.kill(terminalSystemPid, "SIGTERM")
      }
    }
  }, 15_000)

  it("returns persisted terminal output after background polling has drained supervisor output", async () => {
    const app = await buildTestServer(tempDbPath(), createTerminalOutputAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    let terminalId: string | undefined
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start tail terminal", { approvalMode: "approve_all" }))
      const startedTerminal = await waitForEvent(socket, "terminal.started")
      terminalId = startedTerminal.payload.terminalId
      const startCompleted = await waitForToolCompletedByProviderId(socket, "tcall_tail_start")
      expect(startCompleted.payload.resultPreview).toContain("tail-ready")
      await waitForEvent(socket, "turn.completed")

      await delay(700)
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Read tail terminal output"))
      const outputCompleted = await waitForToolCompletedByProviderId(socket, "tcall_tail_output")
      expect(outputCompleted.payload.providerToolCallId).toBe("tcall_tail_output")
      expect(outputCompleted.payload.resultPreview).not.toContain("tail-ready")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{
        terminals: Array<{ terminalId: string; output: { stdout: string } }>
        toolRuns: Array<{ providerToolCallId?: string; shell?: { stdout: string } }>
      }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        const terminal = body.data.terminals.find((item) => item.terminalId === terminalId)
        const outputRun = body.data.toolRuns.find((item) => item.providerToolCallId === "tcall_tail_output")
        expect((terminal?.output.stdout.match(/tail-ready/g) ?? []).length).toBe(1)
        expect(outputRun?.shell?.stdout).not.toContain("tail-ready")
      }
    } finally {
      if (socket.readyState === WebSocket.OPEN && terminalId) {
        sendCommand(socket, {
          id: createId("evt"),
          type: "terminal.stop",
          schemaVersion: 1,
          timestamp: nowIso(),
          projectId: project.id,
          conversationId: conversation.id,
          actor: { type: "user" },
          payload: { terminalId, reason: "Test cleanup" },
        })
      }
      socket.close()
    }
  })

  it("does not duplicate already-drained PTY output when a terminal is stopped", async () => {
    const app = await buildTestServer(tempDbPath(), createTerminalStopDedupAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start dedup terminal", { approvalMode: "approve_all" }))
      const startedTerminal = await waitForEvent(socket, "terminal.started")
      expect(startedTerminal.payload.name).toBe("dedup-server")
      await waitForToolCompletedByProviderId(socket, "tcall_dedup_start")
      await waitForEvent(socket, "turn.completed")

      await delay(450)
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Read dedup output"))
      const outputCompleted = await waitForToolCompletedByProviderId(socket, "tcall_dedup_output")
      expect(outputCompleted.payload.providerToolCallId).toBe("tcall_dedup_output")
      await waitForEvent(socket, "turn.completed")

      await delay(250)
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Stop dedup terminal"))
      const stopped = await waitForEvent(socket, "terminal.stopped")
      expect(stopped.payload.terminalId).toBe(startedTerminal.payload.terminalId)
      const stopCompleted = await waitForToolCompletedByProviderId(socket, "tcall_dedup_stop")
      expect(stopCompleted.payload.providerToolCallId).toBe("tcall_dedup_stop")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{
        terminals: Array<{ terminalId: string; output: { stdout: string } }>
        toolRuns: Array<{ providerToolCallId?: string; shell?: { stdout: string } }>
      }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        const terminal = body.data.terminals.find((item) => item.terminalId === startedTerminal.payload.terminalId)
        const stopRun = body.data.toolRuns.find((item) => item.providerToolCallId === "tcall_dedup_stop")
        const terminalLines = terminal?.output.stdout.split(/\r?\n/).filter(Boolean) ?? []
        const stopLines = stopRun?.shell?.stdout.split(/\r?\n/).filter(Boolean) ?? []
        expect(terminalLines.length).toBeGreaterThan(0)
        expect(terminalLines).toEqual([...new Set(terminalLines)])
        expect(new Set(stopLines).size).toBe(stopLines.length)
      }
    } finally {
      socket.close()
    }
  })

  it("keeps finite started terminals completed instead of marking them detached after initial drain", async () => {
    const app = await buildTestServer(tempDbPath(), createFiniteTerminalAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start finite terminal", { approvalMode: "approve_all" }))
      const toolResult = await waitForToolCompletedByProviderId(socket, "tcall_finite_start")
      expect(toolResult.type).toBe("tool.call.completed")
      const completedTerminal = await waitForEvent(socket, "terminal.completed")
      expect(completedTerminal.payload.name).toBe("finite-server")
      expect(completedTerminal.payload.status).toBe("exited")
      await delay(500)

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ terminals: Array<{ terminalId: string; status: string; output: { stdout: string }; metadata?: unknown }> }>(
        response.payload,
      )
      expect(body.ok).toBe(true)
      if (body.ok) {
        const terminal = body.data.terminals.find((item) => item.terminalId === completedTerminal.payload.terminalId)
        expect(terminal?.status).toBe("exited")
        expect(terminal?.output.stdout).toContain("finite-done")
        expect(JSON.stringify(terminal?.metadata ?? {})).not.toContain("terminal_supervisor_lost_process")
      }
    } finally {
      socket.close()
    }
  })

  it("returns output when a foreground run exits during its initial Terminal drain", async () => {
    const app = await buildTestServer(tempDbPath(), createQuickRunOutputAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Run a quick command", { approvalMode: "approve_all" }))
      await waitForToolCompletedByProviderId(socket, "tcall_quick_run_output")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ toolRuns: Array<{ providerToolCallId?: string; shell?: { stdout: string; message?: string } }> }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        const run = body.data.toolRuns.find((item) => item.providerToolCallId === "tcall_quick_run_output")
        expect(run?.shell?.stdout).toContain("quick-run-evidence")
        expect(run?.shell?.message ?? "").not.toContain("No new Terminal output")
      }
    } finally {
      socket.close()
    }
  })

  it("reuses an already-running named terminal instead of starting a duplicate", async () => {
    const app = await buildTestServer(tempDbPath(), createDuplicateTerminalStartAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    let terminalId: string | undefined
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start duplicate terminal twice", { approvalMode: "approve_all" }))
      const startedTerminal = await waitForEvent(socket, "terminal.started")
      terminalId = startedTerminal.payload.terminalId
      expect(startedTerminal.payload.name).toBe("reuse-server")
      const firstCompleted = await waitForToolCompletedByProviderId(socket, "tcall_reuse_start_first")
      const secondCompleted = await waitForToolCompletedByProviderId(socket, "tcall_reuse_start_second")
      expect(firstCompleted.payload.providerToolCallId).toBe("tcall_reuse_start_first")
      expect(secondCompleted.payload.providerToolCallId).toBe("tcall_reuse_start_second")
      expect(secondCompleted.payload.summary).toContain("Reused existing Terminal")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ terminals: Array<{ name: string; status: string }> }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.terminals.filter((terminal) => terminal.name === "reuse-server" && terminal.status === "running")).toHaveLength(1)
      }
    } finally {
      if (socket.readyState === WebSocket.OPEN && terminalId) {
        sendCommand(socket, {
          id: createId("evt"),
          type: "terminal.stop",
          schemaVersion: 1,
          timestamp: nowIso(),
          projectId: project.id,
          conversationId: conversation.id,
          actor: { type: "user" },
          payload: { terminalId, reason: "Test cleanup" },
        })
      }
      socket.close()
    }
  })

  it("asks for a natural terminal target when an untargeted model stop is ambiguous", async () => {
    const app = await buildTestServer(tempDbPath(), createAmbiguousTerminalStopAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    const startedTerminalIds: string[] = []
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start alpha", { approvalMode: "approve_all" }))
      const alpha = await waitForEvent(socket, "terminal.started")
      startedTerminalIds.push(alpha.payload.terminalId)
      expect(alpha.payload.name).toBe("alpha-server")
      await waitForToolCompletedByProviderId(socket, "tcall_terminal_start_alpha")
      await waitForEvent(socket, "turn.completed")

      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start beta", { approvalMode: "approve_all" }))
      const beta = await waitForEvent(socket, "terminal.started")
      startedTerminalIds.push(beta.payload.terminalId)
      expect(beta.payload.name).toBe("beta-server")
      await waitForToolCompletedByProviderId(socket, "tcall_terminal_start_beta")
      await waitForEvent(socket, "turn.completed")

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Stop without target"))
      const failed = await waitForToolFailedByProviderId(socket, "tcall_terminal_stop_ambiguous")
      expect(failed.payload.error.code).toBe("terminal_ambiguous")
      expect(JSON.stringify(failed.payload.error.details)).toContain("alpha-server")
      expect(JSON.stringify(failed.payload.error.details)).toContain("beta-server")
      await waitForEvent(socket, "turn.completed")
    } finally {
      if (socket.readyState === WebSocket.OPEN) {
        for (const terminalId of startedTerminalIds) {
          sendCommand(socket, {
            id: createId("evt"),
            type: "terminal.stop",
            schemaVersion: 1,
            timestamp: nowIso(),
            projectId: project.id,
            conversationId: conversation.id,
            actor: { type: "user" },
            payload: { terminalId, reason: "Test cleanup" },
          })
        }
      }
      socket.close()
    }
  })

  it("detects split interactive prompts and accepts key input while the terminal is running", async () => {
    const app = await buildTestServer(tempDbPath(), createInteractiveTerminalAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start an interactive terminal", { approvalMode: "approve_all" }))
      const inputRequested = await waitForEvent(socket, "terminal.input.requested", 8_000)
      expect(inputRequested.payload.name).toBe("interactive-test")
      expect(inputRequested.payload.status).toBe("awaiting_input")
      expect(inputRequested.payload.prompt).toContain("Use arrow-keys")

      sendCommand(socket, {
        id: createId("evt"),
        type: "terminal.input",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { terminalId: inputRequested.payload.terminalId, key: "ArrowDown" },
      })
      await waitForEvent(socket, "terminal.status")

      sendCommand(socket, {
        id: createId("evt"),
        type: "terminal.input",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { terminalId: inputRequested.payload.terminalId, key: "Enter" },
      })
      await waitForEvent(socket, "terminal.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ terminals: Array<{ terminalId: string; output: { stdout: string } }> }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        const terminal = body.data.terminals.find((item) => item.terminalId === inputRequested.payload.terminalId)
        expect(terminal?.output.stdout).toContain("selected Base")
        expect(terminal?.output.stdout).toContain("submitted")
      }
    } finally {
      socket.close()
    }
  }, 10_000)

  it("accepts two user inputs and derives the second prompt from the first", async () => {
    const app = await buildTestServer(tempDbPath(), createTextInputTerminalAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start text input terminal", { approvalMode: "approve_all" }))
      const inputRequested = await waitForEvent(socket, "terminal.input.requested", 8_000)
      expect(inputRequested.payload.name).toBe("text-input-test")
      expect(inputRequested.payload.status).toBe("awaiting_input")
      expect(inputRequested.payload.prompt).toContain("What is your favorite colour?")

      sendCommand(socket, {
        id: createId("evt"),
        type: "terminal.input",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { terminalId: inputRequested.payload.terminalId, data: "violet\n" },
      })
      let runningAfterFirstInput = await waitForEvent(socket, "terminal.status", 8_000)
      while ((runningAfterFirstInput.payload.stateVersion ?? -1) <= (inputRequested.payload.stateVersion ?? -1)) {
        runningAfterFirstInput = await waitForEvent(socket, "terminal.status", 8_000)
      }
      expect(runningAfterFirstInput.payload.status).toBe("running")
      expect(runningAfterFirstInput.payload.awaitingInput).toBe(false)
      expect(runningAfterFirstInput.payload.stateVersion).toBeGreaterThan(inputRequested.payload.stateVersion ?? -1)
      const secondInputRequested = await waitForEvent(socket, "terminal.input.requested", 8_000)
      expect(secondInputRequested.payload.status).toBe("awaiting_input")
      expect(secondInputRequested.payload.awaitingInput).toBe(true)
      expect(secondInputRequested.payload.stateVersion).toBeGreaterThan(runningAfterFirstInput.payload.stateVersion ?? -1)
      expect(secondInputRequested.payload.prompt).toContain("Name an animal with the colour violet")
      sendCommand(socket, {
        id: createId("evt"),
        type: "terminal.input",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { terminalId: inputRequested.payload.terminalId, data: "butterfly\n" },
      })
      const completed = await waitForEvent(socket, "terminal.completed")
      expect(completed.payload.terminalId).toBe(inputRequested.payload.terminalId)

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ terminals: Array<{ terminalId: string; status: string; output: { stdout: string } }> }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        const terminal = body.data.terminals.find((item) => item.terminalId === inputRequested.payload.terminalId)
        expect(terminal?.status).toBe("exited")
        expect(terminal?.output.stdout).toContain("What is your favorite colour?")
        expect(terminal?.output.stdout).toContain("Name an animal with the colour violet")
        expect(terminal?.output.stdout).toContain("Recorded butterfly for violet!")
      }
    } finally {
      socket.close()
    }
  }, 10_000)

  it("keeps an awaiting-input terminal running when the model tries to stop it before user input", async () => {
    const app = await buildTestServer(tempDbPath(), createPrematureInteractiveStopAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start interactive and stop too early", { approvalMode: "approve_all" }))
      const inputRequested = await waitForEvent(socket, "terminal.input.requested", 8_000)
      expect(inputRequested.payload.name).toBe("premature-stop-test")
      expect(inputRequested.payload.status).toBe("awaiting_input")

      await waitForToolCompletedByProviderId(socket, "tcall_premature_stop_start")
      const failed = await waitForToolFailedByProviderId(socket, "tcall_attempt_stop_awaiting")
      expect(failed.payload.error.code).toBe("terminal_awaiting_user_input")
      expect(failed.payload.error.recoverable).toBe(true)
      const waiting = await waitForEvent(socket, "turn.waiting")
      expect(waiting.payload.terminalNames).toEqual(["premature-stop-test"])
      expect(waiting.payload.wakeOn).toEqual(["completed", "failed"])

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ terminals: Array<{ terminalId: string; name: string; status: string; awaitingInput: boolean; output: { stdout: string } }> }>(
        response.payload,
      )
      expect(body.ok).toBe(true)
      if (body.ok) {
        const terminal = body.data.terminals.find((item) => item.terminalId === inputRequested.payload.terminalId)
        expect(terminal?.name).toBe("premature-stop-test")
        expect(terminal?.status).toBe("awaiting_input")
        expect(terminal?.awaitingInput).toBe(true)
        expect(terminal?.output.stdout).toContain("What is your name?")
      }

      sendCommand(socket, {
        id: createId("evt"),
        type: "terminal.stop",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { terminalId: inputRequested.payload.terminalId, reason: "Test cleanup" },
      })
      await waitForEvent(socket, "terminal.stopped")
    } finally {
      socket.close()
    }
  }, 10_000)

  it("drains a resumed Terminal start that races with server shutdown and reconciles every durable lifecycle row", async () => {
    const dbPath = tempDbPath()
    const supervisorSocket = terminalSupervisorSocketPath(path.dirname(dbPath))
    const app = await buildTestServer(dbPath, createPrematureInteractiveStopAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    await waitForEvent(socket, "connection.ready")
    sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start interactive and stop too early", { approvalMode: "approve_all" }))
    const inputRequested = await waitForEvent(socket, "terminal.input.requested", 8_000)
    await waitForToolFailedByProviderId(socket, "tcall_attempt_stop_awaiting")
    await waitForEvent(socket, "turn.waiting")
    sendCommand(socket, {
      id: createId("evt"),
      type: "terminal.stop",
      schemaVersion: 1,
      timestamp: nowIso(),
      projectId: project.id,
      conversationId: conversation.id,
      actor: { type: "user" },
      payload: { terminalId: inputRequested.payload.terminalId, reason: "Trigger shutdown race" },
    })
    await waitForEvent(socket, "terminal.stopped")
    await waitForEvent(socket, "turn.resumed")

    const deadline = Date.now() + 3_000
    let sawResumedStart = false
    while (Date.now() < deadline && !sawResumedStart) {
      const db = new Database(dbPath, { readonly: true })
      try {
        sawResumedStart = Boolean(
          db
            .prepare("SELECT 1 FROM tool_calls WHERE provider_tool_call_id = ? AND status = 'running' LIMIT 1")
            .get("tcall_premature_stop_start"),
        )
      } finally {
        db.close()
      }
      if (!sawResumedStart) await delay(5)
    }
    expect(sawResumedStart).toBe(true)

    socket.close()
    await closeTestServer(app)

    const db = new Database(dbPath, { readonly: true })
    let rows: Array<{ id: string; status: string; metadata_json?: string }>
    try {
      rows = db.prepare("SELECT id, status, metadata_json FROM terminal_sessions ORDER BY started_at").all() as typeof rows
      const activeTerminals = rows.filter((row) => ["starting", "running", "awaiting_input"].includes(row.status))
      const activeTools = db.prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE status IN ('running', 'awaiting_approval')").get() as { count: number }
      const activeTurns = db.prepare("SELECT COUNT(*) AS count FROM turns WHERE status IN ('queued', 'running', 'awaiting_approval')").get() as { count: number }
      const activeTasks = db.prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE status IN ('running', 'waiting')").get() as { count: number }
      expect(rows.length).toBeGreaterThanOrEqual(2)
      expect(activeTerminals).toEqual([])
      expect(activeTools.count).toBe(0)
      expect(activeTurns.count).toBe(0)
      expect(activeTasks.count).toBe(0)
    } finally {
      db.close()
    }

    for (const row of rows) {
      const metadata = JSON.parse(row.metadata_json ?? "{}") as { systemPid?: unknown }
      if (typeof metadata.systemPid === "number") await waitForProcessExit(metadata.systemPid)
      if (process.platform !== "win32") expect(fs.existsSync(terminalHostSocketPath(supervisorSocket, row.id))).toBe(false)
    }
    if (process.platform !== "win32") expect(fs.existsSync(supervisorSocket)).toBe(false)
  }, 15_000)

  it("recovers a supervisor-owned Terminal left in the durable starting phase", async () => {
    const dbPath = tempDbPath()
    const firstApp = await buildTestServer(dbPath)
    await onboard(firstApp)
    const { project, primaryWorkspace } = await createProject(firstApp)
    const conversation = await createConversation(firstApp, project.id)
    await closeTestServer(firstApp)

    const terminalId = createId("term")
    const commandText = nodeCommand('process.stdout.write("recoverable-start\\n"); setInterval(() => {}, 1000)')
    const supervisor = new TerminalSupervisorClient(path.dirname(dbPath))
    const workspacePath = primaryWorkspace.path
    if (!workspacePath) throw new Error("Expected a primary workspace path")
    const started = await supervisor.start(terminalId, workspacePath, { operation: "start", command: commandText, name: "recoverable-start" })
    const systemPid = started.process?.systemPid
    expect(typeof systemPid).toBe("number")

    const db = new Database(dbPath)
    const timestamp = nowIso()
    try {
      db.prepare(
        `INSERT INTO terminal_sessions (
          id, project_id, conversation_id, workspace_path, name, command, cwd, status,
          auto_detached, awaiting_input, started_at, updated_at, state_version, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'starting', 0, 0, ?, ?, 0, ?)`,
      ).run(
        terminalId,
        project.id,
        conversation.id,
        workspacePath,
        "recoverable-start",
        commandText,
        workspacePath,
        timestamp,
        timestamp,
        JSON.stringify({ lifecycle: { phase: "starting", recordedAt: timestamp } }),
      )
    } finally {
      db.close()
    }

    const secondApp = await buildTestServer(dbPath)
    const recoveredDb = new Database(dbPath, { readonly: true })
    try {
      const recovered = recoveredDb
        .prepare("SELECT status, process_id, metadata_json FROM terminal_sessions WHERE id = ?")
        .get(terminalId) as { status: string; process_id?: string; metadata_json?: string }
      const metadata = JSON.parse(recovered.metadata_json ?? "{}") as { supervisorRecovery?: { state?: string } }
      expect(recovered.status).toBe("running")
      expect(recovered.process_id).toBe(started.process?.processId)
      expect(metadata.supervisorRecovery?.state).toBe("incomplete_start_recovered")
    } finally {
      recoveredDb.close()
    }

    await closeTestServer(secondApp)
    await supervisor.shutdown()
    await waitForProcessExit(systemPid as number)
  }, 15_000)

  it("persists recoverable shell failures and continues with the next PTY run", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath, createRecoveringBashAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Recover bash shell", { approvalMode: "approve_all" }))
      const failed = await waitForToolFailedByProviderId(socket, "tcall_break_shell")
      const completed = await waitForToolCompletedByProviderId(socket, "tcall_after_reset")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      expect(failed.payload.providerToolCallId).toBe("tcall_break_shell")
      expect(failed.payload.error.code).toBe("external_workspace_cd_rejected")
      expect(completed.payload.providerToolCallId).toBe("tcall_after_reset")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{
        toolRuns: Array<{ toolCallId: string; providerToolCallId?: string; shell?: { stdout: string; platform?: string; shellKind?: string; shellExecutable?: string } }>
      }>(response.payload)

      expect(body.ok).toBe(true)
      if (body.ok) {
        const recoveredRun = body.data.toolRuns.find((run) => run.providerToolCallId === "tcall_after_reset")
        expect(recoveredRun?.shell?.stdout).toBe("recovered")
        expect(recoveredRun?.shell?.shellKind).toBe(process.platform === "win32" ? "powershell" : "posix")
      }

      const sqlite = new Database(dbPath)
      try {
        const error = sqlite
          .prepare("SELECT code, recoverable, details_json FROM errors WHERE source = 'tool' AND code = 'external_workspace_cd_rejected'")
          .get() as { code: string; recoverable: number; details_json: string } | undefined
        expect(error?.code).toBe("external_workspace_cd_rejected")
        expect(error?.recoverable).toBe(1)
        const details = JSON.parse(error?.details_json ?? "{}") as { workspacePath?: string; cdTarget?: string }
        expect(details.workspacePath).toBeTruthy()
        expect(details.cdTarget).toBe("/Users/example/Test")
      } finally {
        sqlite.close()
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
        toolRuns: Array<{ toolCallId: string; providerToolCallId?: string; approval?: { status: string; decision?: string }; shell?: { exitCode?: number | null } }>
      }>(response.payload)

      expect(body.ok).toBe(true)
      if (body.ok) {
        const approvalRun = body.data.toolRuns.find((run) => run.providerToolCallId === "tcall_approval")
        expect(approvalRun?.toolCallId).toMatch(/^tcall_/)
        expect(approvalRun?.approval?.status).toBe("approved")
        expect(approvalRun?.approval?.decision).toBe("approved")
        expect(approvalRun?.shell?.exitCode).toBe(0)
        expect(fs.readFileSync(path.join(primaryWorkspace.path ?? "", "approved.txt"), "utf8")).toBe("approved")
      }
    } finally {
      socket.close()
    }
  })

  it("collects multiple MCP credentials one at a time without persisting or returning plaintext", async () => {
    const root = tempDir()
    const dbPath = path.join(root, "socrates.sqlite")
    const scriptPath = writeCredentialFlowMcpScript(root)
    const app = await buildTestServer(dbPath, createCredentialFlowAgent(scriptPath), { socratesHome: path.join(root, "home") })
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app, "Credential Flow Project")
    const conversation = await createConversation(app, project.id, "Credential Flow")
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Configure the trusted credential test MCP."))
      const approval = await waitForEvent(socket, "approval.requested")
      expect(approval.payload.actionPreview).toContain("FIRST_TEST_KEY")
      expect(approval.payload.actionPreview).not.toContain("first-private-value")
      sendCommand(socket, {
        id: createId("evt"),
        type: "approval.decide",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { approvalId: approval.payload.approvalId, decision: "approved" },
      })
      await waitForEvent(socket, "approval.resolved")

      const firstRequest = await waitForEvent(socket, "credential.input.requested")
      expect(firstRequest.payload.envKey).toBe("FIRST_TEST_KEY")
      sendCommand(socket, {
        id: createId("evt"),
        type: "credential.input.submit",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        turnId: firstRequest.turnId,
        actor: { type: "user" },
        payload: {
          credentialRequestId: firstRequest.payload.credentialRequestId,
          turnId: firstRequest.turnId,
          decision: "submitted",
          value: "first-private-value",
        },
      })
      await waitForEvent(socket, "credential.input.resolved")

      const secondRequest = await waitForEvent(socket, "credential.input.requested")
      expect(secondRequest.payload.envKey).toBe("SECOND_TEST_KEY")
      sendCommand(socket, {
        id: createId("evt"),
        type: "credential.input.submit",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        turnId: secondRequest.turnId,
        actor: { type: "user" },
        payload: {
          credentialRequestId: secondRequest.payload.credentialRequestId,
          turnId: secondRequest.turnId,
          decision: "submitted",
          value: "second-private-value",
        },
      })
      await waitForEvent(socket, "credential.input.resolved")
      await waitForEvent(socket, "message.completed", 5_000)
      const completedTurn = await waitForEvent(socket, "turn.completed", 5_000)

      const workspacePath = primaryWorkspace.path as string
      const envText = fs.readFileSync(path.join(workspacePath, ".socrates", ".env"), "utf8")
      const configText = fs.readFileSync(path.join(workspacePath, ".socrates", "mcp.json"), "utf8")
      expect(envText).toContain("FIRST_TEST_KEY=first-private-value")
      expect(envText).toContain("SECOND_TEST_KEY=second-private-value")
      expect(configText).toContain("FIRST_TEST_KEY")
      expect(configText).not.toContain("first-private-value")
      expect(configText).not.toContain("secretBindings")

      const sqlite = new Database(dbPath)
      try {
        const persisted = sqlite.prepare(
          `SELECT
             (SELECT group_concat(arguments_json, '') FROM tool_calls WHERE turn_id = ?) AS tool_args,
             (SELECT group_concat(payload_json, '') FROM events WHERE turn_id = ?) AS events,
             (SELECT group_concat(request_json || COALESCE(response_json, ''), '') FROM model_calls WHERE turn_id = ?) AS model_calls`,
        ).get(completedTurn.payload.turnId, completedTurn.payload.turnId, completedTurn.payload.turnId) as {
          tool_args: string
          events: string
          model_calls: string
        }
        const persistedJson = `${persisted.tool_args}${persisted.events}${persisted.model_calls}`
        expect(persistedJson).not.toContain("first-private-value")
        expect(persistedJson).not.toContain("second-private-value")
      } finally {
        sqlite.close()
      }
    } finally {
      socket.close()
    }
  })

  it("persists verified edit hashes in tool history and file operations", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath, createVerifiedEditAgent())
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    fs.writeFileSync(path.join(primaryWorkspace.path ?? "", "README.md"), "hello old world")
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Edit README", { approvalMode: "approve_all" }))
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{
        toolRuns: Array<{
          toolCallId: string
          providerToolCallId?: string
          fileOperations?: Array<{ path: string; contentHashBefore?: string; contentHashAfter?: string; verification?: string }>
        }>
      }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        const fileOperation = body.data.toolRuns.find((run) => run.providerToolCallId === "tcall_verified_edit")?.fileOperations?.[0]
        expect(fileOperation).toMatchObject({ path: "README.md", verification: "verified" })
        expect(fileOperation?.contentHashBefore).toMatch(/^[a-f0-9]{64}$/)
        expect(fileOperation?.contentHashAfter).toMatch(/^[a-f0-9]{64}$/)
      }

      const sqlite = new Database(dbPath)
      try {
        const row = sqlite
          .prepare(
            "SELECT f.content_hash_before, f.content_hash_after, f.metadata_json FROM file_operations f JOIN tool_calls t ON t.id = f.tool_call_id WHERE t.provider_tool_call_id = ?",
          )
          .get("tcall_verified_edit") as { content_hash_before?: string; content_hash_after?: string; metadata_json?: string } | undefined
        expect(row?.content_hash_before).toMatch(/^[a-f0-9]{64}$/)
        expect(row?.content_hash_after).toMatch(/^[a-f0-9]{64}$/)
        expect(row?.metadata_json).toContain("verified")
      } finally {
        sqlite.close()
      }
      expect(fs.readFileSync(path.join(primaryWorkspace.path ?? "", "README.md"), "utf8")).toBe("hello new world")
    } finally {
      socket.close()
    }
  })

  it("uses active-turn freshness for apply_patch after reading the target", async () => {
    const app = await buildTestServer(tempDbPath(), createVerifiedPatchAgent())
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    fs.writeFileSync(path.join(primaryWorkspace.path ?? "", "README.md"), "hello old world\n")
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Patch README", { approvalMode: "approve_all" }))
      const patchCompleted = await waitForToolCompletedByProviderId(socket, "tcall_verified_patch")
      expect(patchCompleted.payload.providerToolCallId).toBe("tcall_verified_patch")
      await waitForEvent(socket, "message.completed")
      await waitForEvent(socket, "turn.completed")

      expect(fs.readFileSync(path.join(primaryWorkspace.path ?? "", "README.md"), "utf8")).toBe("hello patched world\n")
    } finally {
      socket.close()
    }
  })

  it("surfaces stale edit verification failures as recoverable tool errors", async () => {
    const app = await buildTestServer(tempDbPath(), createStaleEditAgent())
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    fs.writeFileSync(path.join(primaryWorkspace.path ?? "", "README.md"), "hello old world")
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Overwrite README", { approvalMode: "approve_all" }))
      const failed = await waitForEvent(socket, "tool.call.failed")
      expect(failed.payload.error.code).toBe("edit_stale_content")
      expect(failed.payload.error.recoverable).toBe(true)
      expect(fs.readFileSync(path.join(primaryWorkspace.path ?? "", "README.md"), "utf8")).toBe("hello old world")
    } finally {
      socket.close()
    }
  })

  it("keeps an active turn running when the original WebSocket disconnects and replays it to a new subscriber", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath, createReconnectStreamingAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const firstSocket = await connectWebSocket(app)
    let secondSocket: WebSocket | undefined
    try {
      await waitForEvent(firstSocket, "connection.ready")
      sendCommand(firstSocket, chatMessageCommand(project.id, conversation.id, "Reconnect while streaming"))

      const started = await waitForEvent(firstSocket, "turn.started")
      const firstDelta = await waitForEvent(firstSocket, "agent.answer.delta")
      expect(firstDelta.payload.text).toBe("Part one.")
      firstSocket.close()

      secondSocket = await connectWebSocket(app)
      await waitForEvent(secondSocket, "connection.ready")
      sendCommand(secondSocket, chatSubscribeCommand(project.id, conversation.id))

      const replayedDelta = await waitForEvent(secondSocket, "agent.answer.delta")
      expect(replayedDelta.payload.text).toBe("Part one.")
      const completed = await waitForEvent(secondSocket, "turn.completed")
      expect(completed.payload.turnId).toBe(started.payload.turnId)

      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/conversations/${conversation.id}`,
      })
      const body = parseResponse<{ messages: Message[] }>(response.payload)
      expect(body.ok).toBe(true)
      if (body.ok) {
        expect(body.data.messages.find((message) => message.role === "assistant")?.content).toBe("Part one. Part two.")
      }
    } finally {
      firstSocket.close()
      secondSocket?.close()
    }
  })

  it("allows different conversations to stream concurrently", async () => {
    const app = await buildTestServer(tempDbPath(), createSlowStreamingAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const firstConversation = await createConversation(app, project.id)
    const secondConversation = await createConversation(app, project.id)
    const firstSocket = await connectWebSocket(app)
    const secondSocket = await connectWebSocket(app)
    try {
      await waitForEvent(firstSocket, "connection.ready")
      await waitForEvent(secondSocket, "connection.ready")

      sendCommand(firstSocket, chatMessageCommand(project.id, firstConversation.id, "Start first stream"))
      const firstStarted = await waitForEvent(firstSocket, "turn.started")
      expect(firstStarted.conversationId).toBe(firstConversation.id)
      expect((await waitForEvent(firstSocket, "agent.answer.delta")).payload.text).toBe("Started.")

      sendCommand(secondSocket, chatMessageCommand(project.id, secondConversation.id, "Start second stream"))
      const secondStarted = await waitForEvent(secondSocket, "turn.started")
      expect(secondStarted.conversationId).toBe(secondConversation.id)
      expect(secondStarted.payload.turnId).not.toBe(firstStarted.payload.turnId)

      const firstCompleted = await waitForEvent(firstSocket, "turn.completed")
      const secondCompleted = await waitForEvent(secondSocket, "turn.completed")
      expect(firstCompleted.conversationId).toBe(firstConversation.id)
      expect(secondCompleted.conversationId).toBe(secondConversation.id)
    } finally {
      firstSocket.close()
      secondSocket.close()
    }
  })

  it("serializes mutating terminal commands across concurrent conversations in the same workspace", async () => {
    const app = await buildTestServer(tempDbPath(), createConcurrentWorkspaceMutationAgent())
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const firstConversation = await createConversation(app, project.id)
    const secondConversation = await createConversation(app, project.id)
    const firstSocket = await connectWebSocket(app)
    const secondSocket = await connectWebSocket(app)
    const racePath = path.join(primaryWorkspace.path ?? "", "race.txt")
    try {
      await waitForEvent(firstSocket, "connection.ready")
      await waitForEvent(secondSocket, "connection.ready")

      sendCommand(firstSocket, chatMessageCommandWithRuntime(project.id, firstConversation.id, "slow workspace mutation", { approvalMode: "approve_all" }))
      await waitForEvent(firstSocket, "tool.call.started")

      sendCommand(secondSocket, chatMessageCommandWithRuntime(project.id, secondConversation.id, "fast workspace mutation", { approvalMode: "approve_all" }))

      const firstToolCompleted = await waitForToolCompletedByProviderId(firstSocket, "tcall_slow_workspace_mutation")
      const secondToolCompleted = await waitForToolCompletedByProviderId(secondSocket, "tcall_fast_workspace_mutation")
      expect(firstToolCompleted.type).toBe("tool.call.completed")
      expect(secondToolCompleted.type).toBe("tool.call.completed")
      expect(firstToolCompleted.payload.providerToolCallId).toBe("tcall_slow_workspace_mutation")
      expect(secondToolCompleted.payload.providerToolCallId).toBe("tcall_fast_workspace_mutation")

      await waitForEvent(firstSocket, "turn.completed")
      await waitForEvent(secondSocket, "turn.completed")

      expect(fs.readFileSync(racePath, "utf8")).toBe("first\nsecond\n")
    } finally {
      firstSocket.close()
      secondSocket.close()
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

  it("emits turn.failed and does not persist an assistant message when the provider returns empty text", async () => {
    const dbPath = tempDbPath()
    const app = await buildTestServer(dbPath, createEmptyResponseAgent())
    await onboard(app)
    const { project } = await createProject(app)
    const conversation = await createConversation(app, project.id)
    const socket = await connectWebSocket(app)
    try {
      await waitForEvent(socket, "connection.ready")
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Please answer"))
      const started = await waitForEvent(socket, "turn.started")

      const failed = await waitForEvent(socket, "turn.failed")
      expect(failed.payload.turnId).toBe(started.payload.turnId)
      expect(failed.payload.error.code).toBe("model_empty_response")

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
      expect(latestUserContent(secondRequest.messages)).toBe("Continue from that")
      expect(secondRequest.messages.some((message) => message.role === "developer" && message.content.includes("runtime_socrates_docs_preflight"))).toBe(true)
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
        const tool = sqlite.prepare("SELECT status FROM tool_calls WHERE turn_id = ? AND provider_tool_call_id = ?").get(started.payload.turnId, "tcall_waiting_bash") as {
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
