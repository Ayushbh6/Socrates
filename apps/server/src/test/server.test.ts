import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import type {
  ApiResponse,
  Conversation,
  GetProviderCredentialsStatusResponse,
  Message,
  MessageAttachment,
  Project,
  ProjectEmbeddingStatus,
  ProjectInstructions,
  ProjectResource,
  ProjectWorkspace,
  ServerEvent,
  ChatCompaction,
  SkillSummary,
  User,
} from "@socrates/contracts"
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

const buildTestServer = async (
  dbPath = tempDbPath(),
  agent = createTestAgent(),
  options: { socratesHome?: string; titleProvider?: ModelProvider | false } = {},
): Promise<TestServer> => {
  const app = await buildServer({ dbPath, agent, ...options })
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
  throw new Error("Timed out waiting for embedding status")
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
      const isSlow = serializedMessages.includes("slow workspace mutation")
      const isFast = serializedMessages.includes("fast workspace mutation")
      if (!hasMutationToolResult && (isSlow || isFast)) {
      const script = isSlow
        ? "setTimeout(() => { require('fs').appendFileSync('race.txt', 'first\\n') }, 250); setTimeout(() => process.exit(0), 300)"
        : "require('fs').appendFileSync('race.txt', 'second\\n')"
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
        const setupCommand = process.platform === "win32" ? "New-Item -ItemType Directory -Force nested | Out-Null; Set-Location nested; Get-Location" : "mkdir -p nested && cd nested && pwd"
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
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_break_shell",
            toolName: "bash",
            input: { command: "cd /Users/ayush/Test && python3 -m venv venv" },
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
  let step = 0
  const command = `node -e "console.log('terminal-ready'); setInterval(() => console.log('terminal-tick'), 250)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream(request) {
      step += 1
      requests.push(request)
      if (step === 1) {
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
      if (step === 3) {
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
      yield { type: "model.answer.delta", text: "Terminal observed." }
      yield { type: "model.completed", usage: { inputTokens: 4, outputTokens: 3, totalTokens: 7 } }
    },
  }
  return new SocratesAgent(provider)
}

const createUntargetedTerminalStopAgent = (): SocratesAgent => {
  let step = 0
  const command = `node -e "console.log('solo-ready'); setInterval(() => console.log('solo-tick'), 250)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
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
      if (step === 2) {
        yield { type: "model.answer.delta", text: "Solo Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (step === 3) {
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
      if (step === 4) {
        yield { type: "model.answer.delta", text: "Solo Terminal stopped." }
        yield { type: "model.completed" }
        return
      }
    },
  }
  return new SocratesAgent(provider)
}

const createAmbiguousTerminalStopAgent = (): SocratesAgent => {
  let step = 0
  const command = `node -e "console.log('ambiguous-ready'); setInterval(() => console.log('ambiguous-tick'), 250)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
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
      if (step === 2) {
        yield { type: "model.answer.delta", text: "Alpha Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (step === 3) {
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
      if (step === 4) {
        yield { type: "model.answer.delta", text: "Beta Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (step === 5) {
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
      if (step === 6) {
        yield { type: "model.answer.delta", text: "Terminal target is ambiguous." }
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
    async *stream() {
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: "tcall_interactive_terminal_start",
          toolName: "bash",
          input: { operation: "start", command, name: "interactive-test" },
        },
      }
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
    async *stream() {
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: "tcall_shutdown_cleanup_start",
          toolName: "bash",
          input: { operation: "start", command, name: "shutdown-cleanup-test" },
        },
      }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createTextInputTerminalAgent = (): SocratesAgent => {
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
    async *stream() {
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: "tcall_text_input_terminal_start",
          toolName: "bash",
          input: { operation: "start", command, name: "text-input-test" },
        },
      }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createPrematureInteractiveStopAgent = (): SocratesAgent => {
  let step = 0
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
    async *stream() {
      step += 1
      if (step === 1) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_premature_stop_start",
            toolName: "bash",
            input: { operation: "start", command, name: "premature-stop-test" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      if (step === 2) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId: "tcall_premature_stop",
            toolName: "bash",
            input: { operation: "stop", target: "premature-stop-test" },
          },
        }
        yield { type: "model.completed" }
        return
      }
      yield { type: "model.answer.delta", text: "Terminal is waiting for user input." }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createTerminalOutputAgent = (): SocratesAgent => {
  let step = 0
  const command = `node -e "console.log('tail-ready'); setInterval(() => {}, 1000)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
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
      if (step === 2) {
        yield { type: "model.answer.delta", text: "Tail Terminal started." }
        yield { type: "model.completed" }
        return
      }
      if (step === 3) {
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
      yield { type: "model.answer.delta", text: "Tail output checked." }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createTerminalStopDedupAgent = (): SocratesAgent => {
  let step = 0
  const command = `for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo "tick-$i"; sleep 0.1; done`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      if (step === 1) {
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
      if (step === 2) {
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
      if (step === 3) {
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
      yield { type: "model.answer.delta", text: "Dedup checked." }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createFiniteTerminalAgent = (): SocratesAgent => {
  const command = nodeCommand("setTimeout(() => { console.log('finite-done') }, 50)")
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      yield {
        type: "model.tool_call.completed",
        toolCall: {
          toolCallId: "tcall_finite_start",
          toolName: "bash",
          input: { operation: "start", command, name: "finite-server" },
        },
      }
      yield { type: "model.completed" }
    },
  }
  return new SocratesAgent(provider)
}

const createDuplicateTerminalStartAgent = (): SocratesAgent => {
  let step = 0
  const command = `node -e "console.log('reuse-ready'); setInterval(() => {}, 1000)"`
  const provider: ConstructorParameters<typeof SocratesAgent>[0] = {
    countTokens: fakeCountTokens,
    async *stream() {
      step += 1
      const toolCallId = step === 1 ? "tcall_reuse_start_first" : "tcall_reuse_start_second"
      if (step === 1 || step === 2) {
        yield {
          type: "model.tool_call.completed",
          toolCall: {
            toolCallId,
            toolName: "bash",
            input: { operation: "start", command, name: "reuse-server" },
          },
        }
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
    const app = await buildTestServer()
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)

    const firstResponse = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/skills/build`,
      payload: { request: "Create a memory review skill for this project." },
    })
    const firstBody = parseResponse<{ skill: SkillSummary }>(firstResponse.payload)
    expect(firstBody.ok).toBe(true)
    if (!firstBody.ok) return
    expect(firstBody.data.skill.scope).toBe("project")
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
        expect(semantic.warnings?.join(" ")).toContain("Semantic trace retrieval is not configured")
      } finally {
        await store.close()
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
      expect(requestedTitleModels).toEqual(["meta-llama/llama-4-maverick"])

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

  it("falls back to Qwen title generation when Llama does not return a title", async () => {
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
      expect(requestedTitleModels).toEqual(["meta-llama/llama-4-maverick", "qwen/qwen3.5-flash-02-23"])
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

  it("omits chat image bytes for non-vision models", async () => {
    const requests: unknown[] = []
    const app = await buildTestServer(tempDbPath(), createCapturingAgent(requests))
    await onboard(app)
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
    expect(serialized).toContain("image attachment omitted because the selected model does not support vision")
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
      providerId: "openrouter",
      modelId: "xiaomi/mimo-v2.5-pro",
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

    const openRouterUpdateResponse = await app.inject({
      method: "PATCH",
      url: "/api/memory-agent/settings",
      payload: {
        providerId: "openrouter",
        modelId: "xiaomi/mimo-v2.5-pro",
        thinkingEnabled: true,
        enabled: true,
      },
    })
    const openRouterUpdated = parseResponse<{ settings: { providerId: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: string; enabled: boolean } }>(
      openRouterUpdateResponse.payload,
    )
    expect(openRouterUpdated.ok).toBe(true)
    if (!openRouterUpdated.ok) {
      throw new Error("Expected OpenRouter settings update success")
    }
    expect(openRouterUpdated.data.settings).toMatchObject({
      providerId: "openrouter",
      modelId: "xiaomi/mimo-v2.5-pro",
      thinkingEnabled: true,
    })
    expect(openRouterUpdated.data.settings.thinkingEffort).toBeUndefined()
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
          query: "canonical rubric exact assignment rules",
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
        query:
          "Test B: Partial failure error diagnostics. Now let me apply a 3-hunk patch where hunk 2 has a deliberately wrong anchor. I need to re-read first.",
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
        query: stalenessQuote,
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
        query: "3-hunk patch wrong anchor",
        scope: "recent_conversations",
        mode: "exact",
        role: "assistant",
      })
      expect(assistantRoleSearch.results[0]?.messageId).toBe(target.assistantMessageId)
      expect(assistantRoleSearch.appliedFilters.role).toBe("assistant")

      const userRoleSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "3-hunk patch wrong anchor",
        scope: "recent_conversations",
        mode: "exact",
        role: "user",
      })
      expect(userRoleSearch.results).toHaveLength(0)

      const assistantEntryTypeSearch = await store.retrieveToolTraces(project.id, live.id, {
        query: "3-hunk patch wrong anchor",
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

  it("creates lean Socrates memory files, exposes docs tools, and injects first-turn wake context", async () => {
    const requests: unknown[] = []
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath, createCapturingAgent(requests), { socratesHome })
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    fs.writeFileSync(path.join(primaryWorkspace.path as string, ".socrates", "MEMORY.md"), "# Project Memory\n\nDurable recall key: WAKE-LEAN-42.\n")
    fs.writeFileSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "CORE_IDEA.md"), "# Core Idea\n\nCurrent focus: lean memory architecture.\n")
    const conversation = await createConversation(app, project.id, "Memory Wake")

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
    expect(fs.existsSync(path.join(socratesHome, "operating_principles.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "user_profile.md"))).toBe(true)
    expect(fs.readFileSync(path.join(socratesHome, "identity.md"), "utf8")).toContain("user_profile.md")
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "trace_retrieve.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_docs.md"))).toBe(false)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "project_docs.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "repo_docs.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "skills.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "soul.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "tool_docs.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "trace_retrieve.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "trace_retrieve_global.md"))).toBe(false)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "tool_docs.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "skills.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "tool_usage", "memory_agent", "soul.md"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "skills"))).toBe(true)
    expect(fs.existsSync(path.join(socratesHome, "useful_patterns"))).toBe(false)
    expect(fs.existsSync(path.join(socratesHome, "projects", project.id))).toBe(false)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "MEMORY.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "skills"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "CORE_IDEA.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "REPO_NAVIGATION.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "REPO_RULES.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "CONTRACTS.md"))).toBe(true)
    expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "APP_FLOW.md"))).toBe(false)
    expect(JSON.stringify(requests[0])).toContain("<socrates_wake_context>")
    expect(JSON.stringify(requests[0])).toContain("Quiet startup map")
    expect(JSON.stringify(requests[0])).toContain("For full project notes")
    expect(JSON.stringify(requests[0])).toContain("project_docs")
    expect(JSON.stringify(requests[0])).toContain("WAKE-LEAN-42")
    expect(JSON.stringify(requests[0])).toContain("lean memory architecture")
    expect(JSON.stringify(requests[1])).toContain("Socrates State Ledger")
    expect(JSON.stringify(requests[1])).toContain("Last turn: completed")
    expect(JSON.stringify(requests[1])).toContain("Captured")

    const handle = openDatabase(dbPath)
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome })
    try {
      const listedSkills = store.runSkillsTool(project.id, { operation: "list" })
      expect(listedSkills.skills.some((skill) => skill.name === "socrates-skill-writer")).toBe(false)
      expect(() => store.runSkillsTool(project.id, { operation: "read", name: "socrates-skill-writer", scope: "builtin" })).toThrow(/Skill was not found/)
      const userProfileRead = store.runUserProfileTool(project.id, { operation: "read" })
      expect(userProfileRead.content).toContain("Root global user profile")
      const projectSkillPath = path.join(primaryWorkspace.path as string, ".socrates", "skills", "memory-review", "SKILL.md")
      fs.mkdirSync(path.dirname(projectSkillPath), { recursive: true })
      fs.writeFileSync(projectSkillPath, "---\nname: memory-review\ndescription: Use when reviewing memory changes.\n---\n\n# Memory Review\n")
      const projectSkills = store.runSkillsTool(project.id, { operation: "list", scope: "project" })
      expect(projectSkills.skills.some((skill) => skill.name === "memory-review")).toBe(true)
      const skillRead = store.runSkillsTool(project.id, { operation: "read", name: "memory-review", scope: "project" })
      expect(skillRead.content).toContain("Memory Review")
      expect(() => store.runSkillsTool(project.id, { operation: "read", name: "memory-review", scope: "project", path: "../outside.md" })).toThrow(/Path must stay inside/)
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
      expect(() =>
        store.runToolDocsTool(project.id, {
          operation: "read",
          path: "tool_usage/memory_agent/edit_files.md",
          charLimit: 12_000,
        }),
      ).toThrow(/not visible to this agent/)
      const notesRead = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, { operation: "read", area: "notes" })
      expect(notesRead.content).toContain("PROJECT_NOTES")
      const notesPatch = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, {
        operation: "edit",
        area: "notes",
        editMode: "append",
        text: "- Memory tool smoke note.",
      })
      expect(notesPatch.changed).toBe(true)
      expect(fs.readFileSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"), "utf8")).toContain("Memory tool smoke note")
      store.recordProjectStateLedgerTurn(project.id, conversation.id, "synthetic_cancelled_turn", "cancelled", "Cancelled after reading evidence.")
      const notesAfterCancelledLedger = fs.readFileSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"), "utf8")
      expect(notesAfterCancelledLedger.match(/<!-- socrates-state-ledger:start -->/g)).toHaveLength(1)
      expect(notesAfterCancelledLedger).toContain("Last turn: cancelled")
      expect(notesAfterCancelledLedger).toContain("Cancelled after reading evidence.")
      const memoryRead = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, { operation: "read", area: "memory" })
      expect(memoryRead.content).toContain("WAKE-LEAN-42")
      const memoryReplace = store.runProjectDocsTool(project.id, primaryWorkspace.path as string, {
        operation: "edit",
        area: "memory",
        editMode: "replace",
        oldText: "Durable recall key: WAKE-LEAN-42.",
        newText: "Durable recall key: WAKE-LEAN-43.",
      })
      expect(memoryReplace.changed).toBe(true)
      const repoDocsIndex = store.runRepoDocsTool(project.id, primaryWorkspace.path as string, { operation: "read" })
      expect(repoDocsIndex.paths).toContain(".socrates/repo_docs/REPO_RULES.md")
      expect(repoDocsIndex.paths).toContain(".socrates/repo_docs/CONTRACTS.md")
      const repoDocsSearch = store.runRepoDocsTool(project.id, primaryWorkspace.path as string, { operation: "search", query: "durable", path: "REPO_RULES.md" })
      expect(repoDocsSearch.matches?.[0]?.path).toBe(".socrates/repo_docs/REPO_RULES.md")
      const repoDocsPatch = store.runRepoDocsTool(project.id, primaryWorkspace.path as string, {
        operation: "edit",
        path: "REPO_RULES.md",
        oldText: "Keep it short, current, and practical.",
        newText: "Keep it short, current, practical, and easy for future agents to trust.",
      })
      expect(repoDocsPatch.changed).toBe(true)
      expect(fs.readFileSync(path.join(primaryWorkspace.path as string, ".socrates", "repo_docs", "REPO_RULES.md"), "utf8")).toContain("future agents")
      expect(() =>
        store.runRepoDocsTool(project.id, primaryWorkspace.path as string, {
          operation: "edit",
          path: "REPO_RULES.md",
          oldText: "- ",
          newText: "- changed ",
        }),
      ).toThrow(/oldText matched more than once/)
    } finally {
      await store.close()
    }
  })

  it("updates global skills and tool usage with the configured memory agent model", async () => {
    const dbPath = tempDbPath()
    const socratesHome = tempDir()
    const app = await buildTestServer(dbPath)
    await onboard(app)
    const { project, primaryWorkspace } = await createProject(app)
    const conversation = await createConversation(app, project.id, "Memory Source")
    const handle = openDatabase(dbPath)
    const modelRequests: Array<{ providerId: string; modelId: string; thinkingEnabled: boolean; thinkingEffort?: string }> = []
    let callIndex = 0
    const memoryProvider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        modelRequests.push({
          providerId: request.providerId,
          modelId: request.modelId,
          thinkingEnabled: request.runtimeConfig.thinkingEnabled,
          ...(request.runtimeConfig.thinkingEffort ? { thinkingEffort: request.runtimeConfig.thinkingEffort } : {}),
        })
        callIndex += 1
        if (callIndex === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "memory_edit_skill",
              toolName: "edit_files",
              input: {
                target: "skill",
                name: "general",
                editMode: "create",
                newText:
                  "---\nname: general\ndescription: Configured memory worker test skill.\n---\n\n# General\n\nConfigured memory worker updated this global skill.\n",
                rationale: "Test skill creation.",
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
                oldText: "- Unknown until repeated or explicit evidence justifies a durable note.",
                newText:
                  "- Unknown until repeated or explicit evidence justifies a durable note.\n- Configured memory worker can update narrow user profile notes.",
                rationale: "Test scoped user profile update.",
              },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield {
          type: "model.answer.delta",
          text: "## Investigated\nInspected configured memory worker test evidence.\n\n## Changed\nUpdated tool guidance.\n\n## Skipped\nSkill creation is reserved for Memory Center Skills +.\n\n## Blocked\nNone.",
        }
        yield { type: "model.completed" }
      },
    }
    const store = new SocratesStore(handle, undefined, undefined, { socratesHome, memoryProvider })
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      for (let index = 0; index < 4; index += 1) {
        const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, `Memory user message ${index + 1}`, "Memory assistant answer", nowIso())
        insertTurnCompletedEvent(handle.sqlite, { projectId: project.id, conversationId: conversation.id, sessionId, turnId: turn.turnId })
      }
      await store.runGlobalMemoryAgent("manual")
      const usefulPatternFile = path.join(socratesHome, "skills", "general", "SKILL.md")
      const toolUsageFile = path.join(socratesHome, "tool_usage", "read_search.md")
      const userProfileFile = path.join(socratesHome, "user_profile.md")
      await waitForFileText(toolUsageFile, "Configured memory worker can refine global tool guidance")
      await waitForFileText(userProfileFile, "Configured memory worker can update narrow user profile notes")
      expect(fs.existsSync(usefulPatternFile)).toBe(false)
      const rejectedSkill = handle.sqlite.prepare("SELECT status, error FROM memory_agent_actions WHERE target_kind = 'skills'").get() as { status: string; error: string }
      expect(rejectedSkill.status).toBe("rejected")
      expect(rejectedSkill.error).toContain("cannot create or update skills")
      const profileAction = handle.sqlite.prepare("SELECT status FROM memory_agent_actions WHERE target_kind = 'user_profile'").get() as { status: string }
      expect(profileAction.status).toBe("applied")
      expect(modelRequests[0]).toEqual({ providerId: "openrouter", modelId: "xiaomi/mimo-v2.5-pro", thinkingEnabled: false })
      expect(fs.existsSync(path.join(socratesHome, "projects", project.id, "diary"))).toBe(false)
      expect(fs.existsSync(path.join(primaryWorkspace.path as string, ".socrates", "PROJECT_NOTES.md"))).toBe(true)
    } finally {
      await store.close()
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
      expect(toolNames).toEqual(expect.arrayContaining(["trace_retrieve", "projects", "tool_docs", "skills", "soul", "user_profile", "edit_files"]))
      expect(toolNames).not.toContain("bash")
      expect(toolNames).not.toContain("edit")
      expect(JSON.stringify(requests[1]?.messages)).toContain("memory-agent trace marker")
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
      expect(seenPrompts[0]).toContain("No chatty narration, nested subheaders, JSON, or patch proposals")
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
        query: "Screenshot 2026-05-31 1.16.46 PM.png",
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

  it("uses semantic retrieval for active provider rows", async () => {
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
        .run(createId("temb"), now, now, now, target.userMessageId)
      const status = store.getProjectEmbeddingStatus(project.id)
      expect(status.indexedDocuments).toBeGreaterThan(0)

      const semantic = await store.retrieveToolTraces(project.id, conversation.id, {
        query: "BLUE-LANTERN-42",
        mode: "semantic",
        scope: "current_conversation",
        include: ["messages"],
      })
      expect(semantic.warnings?.join(" ") ?? "").not.toContain("not configured")
      expect(semantic.results[0]?.entryType).toBe("user_query")
      expect(semantic.results[0]?.messageId).toBe(target.userMessageId)

      const combined = await store.retrieveToolTraces(project.id, conversation.id, {
        query: "fuzzy blue memory",
        mode: "combined",
        scope: "current_conversation",
        include: ["messages"],
      })
      expect(combined.warnings?.join(" ") ?? "").not.toContain("not configured")
      expect(combined.appliedFilters.mode).toBe("combined")
      expect(combined.results[0]?.entryType).toBe("user_query")
      expect(combined.results[0]?.messageId).toBe(target.userMessageId)

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
        scope: "current_conversation",
        include: ["messages"],
      })
      expect(JSON.stringify(stillSemantic.results[0])).toContain(target.userMessageId)
    } finally {
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
    const store = new SocratesStore(handle, provider)
    try {
      const sessionId = insertTestSession(handle.sqlite, project.id, conversation.id)
      const turn = insertCompletedTestTurn(handle.sqlite, conversation.id, sessionId, "A long source should retry cleanly.", "Indexed.", nowIso())
      store.indexTurnTraceDocuments(project.id, conversation.id, turn.turnId)

      await store.configureProjectEmbeddings(project.id, {
        providerId: "ollama",
        modelId: "embeddinggemma",
        credentialSource: "none",
      })
      const failed = await waitForProjectEmbeddingStatus(store, project.id, (status) => Boolean(status.lastError))
      expect(failed.lastError).toContain("maximum input length")

      store.reindexProjectEmbeddings(project.id)
      const completed = await waitForProjectEmbeddingStatus(
        store,
        project.id,
        (status) => status.totalDocuments > 0 && status.indexedDocuments === status.totalDocuments && !status.lastError,
      )
      expect(completed.pendingDocuments).toBe(0)
      expect(completed.lastError).toBeUndefined()

      handle.sqlite.prepare("UPDATE project_embedding_configs SET last_error = ? WHERE project_id = ? AND active = 1").run(failed.lastError, project.id)
      expect(store.getProjectEmbeddingStatus(project.id).lastError).toBeUndefined()
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
      expect(request.system).toContain("Name: Context User")
      expect(request.system).toContain("Name: Context Project")
      expect(request.system).toContain("A test project")
      expect(request.system).toContain("Always answer from the project instructions.")
      expect(request.system).toContain("Workspace Terminal commands run with a sanitized user-workspace environment.")
      expect(request.system).toContain("NODE_ENV")
      expect(request.system).toContain("CI are not inherited")
      expect(request.system).toContain("Semantic retrieval: not configured.")
      expect(request.system).toContain("Do not claim semantic retrieval was used.")
      expect(latestUserContent(request.messages)).toBe("Use the context")
      expect(request.messages.some((message) => message.role === "developer" && message.content?.includes("runtime_socrates_docs_preflight"))).toBe(true)
    } finally {
      socket.close()
    }
  })

  it("injects ready semantic retrieval status into the agent prompt", async () => {
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
      expect(request.system).toContain("Semantic retrieval: ready")
      expect(request.system).toContain("Provider/model: ollama/embeddinggemma")
      expect(request.system).toContain("indexed=")
      expect(request.system).toContain('mode="combined"')
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
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "tool.call.completed")
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
          expect(body.data.toolRuns).toHaveLength(2)
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

      await waitForEvent(socket, "tool.call.completed")
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

      const nextTurnRequest = requests.at(-1) as { system?: string }
      expect(nextTurnRequest.system).not.toContain(startedTerminal.payload.terminalId)
      expect(nextTurnRequest.system).toContain("name: server-test")

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Stop terminal by name"))
      const stoppedByTool = await waitForEvent(socket, "terminal.stopped")
      expect(stoppedByTool.payload.terminalId).toBe(startedTerminal.payload.terminalId)
      await waitForEvent(socket, "tool.call.completed")
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
      await waitForEvent(socket, "tool.call.completed")
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
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "turn.completed")

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Stop the only terminal"))
      const stoppedTerminal = await waitForEvent(socket, "terminal.stopped")
      expect(stoppedTerminal.payload.terminalId).toBe(startedTerminal.payload.terminalId)
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "turn.completed")
    } finally {
      socket.close()
    }
  })

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
      const startCompleted = await waitForEvent(socket, "tool.call.completed")
      expect(startCompleted.payload.resultPreview).toContain("tail-ready")
      await waitForEvent(socket, "turn.completed")

      await delay(700)
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Read tail terminal output"))
      const outputCompleted = await waitForEvent(socket, "tool.call.completed")
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
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "turn.completed")

      await delay(450)
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Read dedup output"))
      const outputCompleted = await waitForEvent(socket, "tool.call.completed")
      expect(outputCompleted.payload.providerToolCallId).toBe("tcall_dedup_output")
      await waitForEvent(socket, "turn.completed")

      await delay(250)
      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Stop dedup terminal"))
      const stopped = await waitForEvent(socket, "terminal.stopped")
      expect(stopped.payload.terminalId).toBe(startedTerminal.payload.terminalId)
      const stopCompleted = await waitForEvent(socket, "tool.call.completed")
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
        expect(new Set(terminalLines).size).toBe(terminalLines.length)
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
      const toolResult = await waitForToolResult(socket)
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
      const firstCompleted = await waitForEvent(socket, "tool.call.completed")
      const secondCompleted = await waitForEvent(socket, "tool.call.completed")
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
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "turn.completed")

      sendCommand(socket, chatMessageCommandWithRuntime(project.id, conversation.id, "Start beta", { approvalMode: "approve_all" }))
      const beta = await waitForEvent(socket, "terminal.started")
      startedTerminalIds.push(beta.payload.terminalId)
      expect(beta.payload.name).toBe("beta-server")
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "turn.completed")

      sendCommand(socket, chatMessageCommand(project.id, conversation.id, "Stop without target"))
      const failed = await waitForEvent(socket, "tool.call.failed")
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

  it("accepts user text input and returns the interactive terminal response", async () => {
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
      expect(inputRequested.payload.prompt).toContain("What is your name?")

      sendCommand(socket, {
        id: createId("evt"),
        type: "terminal.input",
        schemaVersion: 1,
        timestamp: nowIso(),
        projectId: project.id,
        conversationId: conversation.id,
        actor: { type: "user" },
        payload: { terminalId: inputRequested.payload.terminalId, data: "Ayush\n" },
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
        expect(terminal?.output.stdout).toContain("What is your name?")
        expect(terminal?.output.stdout).toContain("Hello, Ayush!")
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

      await waitForEvent(socket, "tool.call.completed")
      const failed = await waitForEvent(socket, "tool.call.failed")
      expect(failed.payload.error.code).toBe("terminal_awaiting_user_input")
      expect(failed.payload.error.recoverable).toBe(true)
      await waitForEvent(socket, "turn.completed")

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
      const failed = await waitForEvent(socket, "tool.call.failed")
      const completed = await waitForEvent(socket, "tool.call.completed")
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
        expect(details.cdTarget).toBe("/Users/ayush/Test")
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
      await waitForEvent(socket, "tool.call.completed")
      await waitForEvent(socket, "tool.call.completed")
      const patchCompleted = await waitForEvent(socket, "tool.call.completed")
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

      const firstToolCompleted = await waitForToolResult(firstSocket)
      const secondToolCompleted = await waitForToolResult(secondSocket)
      if (firstToolCompleted.type === "tool.call.failed") {
        throw new Error(`first workspace mutation failed: ${firstToolCompleted.payload.error.message}`)
      }
      if (secondToolCompleted.type === "tool.call.failed") {
        throw new Error(`second workspace mutation failed: ${secondToolCompleted.payload.error.message}`)
      }
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
