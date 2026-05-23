import { describe, expect, it } from "vitest"
import { SocratesAgent, createDefaultToolRegistry, type SocratesAgentEvent, type ToolExecutors } from "../index"
import type { ModelEvent, ModelProvider } from "@socrates/providers"

describe("SocratesAgent", () => {
  it("streams through the provider with Socrates prompt and history", async () => {
    const events: ModelEvent[] = [{ type: "model.answer.delta", text: "Hello" }, { type: "model.completed" }]
    const seen: unknown[] = []
    const provider: ModelProvider = {
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

    expect(streamed).toEqual(events)
    expect(JSON.stringify(seen[0])).toContain("You are Socrates")
    expect(JSON.stringify(seen[0])).toContain("Hi")
  })

  it("exposes exactly the six V1 tools", () => {
    expect(createDefaultToolRegistry().modelDefinitions().map((tool) => tool.name)).toEqual([
      "read",
      "search",
      "edit",
      "bash",
      "trace_retrieve",
      "list_project_resources",
    ])
  })

  it("executes current-turn tool calls and feeds results into a final model step", async () => {
    const seenMessages: unknown[] = []
    let calls = 0
    const provider: ModelProvider = {
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
      bash: async () => ({ command: "pwd", cwd: "/tmp", exitCode: 0, stdout: "", stderr: "", durationMs: 0, timedOut: false, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
      trace_retrieve: async () => ({ traces: [], totalMatches: 0, truncation: { truncated: false, charLimit: 20_000, returnedLength: 0 } }),
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
    expect(JSON.stringify(seenMessages.at(-1))).toContain("tool-result")
    expect(JSON.stringify(seenMessages.at(-1))).toContain("thoughtSignature")
  })

  it("injects user and project context into the system prompt", async () => {
    const seen: unknown[] = []
    const provider: ModelProvider = {
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
    expect(request.system).toContain("Do not hardcode or guess absolute workspace paths")
    expect(request.system).toContain("plt.show()")
  })
})
