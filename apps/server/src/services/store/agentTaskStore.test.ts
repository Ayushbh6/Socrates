import { afterEach, describe, expect, it } from "vitest"
import type { RuntimeConfig } from "@socrates/contracts"
import { eq } from "drizzle-orm"
import { openDatabase, runMigrations, type DatabaseHandle } from "../../db/client"
import { agentTasks, terminalSessions, turns } from "../../db/schema"
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
    handle.db.update(turns).set({ status: "completed" }).where(eq(turns.id, finalContinuation?.turnId ?? "missing")).run()
    expect(tasks.requeueInterruptedContinuations()).toBe(0)
    expect(handle.db.select({ status: agentTasks.status }).from(agentTasks).where(eq(agentTasks.id, finalContinuation?.taskId ?? "missing")).get()).toEqual({
      status: "completed",
    })
  })
})
