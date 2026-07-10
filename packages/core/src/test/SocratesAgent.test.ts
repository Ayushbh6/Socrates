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
    expect(requestJson).toContain("Read before existing-file mutations")
    expect(requestJson).toContain("Product copy says Terminal; tool id is bash")
    expect(requestJson).toContain("tool_docs")
    expect(requestJson).toContain("skills")
    expect(requestJson).toContain("closure/handoff request")
    expect(requestJson).toContain("current_time")
    expect(requestJson).toContain("project_docs")
    expect(requestJson).toContain("Use regex=true for regex syntax")
    expect(requestJson).toContain(".socrates/MEMORY.md")
    expect(requestJson).toContain("live cross-conversation project memory")
    expect(requestJson).toContain("active assistant notebook")
    expect(requestJson).toContain("Explicit docs operating loop")
    expect(requestJson).toContain("repo_docs")
    expect(requestJson).toContain("A separate Global Memory Agent runs in the background")
    expect(requestJson).toContain("Explicit user-stated allergies")
    expect(requestJson).toContain("compare stack trace lines to current files")
    expect(requestJson).toContain("distinguish config/credential issues from service availability")
  })

  it("exposes the base tool set", () => {
    const tools = createDefaultToolRegistry().modelDefinitions()
    expect(tools.map((tool) => tool.name)).toEqual([
      "read",
      "search",
      "url_fetch",
      "edit",
      "apply_patch",
      "bash",
      "current_time",
      "trace_retrieve",
      "tool_docs",
      "skills",
      "project_docs",
      "repo_docs",
      "soul",
      "user_profile",
      "list_project_resources",
      "mcp_registry",
      "memory_note",
    ])
    expect(tools.map((tool) => tool.name).some((name) => name.startsWith("mcp__playwright__"))).toBe(false)
    expect(tools.find((tool) => tool.name === "mcp_registry")?.description).toContain("helper, extension, server")
    expect(tools.find((tool) => tool.name === "mcp_registry")?.description).toContain("canonical id")
    expect(tools.find((tool) => tool.name === "skills")?.description).toContain("saved workflow")
    expect(tools.find((tool) => tool.name === "skills")?.description).toContain("closure/handoff request")
    expect(tools.find((tool) => tool.name === "skills")?.description).toContain("canonical id")
    expect(tools.find((tool) => tool.name === "memory_note")?.description).toContain("Memory Agent")
    expect(tools.find((tool) => tool.name === "edit")?.inputSchema.safeParse({ path: "README.md", content: "new" }).success).toBe(true)
    expect(
      tools
        .find((tool) => tool.name === "edit")
        ?.inputSchema.safeParse({ path: "README.md", content: "new", oldString: "old", newString: "new" }).success,
    ).toBe(false)
  })

  it("keeps OpenRouter routed-provider affinity for later calls in the same turn", async () => {
    const seen: Parameters<ModelProvider["stream"]>[0][] = []
    let calls = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        seen.push(request)
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: { toolCallId: "call_1", toolName: "read", input: { path: "README.md" } },
          }
          yield { type: "model.usage", usage: { routedProvider: "DeepInfra" } }
          yield { type: "model.completed", finishReason: "tool-calls", usage: { routedProvider: "DeepInfra" } }
          return
        }
        yield { type: "model.answer.delta", text: "done" }
        yield { type: "model.completed" }
      },
    }

    const agent = new SocratesAgent(provider)
    for await (const _event of agent.streamTurn({
      providerId: "openrouter",
      modelId: "deepseek/deepseek-v4-pro",
      sessionId: "sess_1",
      cacheKey: "project:proj_1:conversation:conv_1",
      workspacePath: "/tmp",
      runtimeConfig: {
        providerId: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "read_only",
      },
      messages: [{ role: "user", content: "Read the README." }],
      toolExecutors: emptyToolExecutors(),
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    expect(seen).toHaveLength(2)
    expect(seen[0]?.providerRouting).toBeUndefined()
    expect(seen[1]?.providerRouting).toEqual({ preferredOpenRouterProvider: "DeepInfra" })
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
      async generateStructured(request) {
        expect(request.modelId).toBe("deepseek/deepseek-v4-flash")
        await compressorReleased
        return {
          output: validCompressorSummary() as never,
          usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        }
      },
      async *stream(request) {
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
        messages: [
          { role: "user", content: "Old history", id: "msg_1", turnId: "turn_1" },
          { role: "assistant", content: "Old answer", id: "msg_2", turnId: "turn_1" },
          { role: "user", content: "Current request", id: "msg_3", turnId: "turn_2" },
        ],
        contextCompression: {
          enabled: true,
          thresholds: { triggerTokens: 10, recentTailTargetTokens: 1 },
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
              toolCallId: "tcall_project_notes_once",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_notes_1",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
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
      url_fetch: async () => ({
        url: "https://example.com",
        finalUrl: "https://example.com",
        status: 200,
        ok: true,
        redirected: false,
        sizeBytes: 0,
        text: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }),
      edit: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
      apply_patch: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
      bash: async () => bashOk(),
      current_time: async () => ({
        currentDate: "2026-06-19",
        currentDateTime: "2026-06-19T06:30:00.000Z",
        timeZone: "Europe/Vienna",
        source: "system",
      }),
      trace_retrieve: async () => ({
        results: [],
        totalMatches: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
        appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined" },
      }),
      tool_docs: async () => ({
        operation: "search",
        results: [],
        totalMatches: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
      }),
      skills: async () => ({
        operation: "list",
        skills: [],
        totalMatches: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
      }),
      project_docs: async () => ({
        operation: "read",
        area: "notes",
        path: ".socrates/PROJECT_NOTES.md",
        content: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }),
      repo_docs: async () => ({
        operation: "read",
        paths: [".socrates/repo_docs/REPO_RULES.md"],
        content: "- .socrates/repo_docs/REPO_RULES.md",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 36 },
      }),
      soul: async () => ({
        operation: "read",
        path: "identity.md",
        content: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }),
      user_profile: async () => ({
        operation: "read",
        path: "user_profile.md",
        content: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
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
    expect(countRequests[0]?.toolCount).toBe(17)
    expect(countRequests[1]?.toolCount).toBe(17)
    expect(JSON.stringify(countRequests[0]?.messages)).not.toContain("tool-result")
    expect(JSON.stringify(countRequests[1]?.messages)).toContain("tool-result")
    expect(JSON.stringify(seenMessages.at(-1))).toContain("tool-result")
    expect(JSON.stringify(seenMessages.at(-1))).toContain("thoughtSignature")
  })

  it("adds a cache-safe same-turn memory save ledger after memory_note results", async () => {
    const streamRequests: Array<{ system: string; messages: unknown }> = []
    let calls = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        streamRequests.push({ system: request.system, messages: JSON.parse(JSON.stringify(request.messages)) as unknown })
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_memory_note",
              toolName: "memory_note",
              input: { note: "User explicitly prefers implementation only after approval.", importance: "high" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Noted." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.memory_note = async () => ({
      noteNumber: 1,
      status: "open",
      attachedSource: "current_user_message",
      result: "created",
    })

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
      messages: [{ role: "user", content: "Please remember this implementation approval preference." }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    expect(streamRequests).toHaveLength(2)
    expect(streamRequests[1]?.system).toBe(streamRequests[0]?.system)
    expect(streamRequests[0]?.system).not.toContain("socrates_memory_save_ledger")
    expect(JSON.stringify(streamRequests[0]?.messages)).not.toContain("socrates_memory_save_ledger")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("socrates_memory_save_ledger")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("#1 created status=open")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("implementation only after approval")
  })

  it("runs a structured pre-turn memory route, recalls always rules, and splits immediate memory writes", async () => {
    const streamRequests: ModelRequestLike[] = []
    const structuredSystems: string[] = []
    const structuredRequests: unknown[] = []
    const recordedRouterUsage: unknown[] = []
    const projectDocsInputs: unknown[] = []
    const userProfileInputs: unknown[] = []
    const memoryNoteInputs: unknown[] = []
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured(request) {
        structuredRequests.push(request)
        structuredSystems.push(request.system)
        return {
          output: {
            readTargets: [
              {
                surface: "project_notes",
                fileName: "PROJECT_NOTES.md",
                sectionId: "active_context",
                reason: "The user gave project-local guidance before asking for repo work.",
              },
              {
                surface: "repo_docs",
                fileName: "REPO_RULES.md",
                sectionId: "hard_rules",
                reason: "The requested repo work depends on durable repository rules.",
              },
              {
                surface: "user_profile",
                fileName: "user_profile.md",
                sectionId: "collaboration_style",
                reason: "The user referenced a cross-project collaboration preference.",
              },
            ],
            memoryWrites: [
              {
                kind: "document",
                surface: "project_notes",
                fileName: "PROJECT_NOTES.md",
                sectionId: "active_context",
                text: "Remember that root MEMORY.md and context-files are separate from Socrates runtime memory surfaces.",
                reason: "The user gave project-local guidance before asking for repo work.",
              },
              {
                kind: "document",
                surface: "user_profile",
                fileName: "user_profile.md",
                sectionId: "global_always_apply_rules",
                text: "When the user asks for slow mode, discuss the plan before implementation across projects.",
                reason: "The user gave a stable cross-project collaboration rule.",
              },
            ],
            reason: "The user gave project-local guidance before asking for repo work.",
          } as never,
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, costUsd: 0.0001 },
        }
      },
      async *stream(request) {
        if (request.system.includes("Memory Router Agent")) {
          yield { type: "model.completed" }
          return
        }
        streamRequests.push(request)
        yield { type: "model.answer.delta", text: "Got it." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.project_docs = async (input) => {
      projectDocsInputs.push(input)
      if (input.operation === "read_section" && input.area === "notes") {
        return projectDocsSectionOutput("notes", "active_context", "- Existing active item.")
      }
      if (input.operation === "read_section" && input.area === "memory") {
        return projectDocsSectionOutput("memory", input.sectionId ?? "always_apply_rules", "- Add at most 10 short project hard rules here.")
      }
      return {
        operation: "patch_section",
        area: "notes",
        path: ".socrates/PROJECT_NOTES.md",
        changed: true,
        content: "- Existing active item.\n- [pre-turn] Remember that root MEMORY.md and context-files are separate from Socrates runtime memory surfaces.",
        section: memoryDocSection("active_context", "- Existing active item.\n- [pre-turn] Remember that root MEMORY.md and context-files are separate from Socrates runtime memory surfaces."),
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 120 },
      }
    }
    executors.repo_docs = async (input) => ({
      operation: "read_index",
      paths: [".socrates/repo_docs/REPO_RULES.md"],
      content: "hard_rules",
      truncation: { truncated: false, charLimit: 20_000, returnedLength: 10 },
    })
    executors.user_profile = async (input) => {
      userProfileInputs.push(input)
      const isSectionRead = input.operation === "read_section"
      const content = input.sectionId === "collaboration_style" ? "- Existing collaboration preference." : "- Existing global rule."
      return {
        operation: input.operation,
        path: "user_profile.md",
        content: isSectionRead ? content : "Profile index only.",
        section: isSectionRead ? memoryDocSection(input.sectionId ?? "global_always_apply_rules", content) : undefined,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: content.length },
      }
    }
    executors.memory_note = async (input) => {
      memoryNoteInputs.push(input)
      return {
        noteNumber: 1,
        status: "open",
        attachedSource: "current_user_message",
        result: "created",
      }
    }

    const streamed: SocratesAgentEvent[] = []
    const agent = new SocratesAgent(provider)
    for await (const event of agent.streamTurn({
      projectId: "proj_1",
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      providerId: "openrouter",
      modelId: "z-ai/glm-4.5",
      runtimeConfig: {
        providerId: "openrouter",
        modelId: "z-ai/glm-4.5",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      memoryRouterModelSettings: {
        providerId: "google",
        modelId: "gemini-3.3-flash-preview",
        thinkingEnabled: false,
        thinkingEffort: "none",
      },
      recordMemoryRouterUsage: (usage) => {
        recordedRouterUsage.push(usage)
      },
      messages: [{ role: "user", content: "Remember this project boundary, then inspect the repo." }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      streamed.push(event)
    }

    expect(structuredSystems[0]).toContain("pre-turn Memory Router Agent")
    expect(structuredRequests).toHaveLength(1)
    expect(structuredRequests[0]).toMatchObject({
      providerId: "google",
      modelId: "gemini-3.3-flash-preview",
      runtimeConfig: {
        providerId: "google",
        modelId: "gemini-3.3-flash-preview",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "read_only_auto",
        sandboxMode: "read_only",
      },
    })
    expect(recordedRouterUsage).toEqual([
      expect.objectContaining({
        phase: "pre_turn",
        sourceId: "turn_1:memory_router:pre_turn:1",
        providerId: "google",
        modelId: "gemini-3.3-flash-preview",
        usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16, costUsd: 0.0001 },
      }),
    ])
    expect(projectDocsInputs).toEqual([
      { operation: "read_section", area: "memory", sectionId: "always_apply_rules", charLimit: 10_000 },
      { operation: "read_section", area: "notes", sectionId: "active_context", charLimit: 20_000 },
      { operation: "read_section", area: "notes", sectionId: "active_context", charLimit: 20_000 },
      {
        operation: "patch_section",
        area: "notes",
        sectionId: "active_context",
        oldText: "- Existing active item.",
        newText: "- Existing active item.\n- [pre-turn] Remember that root MEMORY.md and context-files are separate from Socrates runtime memory surfaces.",
      },
    ])
    expect(userProfileInputs).toEqual([
      { operation: "read_section", sectionId: "global_always_apply_rules", charLimit: 10_000 },
      { operation: "read_section", sectionId: "collaboration_style", charLimit: 20_000 },
    ])
    expect(memoryNoteInputs).toEqual([
      {
        note: "Memory router candidate for user_profile/user_profile.md/global_always_apply_rules: When the user asks for slow mode, discuss the plan before implementation across projects.",
        importance: "high",
      },
    ])
    const toolNames = streamed.filter((event) => event.type === "tool.call.started").map((event) => event.toolName)
    expect(toolNames).toEqual(["project_docs", "user_profile", "project_docs", "repo_docs", "user_profile", "project_docs", "project_docs", "memory_note"])
    const firstRequestMessages = streamRequests[0]?.messages ?? []
    const firstRequestJson = JSON.stringify(firstRequestMessages)
    const firstRequestText = stringMessageContents(firstRequestMessages).join("\n")
    expect(firstRequestMessages[0]).toMatchObject({ role: "developer" })
    expect(String(firstRequestMessages[0]?.content)).toContain("socrates_stable_cache_prelude")
    expect(String(firstRequestMessages[0]?.content)).toContain("Existing global rule")
    expect(String(firstRequestMessages[0]?.content)).toContain("No always-apply rules recorded.")
    expect(firstRequestMessages[1]).toMatchObject({ role: "user", content: "Remember this project boundary, then inspect the repo." })
    expect(firstRequestText.indexOf("socrates_stable_cache_prelude")).toBeLessThan(
      firstRequestText.indexOf("Remember this project boundary"),
    )
    expect(firstRequestText.indexOf("socrates_memory_loop")).toBeGreaterThan(
      firstRequestText.indexOf("Remember this project boundary"),
    )
    expect(firstRequestJson).toContain("root MEMORY.md and context-files")
    expect(firstRequestJson).toContain("user_profile/user_profile.md/global_always_apply_rules")
    expect(firstRequestJson).toContain("stable_cache_prelude")
    const dynamicLoopContent = stringMessageContents(firstRequestMessages).find((content) => content.includes("socrates_memory_loop")) ?? ""
    expect(dynamicLoopContent).not.toContain("Existing global rule")
  })

  it("runs a structured post-evidence route and syncs project memory before the final model step", async () => {
    const streamRequests: ModelRequestLike[] = []
    const structuredSystems: string[] = []
    const projectDocsInputs: unknown[] = []
    let streamCalls = 0
    let structuredCalls = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured(request) {
        structuredCalls += 1
        structuredSystems.push(request.system)
        if (structuredCalls === 1) {
          return {
            output: {
              readTargets: [],
              memoryWrites: [],
              reason: "No pre-turn recall needed.",
            } as never,
          }
        }
        return {
          output: {
            memoryWrites: [
              {
                kind: "document",
                surface: "project_memory",
                fileName: "MEMORY.md",
                sectionId: "durable_decisions",
                text: "Verified README mentions the Socrates memory loop.",
                reason: "A read tool produced a durable project fact.",
              },
            ],
            reason: "A read tool produced a durable project fact.",
          } as never,
        }
      },
      async *stream(request) {
        if (request.system.includes("Memory Router Agent")) {
          yield { type: "model.completed" }
          return
        }
        streamRequests.push(request)
        streamCalls += 1
        if (streamCalls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: { toolCallId: "tcall_read_memory_loop", toolName: "read", input: { path: "README.md" } },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Verified and saved." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.read = async () => ({
      path: "README.md",
      kind: "file",
      content: "Socrates memory loop",
      truncation: { truncated: false, charLimit: 20_000, returnedLength: 20 },
    })
    executors.project_docs = async (input) => {
      projectDocsInputs.push(input)
      if (input.operation === "read_section") {
        const sectionId = input.sectionId ?? "always_apply_rules"
        return projectDocsSectionOutput(input.area, sectionId, sectionId === "durable_decisions" ? "- Existing durable decision." : "- Add at most 10 short project hard rules here.")
      }
      if (input.operation === "patch_section") {
        const sectionId = input.sectionId ?? "durable_decisions"
        const newText = input.newText ?? ""
        return {
          operation: "patch_section",
          area: input.area,
          path: ".socrates/MEMORY.md",
          changed: true,
          content: newText,
          section: memoryDocSection(sectionId, newText),
          truncation: { truncated: false, charLimit: 20_000, returnedLength: newText.length },
        }
      }
      return {
        operation: "edit",
        area: "memory",
        path: ".socrates/MEMORY.md",
        changed: true,
        content: "- [post-evidence] Verified README mentions the Socrates memory loop.",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 70 },
      }
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
      messages: [{ role: "user", content: "Check the README for memory-loop state." }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      streamed.push(event)
    }

    expect(structuredSystems[0]).toContain("pre-turn Memory Router Agent")
    expect(structuredSystems[1]).toContain("post-evidence Memory Router Agent")
    expect(projectDocsInputs).toEqual([
      { operation: "read_section", area: "memory", sectionId: "always_apply_rules", charLimit: 10_000 },
      {
        operation: "read_section",
        area: "memory",
        sectionId: "durable_decisions",
        charLimit: 20_000,
      },
      {
        operation: "patch_section",
        area: "memory",
        sectionId: "durable_decisions",
        oldText: "- Existing durable decision.",
        newText: "- Existing durable decision.\n- [post-evidence] Verified README mentions the Socrates memory loop.",
      },
    ])
    const toolNames = streamed.filter((event) => event.type === "tool.call.started").map((event) => event.toolName)
    expect(toolNames).toEqual(["project_docs", "user_profile", "read", "project_docs", "project_docs"])
    expect(streamRequests).toHaveLength(2)
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("Verified README mentions the Socrates memory loop")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("socrates_memory_loop")
  })

  it("deduplicates equivalent pre-turn and post-evidence routed writes within one turn", async () => {
    const projectDocsInputs: Array<Record<string, unknown>> = []
    const memoryNoteInputs: unknown[] = []
    const streamRequests: ModelRequestLike[] = []
    let structuredCalls = 0
    let streamCalls = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async generateStructured() {
        structuredCalls += 1
        if (structuredCalls === 1) {
          return {
            output: {
              readTargets: [],
              memoryWrites: [
                {
                  kind: "document",
                  surface: "project_notes",
                  fileName: "PROJECT_NOTES.md",
                  sectionId: "active_context",
                  text: "Created retrieval_e2e_note.md at the workspace root summarizing the unresolved Deepplay question and narrowest-check workflow.",
                  reason: "The user requested a durable project note.",
                },
                {
                  kind: "skill_candidate",
                  text: "When creating a summary note about an unresolved project question, first read active context and handoff, then use the narrowest reliable check workflow.",
                  reason: "This may be reusable.",
                },
              ],
              reason: "Record the requested project outcome and reusable procedure.",
            } as never,
          }
        }
        return {
          output: {
            memoryWrites: [
              {
                kind: "document",
                surface: "project_notes",
                fileName: "PROJECT_NOTES.md",
                sectionId: "active_context",
                text: "Created retrieval_e2e_note.md at workspace root summarizing the unresolved Deepplay question and verification workflow using the narrowest reliable check.",
                reason: "Tool evidence confirmed the result.",
              },
              {
                kind: "skill_candidate",
                text: "When creating a summary note for an unresolved project question, read the active_context and handoff sections first, then apply the narrowest reliable verification check.",
                reason: "This may be reusable.",
              },
            ],
            reason: "Tool evidence confirmed the same routed outcomes.",
          } as never,
        }
      },
      async *stream(request) {
        if (request.system.includes("Memory Router Agent")) {
          yield { type: "model.completed" }
          return
        }
        streamRequests.push(request)
        streamCalls += 1
        if (streamCalls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: { toolCallId: "tcall_read_workspace", toolName: "read", input: { path: "." } },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Done." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.read = async () => ({ path: ".", kind: "directory", entries: [], truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } })
    executors.project_docs = async (input) => {
      projectDocsInputs.push(input)
      if (input.operation === "read_section") {
        const content = input.area === "memory" ? "- Add at most 10 short project hard rules here." : "- Existing active context."
        return projectDocsSectionOutput(input.area, input.sectionId ?? "active_context", content)
      }
      const newText = input.newText ?? ""
      return {
        operation: "patch_section",
        area: "notes",
        path: ".socrates/PROJECT_NOTES.md",
        changed: true,
        content: newText,
        section: memoryDocSection("active_context", newText),
        truncation: { truncated: false, charLimit: 20_000, returnedLength: newText.length },
      }
    }
    executors.memory_note = async (input) => {
      memoryNoteInputs.push(input)
      return { noteNumber: 1, status: "open", attachedSource: "current_user_message", result: "created" }
    }

    const agent = new SocratesAgent(provider)
    for await (const _event of agent.streamTurn({
      projectId: "proj_1",
      conversationId: "conv_1",
      sessionId: "sess_1",
      turnId: "turn_1",
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      runtimeConfig: {
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
        thinkingEnabled: true,
        thinkingEffort: "high",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Inspect Deepplay and create one project note." }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    expect(projectDocsInputs.filter((input) => input.operation === "patch_section")).toHaveLength(1)
    expect(memoryNoteInputs).toHaveLength(1)
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("Equivalent project_notes/project_notes.md/active_context write was already attempted")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("Equivalent skill_candidate write was already attempted")
  })

  it("preserves OpenAI reasoning item metadata when continuing after tool calls", async () => {
    const seenMessages: unknown[] = []
    let calls = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        seenMessages.push(request.messages)
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.reasoning.completed",
            text: "",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "fc_1",
              toolName: "read",
              input: { path: "README.md" },
              providerMetadata: { openai: { itemId: "fc_item_1" } },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Read it." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.read = async () => ({
      path: "README.md",
      kind: "file",
      content: "Socrates",
      truncation: { truncated: false, charLimit: 20_000, returnedLength: 8 },
    })

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
        thinkingEnabled: true,
        thinkingEffort: "low",
        approvalMode: "manual",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Read README" }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    const nextRequestMessages = seenMessages.at(-1) as Array<{ role: string; content: unknown }>
    const assistantMessage = nextRequestMessages.find(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((part) => (part as { type?: string }).type === "tool-call"),
    ) as { role: string; content: Array<Record<string, unknown>> }

    expect(assistantMessage.content[0]).toEqual({
      type: "reasoning",
      text: "",
      providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
    })
    expect(assistantMessage.content[1]).toMatchObject({
      type: "tool-call",
      toolCallId: "fc_1",
      toolName: "read",
      providerMetadata: { openai: { itemId: "fc_item_1" } },
    })
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

  it("keeps clean trace references model-visible and returns cached warnings for duplicate searches", async () => {
    const seenMessages: unknown[] = []
    let calls = 0
    let traceExecutions = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        seenMessages.push(request.messages)
        calls += 1
        if (calls <= 2) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: `trace_call_${calls}`,
              toolName: "trace_retrieve",
              input: { operation: "search", mode: "lexical", query: "staleness guard", conversationTitle: "apply patch fix", limit: 8 },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Found it." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.trace_retrieve = (async () => {
      traceExecutions += 1
      return {
        results: [
          {
            resultNumber: 1,
            content: "The staleness guard caught it cold.",
            turnId: "turn_source_3",
            conversationTitle: "apply patch fix",
            turnNumber: 3,
            matchedRole: "assistant",
            status: "complete",
            occurredAt: "2026-07-01T10:00:00.000Z",
          },
        ],
        totalMatches: 1,
      }
    }) as never

    const streamed: SocratesAgentEvent[] = []
    const agent = new SocratesAgent(provider)
    for await (const event of agent.streamTurn({
      projectId: "proj_1",
      conversationId: "conv_live",
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
      messages: [{ role: "user", content: "Find this old quote" }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      streamed.push(event)
    }

    expect(traceExecutions).toBe(1)
    expect(streamed.filter((event) => event.type === "tool.call.completed")).toHaveLength(2)
    const finalRequest = JSON.stringify(seenMessages.at(-1))
    expect(finalRequest).toContain("turn_source_3")
    expect(finalRequest).not.toContain("conv_source")
    expect(finalRequest).not.toContain("msg_assistant_3")
    expect(finalRequest).toContain("Identical trace_retrieve input already ran earlier in this turn")
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
              toolCallId: "tcall_project_notes_1",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_notes_1",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_notes_once",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_notes_1",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
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
    expect(countRequests[0]?.toolCount).toBe(17)
    expect(countRequests[1]?.toolCount).toBe(0)
    expect(streamRequests[1]?.tools).toHaveLength(0)
    expect(JSON.stringify(countRequests[1]?.messages)).toContain("tool-result")
  })

  it("adds failed-tool guidance and a runtime action ledger to follow-up model context", async () => {
    const countRequests: CountedRequest[] = []
    let calls = 0
    const provider: ModelProvider = {
      countTokens: async (request) => {
        countRequests.push(snapshotCountRequest(request))
        return fakeCountTokens(request)
      },
      async *stream() {
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_bad_read_1",
              toolName: "read",
              input: { path: 123 },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "The read call was invalid." }
        yield { type: "model.completed" }
      },
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
      messages: [{ role: "user", content: "Read the file" }],
      workspacePath: "/tmp",
      toolExecutors: emptyToolExecutors(),
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    const followUpMessages = JSON.stringify(countRequests[1]?.messages)
    expect(followUpMessages).toContain("Refer to tool_docs for tool usage before retrying this tool or choosing another tool.")
    expect(followUpMessages).toContain("Runtime action ledger for this turn")
    expect(followUpMessages).toContain("failed read")
  })

  it("gives invalid mutation tool schemas a concrete recovery hint before forcing a final answer", async () => {
    const countRequests: CountedRequest[] = []
    const streamRequests: ModelRequestLike[] = []
    const editInputs: unknown[] = []
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
              toolCallId: "tcall_project_notes_once",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_notes_once",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_bad_edit_1",
              toolName: "edit",
              input: { path: "socrates_natural_e2e.md", content: "# Note\n", overwrite: false },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        if (calls === 2) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_bad_edit_2",
              toolName: "edit",
              input: { path: "socrates_natural_e2e.md", content: "# Note\n", oldString: "old", newString: "new" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        if (calls === 3) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_notes_preflight",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_repo_docs_preflight",
              toolName: "repo_docs",
              input: { operation: "read", path: "REPO_RULES.md" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_good_edit_3",
              toolName: "edit",
              input: { path: "socrates_natural_e2e.md", content: "# Natural E2E\n" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        if (calls === 4) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_memory_review",
              toolName: "project_docs",
              input: { operation: "read", area: "memory" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "Created the note." }
        yield { type: "model.completed" }
      },
    }

    const executors = emptyToolExecutors()
    executors.edit = async (input) => {
      editInputs.push(input)
      return {
        changedFiles: [{ path: "socrates_natural_e2e.md", operation: "created" }],
        diff: "created",
        dryRun: false,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 7 },
      }
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
        approvalMode: "approve_all",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Make a small markdown note with what we checked." }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    expect(JSON.stringify(countRequests[1]?.messages)).toContain("Runtime tool-schema recovery")
    expect(JSON.stringify(countRequests[2]?.messages)).toContain("For a new file")
    expect(streamRequests[1]?.tools?.map((tool) => tool.name)).toContain("edit")
    expect(streamRequests[2]?.tools?.map((tool) => tool.name)).toContain("edit")
    expect(editInputs).toHaveLength(1)
    expect(editInputs[0]).toMatchObject({ path: "socrates_natural_e2e.md", content: "# Natural E2E\n" })
  })

  it("still forces a final no-tools call after four invalid mutation schemas", async () => {
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
        if (calls <= 4) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: `tcall_bad_edit_${calls}`,
              toolName: "edit",
              input: { path: "socrates_natural_e2e.md", content: `# Note ${calls}\n`, overwrite: false },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "I could not safely edit the file." }
        yield { type: "model.completed" }
      },
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
        approvalMode: "approve_all",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Make a small markdown note with what we checked." }],
      workspacePath: "/tmp",
      toolExecutors: emptyToolExecutors(),
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    expect(countRequests.at(-1)?.toolCount).toBe(0)
    expect(streamRequests.at(-1)?.tools).toHaveLength(0)
    const finalMessages = JSON.stringify(countRequests.at(-1)?.messages)
    expect(finalMessages).toContain("same normalized tool target was repeated 4 times")
    expect(finalMessages).toContain("Runtime anti-spiral guard")
  })

  it("forces a final no-tools call after repeated normalized tool targets", async () => {
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
        if (calls <= 4) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: `tcall_read_${calls}`,
              toolName: "read",
              input: { path: calls % 2 === 0 ? "./README.md" : "README.md" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "I have enough evidence from the repeated reads." }
        yield { type: "model.completed" }
      },
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
      messages: [{ role: "user", content: "Inspect README" }],
      workspacePath: "/tmp",
      toolExecutors: emptyToolExecutors(),
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    expect(countRequests.at(-1)?.toolCount).toBe(0)
    expect(streamRequests.at(-1)?.tools).toHaveLength(0)
    const finalMessages = JSON.stringify(countRequests.at(-1)?.messages)
    expect(finalMessages).toContain("same normalized tool target was repeated 4 times")
    expect(finalMessages).toContain("Runtime anti-spiral guard")
  })

  it("forces a final no-tools call after current-turn token growth crosses the hard guard", async () => {
    const countRequests: CountedRequest[] = []
    const streamRequests: ModelRequestLike[] = []
    let countCalls = 0
    let streamCalls = 0
    const provider: ModelProvider = {
      countTokens: async (request) => {
        countRequests.push(snapshotCountRequest(request))
        countCalls += 1
        const inputTokens = countCalls === 1 ? 1_000 : countCalls === 2 ? 51_000 : countCalls === 3 ? 82_000 : 82_100
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
        streamRequests.push(request)
        streamCalls += 1
        if (streamCalls === 1) {
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
        yield { type: "model.answer.delta", text: "Stopping before more tool work." }
        yield { type: "model.completed" }
      },
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
      messages: [{ role: "user", content: "Investigate deeply" }],
      workspacePath: "/tmp",
      toolExecutors: emptyToolExecutors(),
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain the turn.
    }

    expect(countRequests.at(-1)?.toolCount).toBe(0)
    expect(streamRequests.at(-1)?.tools).toHaveLength(0)
    const finalMessages = JSON.stringify(countRequests.at(-1)?.messages)
    expect(finalMessages).toContain("current-turn context growth is above 50k")
    expect(finalMessages).toContain("current-turn context growth is above 80k")
  })

  it("omits tools after ten confirmed tool execution errors", async () => {
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
        if (calls <= 10) {
          yield {
            type: "model.tool_call.completed",
              toolCall: {
                toolCallId: `tcall_bad_trace_${calls}`,
                toolName: "trace_retrieve",
                input: { query: `README ${calls}`, role: "system" },
              },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "The tool calls are invalid." }
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
      messages: [{ role: "user", content: "Find this old quote" }],
      workspacePath: "/tmp",
      toolExecutors: emptyToolExecutors(),
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      streamed.push(event)
    }

    const failed = streamed.filter((event) => event.type === "tool.call.failed")
    expect(failed).toHaveLength(10)
    expect(countRequests).toHaveLength(11)
    expect(countRequests[0]?.toolCount).toBe(17)
    expect(countRequests[10]?.toolCount).toBe(0)
    expect(streamRequests[10]?.tools).toHaveLength(0)
    expect(JSON.stringify(countRequests[10]?.messages)).toContain("10 confirmed tool-call execution errors")
    expect(JSON.stringify(countRequests[10]?.messages)).toContain("invalid_tool_input")
  })

  it("includes dry-run edit diff in approval requests before applying the edit", async () => {
    let calls = 0
    const streamRequests: ModelRequestLike[] = []
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        streamRequests.push(request)
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_notes_1",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_repo_docs_1",
              toolName: "repo_docs",
              input: { operation: "read", path: "REPO_RULES.md" },
            },
          }
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
        if (calls === 2) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_memory_1",
              toolName: "project_docs",
              input: { operation: "read", area: "memory" },
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
      url_fetch: async () => ({
        url: "https://example.com",
        finalUrl: "https://example.com",
        status: 200,
        ok: true,
        redirected: false,
        sizeBytes: 0,
        text: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }),
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
      current_time: async () => ({
        currentDate: "2026-06-19",
        currentDateTime: "2026-06-19T06:30:00.000Z",
        timeZone: "Europe/Vienna",
        source: "system",
      }),
      trace_retrieve: async () => ({
        results: [],
        totalMatches: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
        appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined" },
      }),
      tool_docs: async () => ({
        operation: "search",
        results: [],
        totalMatches: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
      }),
      skills: async () => ({
        operation: "list",
        skills: [],
        totalMatches: 0,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
      }),
      project_docs: async () => ({
        operation: "read",
        area: "notes",
        path: ".socrates/PROJECT_NOTES.md",
        content: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }),
      repo_docs: async () => ({
        operation: "read",
        paths: [".socrates/repo_docs/REPO_RULES.md"],
        content: "- .socrates/repo_docs/REPO_RULES.md",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 36 },
      }),
      soul: async () => ({
        operation: "read",
        path: "identity.md",
        content: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
      }),
      user_profile: async () => ({
        operation: "read",
        path: "user_profile.md",
        content: "",
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
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
    expect(JSON.stringify(streamRequests[0]?.messages)).toContain("runtime_socrates_docs_preflight")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("runtime_docs_sync_checkpoint")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("Before final answer, close the Socrates docs loop")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("repo_docs")
  })

  it("requires project notes and repo docs preflight before action tools", async () => {
    let calls = 0
    const streamRequests: ModelRequestLike[] = []
    const approvals: string[] = []
    const editInputs: unknown[] = []
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        streamRequests.push(request)
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_edit_without_repo_docs",
              toolName: "edit",
              input: { path: "README.md", oldString: "old", newString: "new" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        yield { type: "model.answer.delta", text: "I need to read docs first." }
        yield { type: "model.completed" }
      },
    }
    const streamed: SocratesAgentEvent[] = []
    const executors = emptyToolExecutors()
    executors.edit = async (input) => {
      editInputs.push(input)
      return {
        changedFiles: [{ path: "README.md", operation: "edited" }],
        diff: "real diff",
        dryRun: input.dryRun ?? false,
        truncation: { truncated: false, charLimit: 20_000, returnedLength: 9 },
      }
    }

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
      messages: [{ role: "user", content: "Edit README" }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async (request) => {
        approvals.push(request.actionPreview)
        return { decision: "approved" }
      },
    })) {
      streamed.push(event)
    }

    const failed = streamed.find((event): event is Extract<SocratesAgentEvent, { type: "tool.call.failed" }> => event.type === "tool.call.failed")
    expect(failed?.error.code).toBe("docs_preflight_required")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("docs_preflight_required")
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain('project_docs with area=\\"notes\\"')
    expect(JSON.stringify(streamRequests[1]?.messages)).toContain("repo_docs with operation read/search")
    expect(approvals).toEqual([])
    expect(editInputs).toEqual([])
  })

  it("injects one bounded docs preflight and one bounded docs-sync checkpoint per turn", async () => {
    let calls = 0
    const streamRequests: ModelRequestLike[] = []
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        streamRequests.push(request)
        calls += 1
        if (calls === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_notes_once",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_repo_docs_once",
              toolName: "repo_docs",
              input: { operation: "read", path: "REPO_RULES.md" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_edit_once",
              toolName: "edit",
              input: { path: "README.md", oldString: "old", newString: "new" },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        if (calls === 2) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_bash_after_checkpoint",
              toolName: "bash",
              input: { operation: "run", command: "pnpm test", cwd: "." },
            },
          }
          yield { type: "model.completed", finishReason: "tool-calls" }
          return
        }
        if (calls === 3) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "tcall_project_memory_after_actions",
              toolName: "project_docs",
              input: { operation: "read", area: "memory" },
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
    executors.edit = async (input) => ({
      changedFiles: [{ path: "README.md", operation: "edited" }],
      diff: input.dryRun ? "dry diff" : "real diff",
      dryRun: input.dryRun ?? false,
      truncation: { truncated: false, charLimit: 20_000, returnedLength: 8 },
    })
    executors.bash = async () => bashOk()

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
      messages: [{ role: "user", content: "Make the small README fix and check it." }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain stream.
    }

    expect(streamRequests).toHaveLength(4)
    const firstRequest = JSON.stringify(streamRequests[0]?.messages)
    const finalRequest = JSON.stringify(streamRequests[3]?.messages)
    expect(countSubstring(firstRequest, "<runtime_socrates_docs_preflight>")).toBe(1)
    expect(countSubstring(finalRequest, "<runtime_socrates_docs_preflight>")).toBe(1)
    expect(countSubstring(finalRequest, "<runtime_docs_sync_checkpoint>")).toBe(1)
    const preflight = stringMessageContents(streamRequests[0]?.messages).find((content) => content.includes("runtime_socrates_docs_preflight"))
    expect(preflight).toBeDefined()
    expect(preflight?.length).toBeLessThanOrEqual(1_000)
    expect(preflight).toContain("call skills list before project_docs")
    const checkpoint = stringMessageContents(streamRequests[1]?.messages).find((content) => content.includes("runtime_docs_sync_checkpoint"))
    expect(checkpoint).toBeDefined()
    expect(checkpoint?.length).toBeLessThanOrEqual(1_000)
    expect(checkpoint).toContain("project_docs")
    expect(checkpoint).toContain("repo_docs")
    expect(checkpoint).toContain("files changed: README.md")
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

  it("hides terminal runtime ids and sequence cursors from model-visible tool results", async () => {
    const requests: ModelRequestLike[] = []
    let call = 0
    const provider: ModelProvider = {
      countTokens: fakeCountTokens,
      async *stream(request) {
        requests.push(request)
        call += 1
        if (call === 1) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "call_project_notes_before_terminal",
              toolName: "project_docs",
              input: { operation: "read", area: "notes" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "call_repo_docs_before_terminal",
              toolName: "repo_docs",
              input: { operation: "read", path: "REPO_RULES.md" },
            },
          }
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "call_terminal_output",
              toolName: "bash",
              input: { operation: "output", name: "dev-server" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        if (call === 2) {
          yield {
            type: "model.tool_call.completed",
            toolCall: {
              toolCallId: "call_project_memory_after_terminal",
              toolName: "project_docs",
              input: { operation: "read", area: "memory" },
            },
          }
          yield { type: "model.completed" }
          return
        }
        yield { type: "model.answer.delta", text: "Terminal output checked." }
        yield { type: "model.completed" }
      },
    }
    const executors = emptyToolExecutors()
    executors.bash = async () => ({
      ...bashOk(),
      operation: "output",
      stdout: "ready on http://localhost:5173\n",
      process: {
        processId: "proc_secret",
        systemPid: 1234,
        status: "running",
        nextOutputSequence: 7,
      },
      terminal: {
        terminalId: "term_secret",
        name: "dev-server",
        status: "running",
        nextOutputSequence: 7,
      },
    })

    const agent = new SocratesAgent(provider)
    for await (const _event of agent.streamTurn({
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      runtimeConfig: {
        providerId: "openai",
        modelId: "gpt-5.4-mini",
        thinkingEnabled: false,
        thinkingEffort: "none",
        approvalMode: "approve_all",
        sandboxMode: "workspace_write",
      },
      messages: [{ role: "user", content: "Check terminal output" }],
      workspacePath: "/tmp",
      toolExecutors: executors,
      requestApproval: async () => ({ decision: "approved" }),
    })) {
      // Drain stream.
    }

    const secondRequest = JSON.stringify(requests[1]?.messages)
    expect(secondRequest).toContain("dev-server")
    expect(secondRequest).toContain("ready on http://localhost:5173")
    expect(secondRequest).not.toContain("proc_secret")
    expect(secondRequest).not.toContain("term_secret")
    expect(secondRequest).not.toContain("nextOutputSequence")
    expect(secondRequest).not.toContain("systemPid")
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
      },
    })) {
      // Exhaust the stream.
    }

    const request = seen[0] as { system: string }
    expect(request.system).toContain("Name: Ayush")
    expect(request.system).toContain("Name: Socrates")
    expect(request.system).toContain("Local-first AI workspace.")
    expect(request.system).toContain("Read repo_docs before answering.")
    expect(request.system).toContain("If the current date or exact time matters, call current_time")
    expect(request.system).toContain("Mandatory first-turn active recall")
    expect(request.system).toContain('operation="read_section", area="notes", sectionId="active_context"')
    expect(request.system).toContain("Project notes include an `active_context` section")
    expect(request.system).toContain("write one compact entry to project_docs notes `active_context`")
    expect(request.system).toContain("backend-owned `runtime_context` section with compact generated workspace scan facts")
    expect(request.system).toContain("Be human first: warm, curious, grounded, and quietly wise")
    expect(request.system).toContain("Translate them into plain human language before speaking")
    expect(request.system).toContain("do not give a backend status report")
    expect(request.system).toContain("not a status daemon narrating its database")
    expect(request.system).not.toContain("Current date: 2026-06-19")
    expect(request.system).not.toContain("Current timestamp: 2026-06-19T06:30:00.000Z")
    expect(request.system).not.toContain("Time zone: Europe/Vienna")
    expect(request.system).not.toContain("Python Environment Hints")
    expect(request.system).not.toContain("Workspace command environment:")
    expect(request.system).not.toContain("Semantic retrieval status:")
    expect(request.system).toContain("Playwright is bundled by default")
    expect(request.system).toContain('mcp_registry({operation:"list"|"describe"')
    expect(request.system).toContain("Do not simulate extensions")
    expect(request.system).toContain("ask the echo helper")
    expect(request.system).toContain("Do not simulate skills")
    expect(request.system).toContain("named checklist or saved project workflow")
    expect(request.system).toContain("After any list operation, prefer canonical ids")
    expect(request.system).toContain("Use lexical with a concise literal phrase")
    expect(request.system).toContain("Cross-project selectors are not available to the main agent")
    expect(request.system).toContain("Do not begin with guessed absolute cd paths")
    expect(request.system).toContain("Terminal commands start in the active workspace")
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

  it("rejects empty or comment-only Terminal commands before approval", async () => {
    const context = {
      runtimeConfig: { sandboxMode: "workspace_write", approvalMode: "manual" },
    } as Parameters<typeof bashTool.decidePolicy>[1]

    expect(await bashTool.decidePolicy({ command: "   \n\t" }, context)).toMatchObject({
      type: "denied",
      code: "terminal_noop_command",
    })
    expect(await bashTool.decidePolicy({ operation: "start", command: "# note\n# another note" }, context)).toMatchObject({
      type: "denied",
      code: "terminal_noop_command",
    })
    expect(await bashTool.decidePolicy({ command: "# list files\nls" }, context)).toMatchObject({ type: "approval_required" })
  })
})

type ModelRequestLike = Parameters<ModelProvider["countTokens"]>[0]
type CountedRequest = {
  messages: unknown
  toolCount: number
}

const countSubstring = (value: string, needle: string): number => value.split(needle).length - 1

const stringMessageContents = (messages: unknown): string[] =>
  Array.isArray(messages)
    ? messages.flatMap((message) => {
        if (!message || typeof message !== "object" || !("content" in message)) {
          return []
        }
        const content = (message as { content?: unknown }).content
        return typeof content === "string" ? [content] : []
      })
    : []

const snapshotCountRequest = (request: ModelRequestLike): CountedRequest => ({
  messages: JSON.parse(JSON.stringify(request.messages)) as unknown,
  toolCount: request.tools?.length ?? 0,
})

const memoryDocSection = (sectionId: string, content: string) => ({
  sectionId,
  kind: "context",
  tags: ["test"],
  heading: "Active Context",
  content,
  lineStart: 1,
  lineEnd: 3,
  contentHash: `hash_${sectionId}`,
  summary: content,
  tokenEstimate: 10,
})

const projectDocsSectionOutput = (area: "memory" | "notes", sectionId: string, content: string) => ({
  operation: "read_section" as const,
  area,
  path: area === "memory" ? ".socrates/MEMORY.md" : ".socrates/PROJECT_NOTES.md",
  content,
  section: memoryDocSection(sectionId, content),
  truncation: { truncated: false, charLimit: 20_000, returnedLength: content.length },
})

const emptyToolExecutors = (): ToolExecutors => ({
  read: async () => ({
    path: "README.md",
    kind: "file",
    content: "",
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
  }),
  search: async () => ({ mode: "files", query: "", matches: [], totalMatches: 0, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
  url_fetch: async () => ({
    url: "https://example.com",
    finalUrl: "https://example.com",
    status: 200,
    ok: true,
    redirected: false,
    sizeBytes: 0,
    text: "",
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
  }),
  edit: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
  apply_patch: async () => ({ changedFiles: [], diff: "", dryRun: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
  bash: async () => bashOk(),
  current_time: async () => ({
    currentDate: "2026-06-19",
    currentDateTime: "2026-06-19T06:30:00.000Z",
    timeZone: "Europe/Vienna",
    source: "system",
  }),
  trace_retrieve: async () => ({
    results: [],
    totalMatches: 0,
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
    appliedFilters: { operation: "search", scope: "current_conversation", mode: "combined" },
  }),
  tool_docs: async () => ({
    operation: "search",
    results: [],
    totalMatches: 0,
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
  }),
  skills: async () => ({
    operation: "list",
    skills: [],
    totalMatches: 0,
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 2 },
  }),
  project_docs: async () => ({
    operation: "read",
    area: "notes",
    path: ".socrates/PROJECT_NOTES.md",
    content: "",
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
  }),
  repo_docs: async () => ({
    operation: "read",
    paths: [".socrates/repo_docs/REPO_RULES.md"],
    content: "- .socrates/repo_docs/REPO_RULES.md",
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 36 },
  }),
  soul: async () => ({
    operation: "read",
    path: "identity.md",
    content: "",
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
  }),
  user_profile: async () => ({
    operation: "read",
    path: "user_profile.md",
    content: "",
    truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 },
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

const validCompressorSummary = () => ({
  schemaVersion: 1 as const,
  goal: "Continue after compaction.",
  constraints: [],
  done: ["Compressed old context."],
  inProgress: [],
  blocked: [],
  decisions: [],
  nextSteps: ["Run the app model call."],
  criticalContext: [],
  relevantFiles: [],
  toolState: [],
  anchors: ["Turn 1: inspect old history."],
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
