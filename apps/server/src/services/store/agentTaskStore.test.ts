import { afterEach, describe, expect, it } from "vitest"
import type { RuntimeConfig } from "@socrates/contracts"
import { eq } from "drizzle-orm"
import { openDatabase, runMigrations, type DatabaseHandle } from "../../db/client"
import { agentTasks, agentTaskTurns, fileOperations, messages, terminalSessions, toolCalls, turns } from "../../db/schema"
import { AgentTaskStore } from "./agentTaskStore"

const handles: DatabaseHandle[] = []

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
})

describe("AgentTaskStore", () => {
  it("persists an event-driven wait, handles the completion race, and creates one continuation", () => {
    const handle = openDatabase(":memory:")
    handles.push(handle)
    runMigrations(handle)
    const tasks = new AgentTaskStore({ handle, appendEvent: () => undefined })
    const now = "2026-07-11T15:00:00.000Z"
    handle.db.insert(terminalSessions).values({
      id: "term_tests",
      projectId: "proj_1",
      conversationId: "conv_1",
      workspacePath: "/tmp/workspace",
      name: "integration-tests",
      command: "pnpm test",
      cwd: "/tmp/workspace",
      status: "running",
      autoDetached: true,
      awaitingInput: false,
      startedAt: now,
      updatedAt: now,
    }).run()
    handle.db.insert(turns).values({ id: "turn_1", sessionId: "sess_1", conversationId: "conv_1", status: "running", startedAt: now }).run()
    const runtimeConfig: RuntimeConfig = {
      providerId: "openai",
      modelId: "gpt-5.4-mini",
      thinkingEnabled: false,
      thinkingEffort: "none",
      approvalMode: "manual",
      sandboxMode: "workspace_write",
    }
    tasks.startTask({ projectId: "proj_1", conversationId: "conv_1", sessionId: "sess_1", turnId: "turn_1", runtimeConfig })

    expect(
      tasks.registerTerminalWait({
        projectId: "proj_1",
        conversationId: "conv_1",
        sessionId: "sess_1",
        turnId: "turn_1",
        runtimeConfig,
        wait: { terminalNames: ["integration-tests"], wakeOn: ["completed", "failed"], reason: "Waiting for integration test results" },
      }),
    ).toMatchObject({ status: "waiting" })

    handle.db.update(terminalSessions).set({ status: "exited", exitCode: 0 }).where(eq(terminalSessions.id, "term_tests")).run()
    const ready = tasks.claimWakeForTerminal("term_tests", "completed")
    expect(ready).toHaveLength(1)
    expect(ready[0]).toMatchObject({ terminalName: "integration-tests", wakeEvent: "completed" })

    const continued = tasks.beginContinuation(ready[0]!)
    expect(continued).toMatchObject({ taskId: ready[0]?.taskId, runtimeConfig })
    expect(tasks.beginContinuation(ready[0]!)).toBeUndefined()
    handle.db.update(turns).set({ status: "cancelled" }).where(eq(turns.id, continued?.turnId ?? "missing")).run()
    expect(tasks.requeueInterruptedContinuations()).toBe(1)
    const recovered = tasks.listReadyTasks()
    expect(recovered).toHaveLength(1)
    const recoveredContinuation = tasks.beginContinuation(recovered[0]!)
    expect(recoveredContinuation).toMatchObject({ taskId: ready[0]?.taskId, runtimeConfig })
    expect(tasks.beginContinuation(recovered[0]!)).toBeUndefined()

    handle.db.insert(terminalSessions).values({
      id: "term_second",
      projectId: "proj_1",
      conversationId: "conv_1",
      workspacePath: "/tmp/workspace",
      name: "second-tests",
      command: "pnpm test:second",
      cwd: "/tmp/workspace",
      status: "running",
      autoDetached: true,
      awaitingInput: false,
      startedAt: now,
      updatedAt: now,
    }).run()
    expect(
      tasks.registerTerminalWait({
        projectId: "proj_1",
        conversationId: "conv_1",
        sessionId: "sess_1",
        turnId: recoveredContinuation?.turnId ?? "missing",
        runtimeConfig,
        wait: { terminalNames: ["second-tests"], wakeOn: ["completed"], reason: "Waiting for second test results" },
      }),
    ).toMatchObject({ status: "waiting" })
    handle.db.update(terminalSessions).set({ status: "exited", exitCode: 0 }).where(eq(terminalSessions.id, "term_second")).run()
    const secondReady = tasks.claimWakeForTerminal("term_second", "completed")
    expect(secondReady[0]?.taskId).toBe(recoveredContinuation?.taskId)
    const finalContinuation = tasks.beginContinuation(secondReady[0]!)
    expect(finalContinuation).toMatchObject({ taskId: recoveredContinuation?.taskId })
    expect(handle.db.select().from(agentTaskTurns).where(eq(agentTaskTurns.taskId, finalContinuation?.taskId ?? "missing")).all()).toHaveLength(4)
    handle.db.update(turns).set({ status: "completed" }).where(eq(turns.id, finalContinuation?.turnId ?? "missing")).run()
    expect(tasks.requeueInterruptedContinuations()).toBe(0)
    expect(handle.db.select({ status: agentTasks.status }).from(agentTasks).where(eq(agentTasks.id, finalContinuation?.taskId ?? "missing")).get()).toEqual({
      status: "completed",
    })
  })

  it("builds bounded lifecycle evidence with durable task-scoped references", () => {
    const handle = openDatabase(":memory:")
    handles.push(handle)
    runMigrations(handle)
    const tasks = new AgentTaskStore({ handle, appendEvent: () => undefined })
    const now = "2026-07-12T10:00:00.000Z"
    const runtimeConfig: RuntimeConfig = {
      providerId: "deepseek",
      modelId: "deepseek-v4-pro",
      thinkingEnabled: false,
      thinkingEffort: "none",
      approvalMode: "manual",
      sandboxMode: "workspace_write",
    }
    handle.db.insert(turns).values({ id: "turn_evidence", sessionId: "sess_1", conversationId: "conv_1", status: "running", startedAt: now }).run()
    handle.db.insert(messages).values({ id: "msg_user", conversationId: "conv_1", sessionId: "sess_1", turnId: "turn_evidence", role: "user", content: "Verify the terminal contract.", contentFormat: "text", status: "completed", createdAt: now }).run()
    tasks.startTask({ projectId: "proj_1", conversationId: "conv_1", sessionId: "sess_1", turnId: "turn_evidence", runtimeConfig })
    handle.db.insert(toolCalls).values({ id: "tcall_failed", conversationId: "conv_1", sessionId: "sess_1", turnId: "turn_evidence", toolName: "bash", status: "failed", argumentsJson: JSON.stringify({ command: "false" }), errorId: "err_1", requiresApproval: false, startedAt: now, completedAt: now }).run()
    handle.db.insert(fileOperations).values({ id: "fop_1", toolCallId: "tcall_failed", conversationId: "conv_1", sessionId: "sess_1", turnId: "turn_evidence", operation: "edit", path: ".socrates/MEMORY.md", status: "completed", startedAt: now, completedAt: now }).run()

    const overview = tasks.evidenceForTurn("turn_evidence", { operation: "overview", limit: 10, charLimit: 8_000 })
    expect(overview.content).toContain("Verify the terminal contract")
    expect(overview.content).toContain('"tool_name": "bash"')
    expect(overview.references.map((ref) => ref.kind)).toEqual(expect.arrayContaining(["tool_calls", "changed_files"]))
    const toolRef = overview.references.find((ref) => ref.kind === "tool_calls")
    const secondOverview = tasks.evidenceForTurn("turn_evidence", { operation: "overview", limit: 10, charLimit: 8_000 })
    expect(secondOverview.references.find((ref) => ref.kind === "tool_calls")?.id).toBe(toolRef?.id)
    const detail = tasks.evidenceForTurn("turn_evidence", { operation: "inspect", reference: toolRef?.id, limit: 5, charLimit: 2_000 })
    expect(detail.content).toContain("tcall_failed")
    expect(() => tasks.evidenceForTurn("turn_evidence", { operation: "inspect", reference: "evd_not_current", limit: 5, charLimit: 2_000 })).toThrowError(/does not belong/)
  })
})
