import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  assembleV2GoalWorkingContext,
  deriveV2ContextBudget,
  routeV2Goal,
  type V2GoalRouterResult,
} from "@socrates/core"
import { createId, nowIso } from "@socrates/shared"
import { openDatabase, runMigrations, type DatabaseHandle } from "../db/client"
import { V2FlowStore } from "../services/v2/flowStore"

const handles: DatabaseHandle[] = []
const roots: string[] = []

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "socrates-v2-flow-store-"))
  roots.push(root)
  const handle = openDatabase(path.join(root, "socrates.sqlite"))
  handles.push(handle)
  runMigrations(handle)
  seedProject(handle, "proj_one", path.join(root, "one"))
  const store = new V2FlowStore(handle)
  return { root, handle, store }
}

const runtimeConfig = {
  providerId: "openai" as const,
  authMode: "api_key" as const,
  modelId: "gpt-test",
  thinkingEnabled: false,
  approvalMode: "manual" as const,
  sandboxMode: "workspace_write" as const,
  contextWindowTokens: 128_000,
}

const seedProject = (handle: DatabaseHandle, projectId: string, workspacePath: string): void => {
  fs.mkdirSync(workspacePath, { recursive: true })
  const now = nowIso()
  handle.sqlite.prepare(
    "INSERT OR IGNORE INTO users (id, display_name, onboarding_completed, created_at, updated_at) VALUES (?, ?, 1, ?, ?)",
  ).run("user_v2", "V2 User", now, now)
  handle.sqlite.prepare(
    "INSERT INTO projects (id, user_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run(projectId, "user_v2", projectId, now, now)
  handle.sqlite.prepare(
    "INSERT INTO project_workspaces (id, project_id, kind, path, is_primary, status, created_at, updated_at) VALUES (?, ?, 'existing_folder', ?, 1, 'active', ?, ?)",
  ).run(`pws_${projectId}`, projectId, workspacePath, now, now)
}

const forcedCreateResult = (store: V2FlowStore, flowId: string): V2GoalRouterResult => {
  const goals = store.listGoalsForRouter(flowId)
  const foregroundGoal = goals.find((goal) => goal.status === "foreground")
  const foreground = foregroundGoal ? { goal: foregroundGoal, lexicalScore: 0 } : undefined
  return {
    decision: { action: "create", secondaryGoalIds: [], confidence: 0.9, reasonCode: "new_goal" },
    candidates: {
      ...(foreground ? { foreground } : {}),
      parked: [],
      candidates: foreground ? [foreground] : [],
      totalEligibleParked: 0,
      parkedCandidateLimit: 5,
    },
    source: "fallback",
    fallbackReason: "invalid_output",
  }
}

describe("V2FlowStore isolation and lifecycle", () => {
  it("inherits Classic attachment manifests and provider image parts without creating a Classic message", () => {
    const { store } = setup()
    const { flow } = store.ensureFlow("proj_one")
    const attachments = store.createDraftAttachments("proj_one", flow.id, [
      { originalName: "notes.txt", mimeType: "text/plain", data: Buffer.from("inspect this exact text") },
      { originalName: "screen.png", mimeType: "image/png", data: Buffer.from("png-bytes") },
      { originalName: "workflow.zip", mimeType: "application/zip", data: Buffer.from("zip-bytes") },
    ])
    const created = store.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Use these attachments",
      attachmentIds: attachments.map((attachment) => attachment.id),
      runtimeConfig,
    })
    const applied = store.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: forcedCreateResult(store, flow.id),
    })
    const skillZip = attachments.find((attachment) => attachment.kind === "skill_zip")
    if (!skillZip) throw new Error("Expected the V2 skill ZIP attachment")
    const archive = store.readCurrentTurnSkillZip({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      attachmentPath: skillZip.uri,
    })
    expect(archive).toMatchObject({ filename: "workflow.zip", data: Buffer.from("zip-bytes") })
    expect(store.getTurnMemorySource("proj_one", flow.id, created.turn.id)).toEqual({
      messageId: created.userMessage.id,
      messageExcerpt: "Use these attachments",
    })

    const textOnly = store.getModelMessages(flow.id, applied.goal.id, false)
    expect(textOnly).toHaveLength(1)
    expect(textOnly[0]?.content).toEqual(expect.stringContaining(".socrates/attachments/"))
    expect(textOnly[0]?.content).toEqual(expect.stringContaining("skills preview_import"))
    expect(textOnly[0]?.content).toEqual(expect.stringContaining("pixels were not sent"))

    const withVision = store.getModelMessages(flow.id, applied.goal.id, true)
    expect(Array.isArray(withVision[0]?.content)).toBe(true)
    const parts = withVision[0]?.content
    if (!Array.isArray(parts)) throw new Error("Expected multimodal V2 provider content")
    expect(parts[0]).toMatchObject({ type: "text", text: expect.stringContaining("workflow.zip") })
    expect(parts[1]).toMatchObject({
      type: "image",
      mediaType: "image/png",
      fileName: "screen.png",
      data: expect.stringMatching(/^data:image\/png;base64,/),
    })
    expect(store.countV1Rows()).toEqual({
      conversations: 0,
      sessions: 0,
      turns: 0,
      messages: 0,
      message_attachments: 0,
      model_calls: 0,
      tool_calls: 0,
      approvals: 0,
      events: 0,
      terminal_sessions: 0,
      terminal_output_chunks: 0,
      agent_tasks: 0,
      agent_task_waits: 0,
      agent_task_turns: 0,
      message_feedback: 0,
    })
  })

  it("persists a continuous Flow without creating any V1 conversation rows", async () => {
    const { root, store } = setup()
    const baseline = store.countV1Rows()
    const first = store.ensureFlow("proj_one")
    expect(store.ensureFlow("proj_one").flow.id).toBe(first.flow.id)

    const [attachment] = store.createDraftAttachments("proj_one", first.flow.id, [{
      originalName: "overflow.txt",
      mimeType: "text/plain",
      data: Buffer.from("composer overflow"),
    }])
    expect(attachment?.uri).toContain(`${path.sep}.socrates${path.sep}attachments${path.sep}`)
    expect(fs.readFileSync(attachment?.uri ?? "", "utf8")).toBe("composer overflow")

    const created = store.createTurn({
      projectId: "proj_one",
      flowId: first.flow.id,
      clientMessageId: createId("v2msg"),
      content: "Build the seamless Flow runtime",
      attachmentIds: attachment ? [attachment.id] : [],
      runtimeConfig,
    })
    const routed = await routeV2Goal({
      projectId: "proj_one",
      flowId: first.flow.id,
      turnId: created.turn.id,
      workspacePath: path.join(root, "one"),
      userMessage: created.userMessage.content,
      goals: store.listGoalsForRouter(first.flow.id),
      capsules: store.listCapsulesForRouter(first.flow.id),
    })
    const applied = store.applyRouting({
      projectId: "proj_one",
      flowId: first.flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: routed,
    })
    expect(applied.goal.status).toBe("foreground")
    const assistant = store.completeTurn({
      projectId: "proj_one",
      flowId: first.flow.id,
      turnId: created.turn.id,
      content: "The isolated V2 runtime is underway.",
    })
    expect(assistant.role).toBe("assistant")
    const snapshot = store.getSnapshot("proj_one", first.flow.id)
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant"])
    expect(snapshot.goals).toHaveLength(2)
    expect(snapshot.goals.find((goal) => goal.kind === "general")).toMatchObject({ title: "General Conversation", status: "parked" })
    expect(snapshot.latestCapsules.find((capsule) => capsule.goalId === applied.goal.id)?.version).toBe(2)
    expect(store.countV1Rows()).toEqual(baseline)
    expect(fs.existsSync(path.join(root, "one", ".socrates", "attachments"))).toBe(true)
  })

  it("switches foreground goals atomically, rejects overlapping same-Flow turns, and permits another project", async () => {
    const { root, handle, store } = setup()
    const flow = store.ensureFlow("proj_one").flow
    const first = store.createTurn({ projectId: "proj_one", flowId: flow.id, clientMessageId: createId("v2msg"), content: "First goal", runtimeConfig })
    store.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: first.turn.id,
      messageId: first.userMessage.id,
      messageContent: first.userMessage.content,
      result: await routeV2Goal({
        projectId: "proj_one",
        flowId: flow.id,
        turnId: first.turn.id,
        workspacePath: path.join(root, "one"),
        userMessage: first.userMessage.content,
        goals: [],
      }),
    })
    store.completeTurn({ projectId: "proj_one", flowId: flow.id, turnId: first.turn.id, content: "First response" })

    const second = store.createTurn({ projectId: "proj_one", flowId: flow.id, clientMessageId: createId("v2msg"), content: "A completely different second goal", runtimeConfig })
    store.applyRouting({ projectId: "proj_one", flowId: flow.id, turnId: second.turn.id, messageId: second.userMessage.id, messageContent: second.userMessage.content, result: forcedCreateResult(store, flow.id) })
    const goals = store.getSnapshot("proj_one", flow.id).goals
    expect(goals.filter((goal) => goal.status === "foreground")).toHaveLength(1)
    expect(goals.filter((goal) => goal.status === "parked")).toHaveLength(2)
    expect(() => store.createTurn({ projectId: "proj_one", flowId: flow.id, clientMessageId: createId("v2msg"), content: "overlap", runtimeConfig })).toThrow(/already working/i)

    seedProject(handle, "proj_two", path.join(root, "two"))
    const otherFlow = store.ensureFlow("proj_two").flow
    expect(() => store.createTurn({ projectId: "proj_two", flowId: otherFlow.id, clientMessageId: createId("v2msg"), content: "parallel project", runtimeConfig })).not.toThrow()
    expect(store.recoverInterruptedTurns()).toBe(2)
    expect(store.getSnapshot("proj_one", flow.id).activeTurn).toBeUndefined()
    expect(store.getSnapshot("proj_two", otherFlow.id).activeTurn).toBeUndefined()
  })

  it("durably waits, wakes, and requeues the same V2 task across restart recovery", () => {
    const { handle, store } = setup()
    const baselineV1Rows = store.countV1Rows()
    const flow = store.ensureFlow("proj_one").flow
    const created = store.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Run the durable background check",
      runtimeConfig,
    })
    const applied = store.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: created.turn.id,
      messageId: created.userMessage.id,
      messageContent: created.userMessage.content,
      result: forcedCreateResult(store, flow.id),
    })
    const terminal = store.createTerminal({
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      name: "background-check",
      command: "sleep 1",
      cwd: path.join(handle.sqlite.name, ".."),
      metadata: { inputMode: "none", supervisorOutputSequence: 0, modelVisibleOutputSequence: 0 },
    })
    store.updateTerminal(terminal.id, { status: "running", processId: "proc_test" })

    expect(store.registerTerminalWait({
      projectId: "proj_one",
      flowId: flow.id,
      goalId: applied.goal.id,
      turnId: created.turn.id,
      wait: { terminalNames: ["background-check"], wakeOn: ["completed", "failed"], reason: "Waiting for background check" },
    })).toMatchObject({ status: "waiting" })
    expect(store.getTurn("proj_one", flow.id, created.turn.id).status).toBe("waiting")
    expect(store.recoverInterruptedTurns()).toBe(0)

    store.appendTerminalOutput(terminal.id, "pty", "all checks passed\n")
    store.updateTerminal(terminal.id, { status: "exited", exitCode: 0, completedAt: nowIso() })
    const [ready] = store.claimTerminalTaskWake(terminal.id, "completed")
    expect(ready).toMatchObject({
      rootTurnId: created.turn.id,
      currentTurnId: created.turn.id,
      wakeEvent: "completed",
      terminalName: "background-check",
    })
    expect(store.getTurn("proj_one", flow.id, created.turn.id).status).toBe("suspended")

    const firstContinuation = ready ? store.beginTerminalTaskContinuation(ready) : undefined
    expect(firstContinuation?.turn.status).toBe("running")
    expect(firstContinuation?.userMessage.id).toBe(created.userMessage.id)
    expect(firstContinuation?.wakeContext).toContain("all checks passed")
    expect(store.getTurnMemorySource("proj_one", flow.id, firstContinuation?.turn.id ?? "missing")).toEqual({
      messageId: created.userMessage.id,
      messageExcerpt: created.userMessage.content,
    })

    // Simulate a server exit after the wake was claimed but before the resumed
    // model call completed. Recovery requeues the same v2_agent_tasks row.
    const taskIdBefore = (handle.sqlite.prepare("SELECT id FROM v2_agent_tasks WHERE root_turn_id = ?").get(created.turn.id) as { id: string }).id
    expect(store.recoverInterruptedTurns()).toBe(1)
    const [recovered] = store.listReadyTerminalTasks()
    expect(recovered).toMatchObject({ taskId: taskIdBefore, rootTurnId: created.turn.id, wakeEvent: "completed" })
    const secondContinuation = recovered ? store.beginTerminalTaskContinuation(recovered) : undefined
    expect(secondContinuation?.taskId).toBe(taskIdBefore)
    expect(secondContinuation?.turn.id).not.toBe(firstContinuation?.turn.id)
    expect(store.countV1Rows()).toEqual(baselineV1Rows)
  })

  it("bounds long-Flow snapshots, message pages, model history, capsules, and lazy active evidence", async () => {
    const { handle, store } = setup()
    const baselineV1Rows = store.countV1Rows()
    const flow = store.ensureFlow("proj_one").flow
    const first = store.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Start the durable long Flow",
      runtimeConfig,
    })
    const goal = store.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: first.turn.id,
      messageId: first.userMessage.id,
      messageContent: first.userMessage.content,
      result: forcedCreateResult(store, flow.id),
    }).goal
    store.completeTurn({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: first.turn.id,
      content: "The long Flow is active.",
    })

    const insertMessage = handle.sqlite.prepare(`
      INSERT INTO v2_messages (
        id, flow_id, project_id, goal_id, ordinal, role, content,
        content_format, status, created_at, completed_at
      ) VALUES (?, ?, 'proj_one', ?, ?, ?, ?, 'markdown', 'completed', ?, ?)
    `)
    const insertEvidence = handle.sqlite.prepare(`
      INSERT INTO v2_evidence_items (
        id, handle, flow_id, project_id, goal_id, source_kind, title,
        content, content_hash, size_bytes, token_estimate, created_at
      ) VALUES (?, ?, ?, 'proj_one', ?, 'retrieval_chunk', ?, ?, ?, 4000, 1000, ?)
    `)
    const insertContext = handle.sqlite.prepare(`
      INSERT INTO v2_context_items (
        id, flow_id, goal_id, kind, state, content, token_estimate, rank,
        active_from_turn_ordinal, released_at_turn_ordinal, created_at, updated_at
      ) VALUES (?, ?, ?, 'evidence_exact', ?, ?, 1000, ?, 1, ?, ?, ?)
    `)
    const insertSource = handle.sqlite.prepare(`
      INSERT INTO v2_context_item_sources (
        id, context_item_id, evidence_item_id, source_order, created_at
      ) VALUES (?, ?, ?, 0, ?)
    `)
    handle.sqlite.transaction(() => {
      for (let index = 0; index < 650; index += 1) {
        const ordinal = index + 3
        const timestamp = new Date(Date.UTC(2026, 6, 17, 10, 0, index)).toISOString()
        insertMessage.run(
          `v2msg_bulk_${index}`,
          flow.id,
          goal.id,
          ordinal,
          index % 2 === 0 ? "user" : "assistant",
          `Long Flow message ${ordinal}`,
          timestamp,
          timestamp,
        )
      }
      for (let index = 0; index < 600; index += 1) {
        const evidenceId = `v2ev_bulk_${index}`
        const contextItemId = `v2ctx_bulk_${index}`
        const timestamp = new Date(Date.UTC(2026, 6, 18, 10, 0, index)).toISOString()
        const content = "x".repeat(4_000)
        const active = index >= 200
        insertEvidence.run(
          evidenceId,
          `evidence://long-flow/${index}`,
          flow.id,
          goal.id,
          `Long Flow evidence ${index}`,
          content,
          `long-flow-hash-${index}`,
          timestamp,
        )
        insertContext.run(
          contextItemId,
          flow.id,
          goal.id,
          active ? "active" : "released",
          content,
          index % 100,
          active ? null : 1,
          timestamp,
          timestamp,
        )
        insertSource.run(`v2ctxsrc_bulk_${index}`, contextItemId, evidenceId, timestamp)
      }
    })()

    const snapshot = store.getSnapshot("proj_one", flow.id)
    expect(snapshot.messages).toHaveLength(100)
    expect(snapshot.messages[0]?.ordinal).toBe(553)
    expect(snapshot.messages.at(-1)?.ordinal).toBe(652)
    expect(snapshot.messageWindow).toEqual({ hasEarlier: true, beforeOrdinal: 553 })
    const previous = store.listMessages("proj_one", flow.id, snapshot.messageWindow.beforeOrdinal, 75)
    expect(previous.messages).toHaveLength(75)
    expect(previous.messages[0]?.ordinal).toBe(478)
    expect(previous.messages.at(-1)?.ordinal).toBe(552)
    expect(previous.messageWindow).toEqual({ hasEarlier: true, beforeOrdinal: 478 })
    expect(store.getModelMessages(flow.id, goal.id)).toHaveLength(500)
    expect(snapshot.latestCapsules).toHaveLength(2)
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_goal_capsules WHERE flow_id = ?").get(flow.id)).toMatchObject({ count: 4 })

    const lightItems = store.getActiveContextItems(flow.id, goal.id)
    expect(lightItems).toHaveLength(256)
    expect(JSON.stringify(lightItems)).not.toContain("xxxxxxxxxxxxxxxx")
    expect(store.getContextCounts(flow.id)).toEqual({
      immutableEvidenceCount: 600,
      activeItemCount: 400,
      releasedItemCount: 200,
    })
    const retrievedBatches: string[][] = []
    const assembled = await assembleV2GoalWorkingContext({
      foregroundGoalId: goal.id,
      query: "long Flow evidence",
      messages: [],
      contextItems: lightItems,
      budget: deriveV2ContextBudget({ contextWindowTokens: 8_192 }),
      evidenceTokenLimit: 1_000,
      exactRetriever: (refs) => {
        retrievedBatches.push(refs.map((ref) => ref.evidenceId))
        return store.retrieveExactEvidence(flow.id, refs.map((ref) => ref.evidenceId)).map((record) => ({
          evidenceRef: record.ref,
          exactContent: record.exactContent,
        }))
      },
    })
    expect(retrievedBatches[0]).toHaveLength(1)
    expect(assembled.exactEvidence).toHaveLength(1)
    expect(assembled.estimatedTokens).toBeLessThanOrEqual(1_000)
    expect(store.retrieveExactEvidence(flow.id, ["v2ev_bulk_0"])[0]?.exactContent).toHaveLength(4_000)
    expect(store.countV1Rows()).toEqual(baselineV1Rows)
  })

  it("releases only active context while immutable exact evidence remains retrievable", () => {
    const { handle, store } = setup()
    const flow = store.ensureFlow("proj_one").flow
    const turn = store.createTurn({ projectId: "proj_one", flowId: flow.id, clientMessageId: createId("v2msg"), content: "Inspect evidence", runtimeConfig })
    const recorded = store.recordEvidence({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: turn.turn.id,
      sourceKind: "pdf_page",
      title: "Page 7",
      content: "The exact source statement remains immutable.",
    })
    expect(recorded.contextItem).toBeDefined()
    expect(() => handle.sqlite.prepare("UPDATE v2_evidence_items SET content = 'changed' WHERE id = ?").run(recorded.evidence.id)).toThrow()
    expect(() => handle.sqlite.prepare("DELETE FROM v2_evidence_items WHERE id = ?").run(recorded.evidence.id)).toThrow()

    store.persistContextDispositions({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: turn.turn.id,
      decisions: [{ contextItemId: recorded.contextItem?.id ?? "missing", disposition: "release" }],
      completedTurn: 1,
    })
    const state = store.getCoreContextState(flow.id)
    expect(state.items[0]?.active).toBe(false)
    expect(state.evidence[0]?.exactContent).toBe("The exact source statement remains immutable.")
    expect(store.retrieveExactEvidence(flow.id, [recorded.evidence.id])[0]?.exactContent).toContain("exact source")
  })

  it("enforces five unresolved items and the original three-turn review deadline", () => {
    const { store } = setup()
    const flow = store.ensureFlow("proj_one").flow
    const turn = store.createTurn({ projectId: "proj_one", flowId: flow.id, clientMessageId: createId("v2msg"), content: "Bound unresolved context", runtimeConfig })
    const contextIds = Array.from({ length: 6 }, (_, index) => store.recordEvidence({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: turn.turn.id,
      sourceKind: "retrieval_chunk",
      title: `Chunk ${index + 1}`,
      content: `Evidence ${index + 1}`,
    }).contextItem?.id ?? "missing")
    expect(() => store.persistContextDispositions({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: turn.turn.id,
      decisions: contextIds.map((contextItemId) => ({ contextItemId, disposition: "unresolved" as const })),
      completedTurn: 1,
    })).toThrow(/at most five/i)

    store.persistContextDispositions({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: turn.turn.id,
      decisions: [{ contextItemId: contextIds[0] ?? "missing", disposition: "unresolved" }],
      completedTurn: 1,
    })
    expect(() => store.persistContextDispositions({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: turn.turn.id,
      decisions: [{ contextItemId: contextIds[0] ?? "missing", disposition: "unresolved" }],
      completedTurn: 4,
    })).toThrow(/must now be kept, distilled, or released/i)
  })

  it("keeps parked-goal capsules resumable without rewriting every trivial turn", () => {
    const { store } = setup()
    const flow = store.ensureFlow("proj_one").flow
    const first = store.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "We must keep V1 and V2 separate. Implement the shared inheritance boundary.",
      runtimeConfig,
    })
    const createdGoal = store.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: first.turn.id,
      messageId: first.userMessage.id,
      messageContent: first.userMessage.content,
      result: forcedCreateResult(store, flow.id),
    }).goal
    store.completeTurn({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: first.turn.id,
      content: "The shared-memory boundary is implemented and Classic remains isolated.",
    })
    const firstCapsule = store.getSnapshot("proj_one", flow.id).latestCapsules.find((item) => item.goalId === createdGoal.id)
    expect(firstCapsule).toMatchObject({ version: 2, status: "active" })
    if (!firstCapsule) throw new Error("Expected the first resumable capsule")
    expect(firstCapsule?.summary).toContain("Objective:")
    expect(firstCapsule?.summary).toContain("Latest request:")
    expect(firstCapsule?.summary).toContain("Latest outcome:")
    expect(firstCapsule?.decisions.join(" ")).toContain("must keep V1 and V2 separate")

    const second = store.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Thanks.",
      runtimeConfig,
    })
    const continueResult: V2GoalRouterResult = {
      decision: {
        action: "continue",
        primaryGoalId: createdGoal.id,
        secondaryGoalIds: [],
        confidence: 0.99,
        reasonCode: "foreground_continuation",
      },
      candidates: {
        foreground: { goal: createdGoal, capsule: firstCapsule, lexicalScore: 1 },
        parked: [],
        candidates: [{ goal: createdGoal, capsule: firstCapsule, lexicalScore: 1 }],
        totalEligibleParked: 0,
        parkedCandidateLimit: 5,
      },
      source: "fallback",
      fallbackReason: "invalid_output",
    }
    store.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: second.turn.id,
      messageId: second.userMessage.id,
      messageContent: second.userMessage.content,
      result: continueResult,
    })
    store.completeTurn({ projectId: "proj_one", flowId: flow.id, turnId: second.turn.id, content: "Done." })
    expect(store.getSnapshot("proj_one", flow.id).latestCapsules.find((item) => item.goalId === createdGoal.id)?.version).toBe(2)

    const third = store.createTurn({
      projectId: "proj_one",
      flowId: flow.id,
      clientMessageId: createId("v2msg"),
      content: "Start an unrelated speech task.",
      runtimeConfig,
    })
    store.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: third.turn.id,
      messageId: third.userMessage.id,
      messageContent: third.userMessage.content,
      result: forcedCreateResult(store, flow.id),
    })
    const parkedCapsule = store.getSnapshot("proj_one", flow.id).latestCapsules.find((item) => item.goalId === createdGoal.id)
    expect(parkedCapsule).toMatchObject({ version: 3, status: "active" })
    expect(parkedCapsule?.summary).toContain("Latest request: Thanks.")
    expect(parkedCapsule?.summary).toContain("State: parked")
    expect(firstCapsule?.decisions).toEqual(expect.arrayContaining(parkedCapsule?.decisions ?? []))
  })

  it("keeps one General Conversation, lets Socrates complete only the bound work focus, and safely auto-archives paused work", () => {
    const { handle, store } = setup()
    const initial = store.ensureFlow("proj_one")
    const general = initial.goals.find((goal) => goal.kind === "general")
    expect(general).toMatchObject({ title: "General Conversation", status: "foreground", pinned: true })
    if (!general) throw new Error("Expected General Conversation")

    const turn = store.createTurn({
      projectId: "proj_one",
      flowId: initial.flow.id,
      clientMessageId: createId("v2msg"),
      content: "Implement the durable focus ledger",
      runtimeConfig,
    })
    const work = store.applyRouting({
      projectId: "proj_one",
      flowId: initial.flow.id,
      turnId: turn.turn.id,
      messageId: turn.userMessage.id,
      messageContent: turn.userMessage.content,
      result: forcedCreateResult(store, initial.flow.id),
    }).goal
    const ledger = store.useFocusLedger({
      projectId: "proj_one",
      flowId: initial.flow.id,
      goalId: work.id,
      turnId: turn.turn.id,
      request: { operation: "complete_current", outcome: "The ledger is implemented and verified." },
    })
    expect(ledger.pendingCompletion).toBe(true)
    const completed = store.completeTurn({ projectId: "proj_one", flowId: initial.flow.id, turnId: turn.turn.id, content: "Done." })
    expect(completed.content).toContain("The ledger is implemented and verified.")
    expect(completed.content).toContain("Done.")
    let snapshot = store.getSnapshot("proj_one", initial.flow.id)
    expect(snapshot.goals.find((goal) => goal.id === work.id)?.status).toBe("completed")
    expect(snapshot.foregroundGoal).toMatchObject({ id: general.id, status: "foreground" })
    expect(() => store.updateFocus({ projectId: "proj_one", flowId: initial.flow.id, goalId: general.id, action: "finish" })).toThrow(/cannot be finished/i)

    store.updateFocus({ projectId: "proj_one", flowId: initial.flow.id, goalId: work.id, action: "reopen" })
    store.updateFocus({ projectId: "proj_one", flowId: initial.flow.id, goalId: work.id, action: "pause" })
    handle.sqlite.prepare("UPDATE v2_goals SET last_active_at = ?, pinned = 0 WHERE id = ?").run("2026-07-01T00:00:00.000Z", work.id)
    expect(store.archiveDormantGoals("proj_one", initial.flow.id, new Date("2026-07-17T12:00:00.000Z"))).toHaveLength(1)
    snapshot = store.getSnapshot("proj_one", initial.flow.id)
    expect(snapshot.goals.find((goal) => goal.id === work.id)?.status).toBe("archived")
    expect(snapshot.foregroundGoal?.id).toBe(general.id)
  })

  it("persists one routing clarification on the original turn and resumes without creating a second task", () => {
    const { handle, store } = setup()
    const flow = store.ensureFlow("proj_one").flow
    const first = store.createTurn({ projectId: "proj_one", flowId: flow.id, clientMessageId: createId("v2msg"), content: "Implement authentication tests", runtimeConfig })
    const work = store.applyRouting({ projectId: "proj_one", flowId: flow.id, turnId: first.turn.id, messageId: first.userMessage.id, messageContent: first.userMessage.content, result: forcedCreateResult(store, flow.id) }).goal
    store.completeTurn({ projectId: "proj_one", flowId: flow.id, turnId: first.turn.id, content: "Initial authentication work is ready." })

    const ambiguous = store.createTurn({ projectId: "proj_one", flowId: flow.id, clientMessageId: createId("v2msg"), content: "What about the second one?", runtimeConfig })
    const goals = store.listGoalsForRouter(flow.id)
    const candidates = goals.map((goal) => ({ goal, lexicalScore: 0.2 }))
    const clarification = store.requestRoutingClarification({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: ambiguous.turn.id,
      messageId: ambiguous.userMessage.id,
      result: {
        decision: {
          action: "clarify",
          secondaryGoalIds: [],
          confidence: 0.31,
          reasonCode: "ambiguous_focus",
          clarificationQuestion: "Do you mean General Conversation or authentication tests?",
          clarificationGoalIds: [goals[0]!.id, work.id],
        },
        candidates: { ...(candidates.find((item) => item.goal.status === "foreground") ? { foreground: candidates.find((item) => item.goal.status === "foreground")! } : {}), parked: candidates.filter((item) => item.goal.status !== "foreground"), candidates, totalEligibleParked: candidates.length - 1, parkedCandidateLimit: 5 },
        source: "model",
      },
    })
    expect(clarification.turn.status).toBe("awaiting_clarification")
    expect(store.getSnapshot("proj_one", flow.id).pendingClarification?.id).toBe(clarification.routingRun.id)
    const turnCount = (handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_turns WHERE flow_id = ?").get(flow.id) as { count: number }).count
    const resolved = store.resolveRoutingClarification({
      projectId: "proj_one",
      flowId: flow.id,
      routingRunId: clarification.routingRun.id,
      answerMessageId: createId("v2msg"),
      answer: "The authentication tests focus.",
    })
    expect((handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_turns WHERE flow_id = ?").get(flow.id) as { count: number }).count).toBe(turnCount)
    const workCandidate = candidates.find((item) => item.goal.id === work.id)!
    store.applyRouting({
      projectId: "proj_one",
      flowId: flow.id,
      turnId: ambiguous.turn.id,
      messageId: ambiguous.userMessage.id,
      messageContent: ambiguous.userMessage.content,
      result: {
        decision: { action: work.status === "foreground" ? "continue" : "resume", primaryGoalId: work.id, secondaryGoalIds: [], confidence: 0.99, reasonCode: "model_match" },
        candidates: { ...(candidates.find((item) => item.goal.status === "foreground") ? { foreground: candidates.find((item) => item.goal.status === "foreground")! } : {}), parked: candidates.filter((item) => item.goal.status !== "foreground"), candidates, totalEligibleParked: candidates.length - 1, parkedCandidateLimit: 5 },
        source: "model",
      },
    })
    expect(resolved.answerMessage.kind).toBe("routing_clarification")
    expect(store.getSnapshot("proj_one", flow.id).pendingClarification).toBeUndefined()
    expect(workCandidate.goal.id).toBe(work.id)
  })

  it("mirrors visible V2 turns one-to-one into Classic and enforces bridge write ownership", () => {
    const { handle, store } = setup()
    const flow = store.ensureFlow("proj_one").flow
    const turn = store.createTurn({ projectId: "proj_one", flowId: flow.id, clientMessageId: createId("v2msg"), content: "Build the bridge", runtimeConfig })
    const work = store.applyRouting({ projectId: "proj_one", flowId: flow.id, turnId: turn.turn.id, messageId: turn.userMessage.id, messageContent: turn.userMessage.content, result: forcedCreateResult(store, flow.id) }).goal
    store.completeTurn({ projectId: "proj_one", flowId: flow.id, turnId: turn.turn.id, content: "Bridge built." })
    const bridge = store.getClassicBridge("proj_one", flow.id, work.id)
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_classic_message_links WHERE bridge_id = ?").get(bridge.id)).toMatchObject({ count: 2 })
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?").get(bridge.conversationId)).toMatchObject({ count: 2 })
    expect(store.openFocusInClassic("proj_one", flow.id, work.id)).toMatchObject({ activeOwner: "classic" })
    expect(() => store.assertV2FocusOwnership("proj_one", flow.id, work.id)).toThrow(/owned by Classic/i)
    const resumed = store.continueClassicConversationInSeamless("proj_one", bridge.conversationId)
    expect(resumed.foregroundGoal?.id).toBe(work.id)
    expect(() => store.assertV2FocusOwnership("proj_one", flow.id, work.id)).not.toThrow()
    expect(handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_classic_message_links WHERE bridge_id = ?").get(bridge.id)).toMatchObject({ count: 2 })
  })
})
