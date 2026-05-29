import { describe, expect, it } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SocratesAgent, createDefaultToolRegistry, type SocratesAgentEvent, type ToolExecutors } from "../index"
import type { ModelEvent, ModelProvider } from "@socrates/providers"
import { bashTool } from "../tools/bashTool"

describe("SocratesAgent", () => {
  it("streams through the provider with Socrates prompt and history", async () => {
    const events: ModelEvent[] = [{ type: "model.answer.delta", text: "Hello" }, { type: "model.completed" }]
    const seen: unknown[] = []
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        seen.push(request)
        yield* events
      },
    }

    const agent = new SocratesAgent(provider)
    const streamed: SocratesAgentEvent[] = []
    for await (const event of agent.streamTurn({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "read_only",
      },
      messages: [{ role: "user", content: "Hi" }],
    })) {
      streamed.push(event)
    }

    expect(streamed).toEqual(events.map((event) => ({ ...event, stepIndex: 0 })))
    const requestJson = JSON.stringify(seen[0])
    expect(requestJson).toContain("You are Socrates")
    expect(requestJson).toContain("Hi")
    expect(requestJson).toContain("Socrates tracks freshness from read results")
    expect(requestJson).toContain("product/user-facing copy should call it Terminal")
    expect(requestJson).toContain("set regex=true")
    expect(requestJson).toContain("compare the reported file and line with the current file contents")
    expect(requestJson).toContain("distinguish credential/config mismatches from service availability")
  })

  it("exposes the base tool set", () => {
    const tools = createDefaultToolRegistry().modelDefinitions()
    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "search",
      "edit",
      "apply_patch",
      "bash",
      "trace_retrieve",
      "list_project_resources",
      "mcp_registry",
    ])
    expect(tools.find((tool) => tool.name === "edit")?.inputSchema.safeParse({ path: "README.md", content: "new" }).success).toBe(true)
    expect(
      tools
        .find((tool) => tool.name === "edit")
        ?.inputSchema.safeParse({ path: "README.md", content: "new", oldString: "old", newString: "new" }).success,
    ).toBe(false)
  })

  it("streams blocking compaction start before the compressor finishes and model call begins", async () => {
    let releaseCompressor: (() => void) | undefined
    const compressorReleased = new Promise<void>((resolve) => {
      releaseCompressor = resolve
    })
    let countCalls = 0
    let appModelStarted = false
    const provider: ModelProvider = {
      countTokens: async (request) => {
        countCalls += 1
        const inputTokens = countCalls === 1 ? 20 : 5
        return {
          providerId: request.providerId,
          modelId: request.modelId,
          inputTokens,
          baseTokens: inputTokens,
          method: "local_tiktoken",
          safetyMarginPercent: 0,
        }
      },
      async *stream(request) {
        if (request.modelId === "deepseek/deepseek-v4-flash") {
          await compressorReleased
          yield {
            type: "model.answer.delta",
            text: JSON.stringify({
              goals: ["stream lifecycle"],
              currentTaskState: {},
              decisions: [],
              protectedAnchors: [],
              filesAndArtifacts: [],
              failuresAndBlockers: [],
              openTasks: [],
              sourceHandles: [{ messageId: "msg_1" }],
            }),
          }
          yield { type: "model.completed" }
          return
        }
        appModelStarted = true
        yield { type: "model.completed" }
      },
    }

    const agent = new SocratesAgent(provider)
    const iterator = agent
      .streamTurn({
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        runtimeConfig: {
          providerId: "openai",
          modelId: "gpt-5.4-mini",
          thinkingEnabled: false,
          thinkingEffort: "none",
          approvalMode: "manual",
          sandboxMode: "read_only",
        },
        messages: [{ role: "user", content: "Large history", id: "msg_1", turnId: "turn_1" }],
        contextCompression: {
          enabled: true,
          thresholds: { synchronousTokens: 10, hardCapTokens: 20_000 },
        },
      })
      [Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.value?.type).toBe("context.compaction.started")
    expect(appModelStarted).toBe(false)

    releaseCompressor?.()

    const events: SocratesAgentEvent[] = [first.value as SocratesAgentEvent]
    for (;;) {
      const next = await iterator.next()
      if (next.done) {
        break
      }
      events.push(next.value)
    }

    const eventTypes = events.map((event) => event.type)
    expect(eventTypes).toEqual(["context.compaction.started", "context.compaction.completed", "model.completed"])
    expect(appModelStarted).toBe(true)
  })

  it("executes current-turn tool calls and feeds results into a final model step", async () => {
    const seenMessages: unknown[] = []
    const countRequests: CountedRequest[] = []
    let calls = 0
    const provider: ModelProvider = {
      countTokens: async (request) => {
        countRequests.push(snapshotCountRequest(request))
        return fakeCountTokens(request)
      },
      async *stream(request) {
        seenMessages.push(request.messages)
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_read_1",
              toolName: "read",
              input: { path: "README.md" },
              providerMetadata: { google: { thoughtSignature: "sig_1" } },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Read it." }
        yield { type: "model.completed" }
      },
    }

    const executors: ToolExecutors = {
      read: async () => ({
        path: "README.md",
        kind: "file",
        content: "Socrates",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 8 },
      }),
      search: async () => ({ mode: "files", query: "", matches: [], totalMatches: 0, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
      edit: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
      apply_patch: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
      bash: async () => bashOk(),
      trace_retrieve: async () => ({
        results: [],
        totalMatches: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
        appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined" },
      }),
      list_project_resources: async () => ({
        resources: [],
        summary: "Listed 0 project resources.",
        totalResources: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
      }),
    }

    const streamed: SocratesAgentEvent[] = []
    const agent = new SocratesAgent(provider)
    for await (const event of agent.streamTurn({
      projectId: "proj_1",
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Read README" }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      createModelCall: () => `mcall_${calls}`,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      streamed.push(event)
    }

    expect(streamed.some((event) => event.type === "tool.call.completed")).toBe(true)
    expect(streamed.some((event) => event.type === "model.answer.delta")).toBe(true)
    expect(countRequests).toHaveLength(2)
    expect(countRequests[0]?.toolCount).toBe(8)
    expect(countRequests[1]?.toolCount).toBe(8)
    expect(JSON.stringify(countRequests[0]?.messages)).not.toContain("tool-result")
    expect(JSON.stringify(countRequests[1]?.messages)).toContain("tool-result")
    expect(JSON.stringify(seenMessages.at(-1))).toContain("tool-result")
    expect(JSON.stringify(seenMessages.at(-1))).toContain("thoughtSignature")
  })

  it("uses internal tool run ids while preserving repeated provider ids in model messages", async () => {
    const seenMessages: unknown[] = []
    let calls = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        seenMessages.push(request.messages)
        calls += 1
        if (calls <= 2) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "functions.read:0",
              toolName: "read",
              input: { path: `file-${calls}.txt` },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Done." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.read = async (input) => ({
      path: input.path,
      kind: "file",
      content: input.path,
      truncation: { truncated: false, charLimit: 20_000, returnedLength: input.path.length },
    })

    const streamed: SocratesAgentEvent[] = []
    const agent = new SocratesAgent(provider)
    for await (const event of agent.streamTurn({
      projectId: "proj_1",
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Read two files" }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      streamed.push(event)
    }

    const started = streamed.filter((event): event is Extract<SocratesAgentEvent, { type: "tool.call.started" }> => event.type === "tool.call.started")
    expect(started).toHaveLength(2)
    expect(started.map((event) => event.providerToolCallId)).toEqual(["functions.read:0", "functions.read:0"])
    expect(new Set(started.map((event) => event.toolCallId)).size).toBe(2)
    expect(started.every((event) => event.toolCallId.startsWith("tcall_"))).toBe(true)
    expect(JSON.stringify(seenMessages.at(-1))).toContain('"toolCallId":"functions.read:0"')
    expect(JSON.stringify(seenMessages.at(-1))).not.toContain(started[0]?.toolCallId)
  })

  it("omits tools from the final no-tools call after the per-turn tool budget is exhausted", async () => {
    const countRequests: CountedRequest[] = []
    const streamRequests: ModelRequestLike[] = []
    let calls = 0
    const provider: ModelProvider = {
      countTokens: async (request) => {
        countRequests.push(snapshotCountRequest(request))
        return fakeCountTokens(request)
      },
      async *stream(request) {
        streamRequests.push(request)
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_read_1",
              toolName: "read",
              input: { path: "README.md" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Tool budget was exhausted." }
        yield { type: "model.completed" }
      },
    }

    const agent = new SocratesAgent(provider)
    const streamed: SocratesAgentEvent[] = []
    for await (const event of agent.streamTurn({
      projectId: "proj_1",
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Read README" }],
      workspacePath: "/tmp",
      toolExecutors: emptyToolExecutors(),
      requestApproval: async () => ({ decision: "approved" }),
      maxToolCallsPerTurn: 0,
    })) {
      streamed.push(event)
    }

    expect(streamed.some((event) => event.type === "tool.call.failed")).toBe(true)
    expect(countRequests[0]?.toolCount).toBe(8)
    expect(countRequests[1]?.toolCount).toBe(0)
    expect(streamRequests[1]?.tools).toHaveLength(0)
    expect(JSON.stringify(countRequests[1]?.messages)).toContain("tool-result")
  })

  it("includes dry-run edit diff in approval requests before applying the edit", async () => {
    let calls = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream() {
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_edit_1",
              toolName: "edit",
              input: { path: "README.md", oldString: "old", newString: "new" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Edited." }
        yield { type: "model.completed" }
      },
    }
    const approvals: string[] = []
    const editDryRuns: boolean[] = []
    const executors: ToolExecutors = {
      read: async () => ({
        path: "README.md",
        kind: "file",
        content: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }),
      search: async () => ({ mode: "files", query: "", matches: [], totalMatches: 0, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
      edit: async (input) => {
        editDryRuns.push(input.dryRun === true)
        return {
          changedFiles: [{ path: "README.md", operation: "edited" }],
          diff: "--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-old\n+new",
          dryRun: input.dryRun ?? false,
          truncation: { truncated: false, charLimit: 20_000, returnedLength: 57 },
        }
      },
      apply_patch: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
      bash: async () => bashOk(),
      trace_retrieve: async () => ({
        results: [],
        totalMatches: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
        appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined" },
      }),
      list_project_resources: async () => ({
        resources: [],
        summary: "Listed 0 project resources.",
        totalResources: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
      }),
    }

    const agent = new SocratesAgent(provider)
    for await (const _event of agent.streamTurn({
      projectId: "proj_1",
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Edit README" }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async (request) => {
        approvals.push(request.actionPreview)
        return { decision: "approved" }
      },
    })) {
      // Drain stream.
    }

    expect(editDryRuns).toEqual([true, false])
    expect(approvals[0]).toContain("-old")
    expect(approvals[0]).toContain("+new")
  })

  it("feeds read image results back to vision-capable models as native image parts", async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-core-image-read-"))
    fs.writeFileSync(path.join(workspacePath, "screenshot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const streamRequests: ModelRequestLike[] = []
    let calls = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        streamRequests.push(request)
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "call_read_image",
              toolName: "read",
              input: { path: "screenshot.png" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "I can inspect the image." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.read = async () => ({
      path: "screenshot.png",
      kind: "image",
      mimeType: "image/png",
      sizeBytes: 4,
      contentHash: "hash",
      image: {
        mediaType: "image/png",
        nativeVisionSupported: true,
        description: "Image metadata is available.",
      },
      truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
    })

    const agent = new SocratesAgent(provider)
    const streamed: SocratesAgentEvent[] = []
    for await (const event of agent.streamTurn({
      providerId: "openrouter",
      modelId: "x-ai/grok-build-0.1",
      runtimeConfig: {
        providerId: "openrouter",
        modelId: "x-ai/grok-build-0.1",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Read the screenshot." }],
      workspacePath,
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      streamed.push(event)
    }

    expect(streamed.some((event) => event.type === "tool.call.completed")).toBe(true)
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("Native image content returned by read")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain('"type":"image"')
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("iVBORw==")
    expect(streamRequests[1]?.tools?.map((tool) => tool.name)).toContain("read")
  })

  it("preserves tool schemas for OpenRouter turns that already include native image parts", async () => {
    const streamRequests: ModelRequestLike[] = []
    const countRequests: CountedRequest[] = []
    const provider: ModelProvider = {
      countTokens: async (request) => {
        countRequests.push(snapshotCountRequest(request))
        return fakeCountTokens(request)
      },
      async *stream(request) {
        streamRequests.push(request)
        yield { type: "model.answer.delta", text: request.tools?.length ? "tools present" : "image only" }
        yield { type: "model.completed" }
      },
    }

    const agent = new SocratesAgent(provider)
    const streamed: SocratesAgentEvent[] = []
    for await (const event of agent.streamTurn({
      providerId: "openrouter",
      modelId: "x-ai/grok-build-0.1",
      runtimeConfig: {
        providerId: "openrouter",
        modelId: "x-ai/grok-build-0.1",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this screenshot?" },
            { type: "image", mediaType: "image/png", data: "data:image/png;base64,iVBORw==" },
          ],
        },
      ],
      workspacePath: "/tmp",
      toolExecutors: emptyToolExecutors(),
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      streamed.push(event)
    }

    expect(streamed.some((event) => event.type === "model.answer.delta")).toBe(true)
    expect(countRequests[0]?.toolCount).toBeGreaterThan(0)
    expect(streamRequests[0]?.tools?.map((tool) => tool.name)).toContain("read")
  })

  it("injects user and project context into the system prompt", async () => {
    const seen: unknown[] = []
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        seen.push(request)
        yield { type: "model.completed" }
      },
    }

    const agent = new SocratesAgent(provider)
    for await (const _event of agent.streamTurn({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "read_only",
      },
      messages: [{ role: "user", content: "Hi" }],
      promptContext: {
        userDisplayName: "Ayush",
        projectName: "Socrates",
        projectDescription: "Local-first AI workspace.",
        projectInstructions: "Read repo_docs before answering.",
        workspaceGuidance: "Python Environment Hints\n- Local virtual environments found:\n  - venv/",
        workspaceCommandEnvironment:
          "Workspace Terminal commands run with a sanitized user-workspace environment. NODE_ENV, provider secrets, package-manager omit flags, and CI are not inherited.",
        semanticRetrievalStatus:
          'Semantic retrieval: ready.\n- Provider/model: openai/text-embedding-3-small.\n- Use trace_retrieve mode="combined" by default.',
      },
    })) {
      // Exhaust the stream.
    }

    const request = seen[0] as { system: string }
    expect(request.system).toContain("Name: Ayush")
    expect(request.system).toContain("Name: Socrates")
    expect(request.system).toContain("Local-first AI workspace.")
    expect(request.system).toContain("Read repo_docs before answering.")
    expect(request.system).toContain("Python Environment Hints")
    expect(request.system).toContain("Workspace command environment:")
    expect(request.system).toContain("sanitized user-workspace environment")
    expect(request.system).toContain("provider secrets")
    expect(request.system).toContain("Semantic retrieval status:")
    expect(request.system).toContain("Semantic retrieval: ready.")
    expect(request.system).toContain('mode="combined"')
    expect(request.system).toContain("Do not hardcode or guess absolute workspace paths")
    expect(request.system).toContain("plt.show()")
  })
})

describe("bash tool policy", () => {
  it("auto-allows Windows read-only diagnostics and gates high-risk commands", async () => {
    const context = {
      runtimeConfig: { sandboxMode: "workspace_write", approvalMode: "manual" },
    } as Parameters<typeof bashTool.decidePolicy>[1]

    expect(await bashTool.decidePolicy({ command: "Get-Content package.json" }, context)).toEqual({ type: "auto" })
    expect(await bashTool.decidePolicy({ command: "where python" }, context)).toEqual({ type: "auto" })
    expect(await bashTool.decidePolicy({ operation: "output", processId: "proc_1" }, context)).toEqual({ type: "auto" })

    const dockerPolicy = await bashTool.decidePolicy({ command: "docker compose up -d" }, context)
    expect(dockerPolicy.type).toBe("approval_required")
    if (dockerPolicy.type === "approval_required") {
      expect(dockerPolicy.request.risk).toBe("high")
    }
  })
})

type ModelRequestLike = Parameters<ModelProvider["countTokens"]>[0]
type CountedRequest = {
  messages: unknown
  toolCount: number
}

const snapshotCountRequest = (request: ModelRequestLike): CountedRequest => ({
  messages: JSON.parse(JSON.stringify(request.messages)) as unknown,
  toolCount: request.tools?.length ?? 0,
})

const emptyToolExecutors = (): ToolExecutors => ({
  read: async () => ({
    path: "README.md",
    kind: "file",
    content: "",
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
  }),
  search: async () => ({ mode: "files", query: "", matches: [], totalMatches: 0, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
  edit: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
  apply_patch: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
  bash: async () => bashOk(),
  trace_retrieve: async () => ({
    results: [],
    totalMatches: 0,
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
    appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined" },
  }),
  list_project_resources: async () => ({
    resources: [],
    summary: "Listed 0 project resources.",
    totalResources: 0,
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
  }),
})

const bashOk = () => ({
  operation: "run" as const,
  command: "pwd",
  cwd: "/tmp",
  exitCode: 0,
  stdout: "",
  stderr: "",
  durationMs: 0,
  timedOut: false,
  truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
  shell: { platform: "darwin", kind: "posix" as const, executable: "/bin/zsh" },
})

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
