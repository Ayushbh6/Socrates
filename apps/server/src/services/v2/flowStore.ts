import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_SKILL_ZIP_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENT_BYTES,
  type FocusLedgerToolInput,
  type FocusLedgerToolOutput,
  type GoalFinalization,
  V2_FLOW_MESSAGE_PAGE_MAX,
  V2_FLOW_SNAPSHOT_MESSAGE_LIMIT,
  type V2Approval,
  type TerminalWaitWakeOn,
  type WaitToolInput,
  type V2Artifact,
  type V2ContextDisposition,
  type V2ContextItem,
  type V2CreateSpeechJobRequest,
  type V2CredentialInputRequest,
  type V2Error,
  type V2EvidenceItem,
  type V2Feedback,
  type V2Flow,
  type V2FlowSnapshot,
  type V2Goal,
  type V2GoalCapsule,
  type V2GoalMessageLink,
  type V2GoalRoutingRun,
  type V2GoalTransition,
  type V2GoalRouterOutput,
  type V2Message,
  type V2MessageAttachment,
  type V2MessageWindow,
  type V2ModelCall,
  type V2RuntimeConfig,
  type V2RuntimeEvent,
  type V2SpeechJob,
  type V2Terminal,
  type V2ToolCall,
  type V2Turn,
  type V2UsageEvent,
  v2RuntimeConfigSchema,
} from "@socrates/contracts"
import type { V2SpeechArtifactContent, V2SpeechJobUpdate } from "../../routes/v2SpeechRoutes"
import type {
  ImmutableEvidenceRecord,
  ActiveGoalCard,
  GoalCandidateCard,
  V2ContextDispositionDecision,
  V2ContextItem as CoreV2ContextItem,
  V2ContextState,
  V2GoalRoutingDecision,
  V2GoalRouterResult,
} from "@socrates/core"
import type { ModelMessage } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { storeAttachmentFile } from "@socrates/workspace"
import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm"
import type { DatabaseHandle } from "../../db/client"
import {
  conversations,
  messageAttachments,
  messages,
  projects,
  projectWorkspaces,
  sessions,
  turns,
  v2AgentTasks,
  v2Approvals,
  v2Artifacts,
  v2ContextDispositions,
  v2ContextItemSources,
  v2ContextItems,
  v2CredentialInputRequests,
  v2DeletionAuthorizations,
  v2Errors,
  v2EvidenceItems,
  v2Feedback,
  v2Flows,
  v2GoalCapsules,
  v2GoalMessageLinks,
  v2GoalRoutingRuns,
  v2Goals,
  v2GoalTransitions,
  v2ClassicConversationBridges,
  v2ClassicMessageLinks,
  v2ClassicTurnGoalLinks,
  v2GoalClassicHomes,
  v2MessageAttachments,
  v2Messages,
  v2ModelCalls,
  v2RuntimeEvents,
  v2SpeechJobs,
  v2TerminalOutputChunks,
  v2TerminalSessions,
  v2ToolCalls,
  v2TurnRuntimeConfigs,
  v2Turns,
  v2UsageEvents,
} from "../../db/schema"

const ACTIVE_TURN_STATUSES = ["queued", "routing", "awaiting_clarification", "running", "waiting"] as const
const ACTIVE_TERMINAL_STATUSES = ["starting", "running", "awaiting_input", "detached"] as const
const V2_MODEL_MESSAGE_LOAD_LIMIT = 500
export const V2_ACTIVE_CONTEXT_ITEM_LOAD_LIMIT = 256

export type V2TerminalRuntimeRecord = {
  terminal: V2Terminal
  workspacePath: string
  processId?: string
  platform?: string
  shellKind?: string
  shellExecutable?: string
  signal?: string
  autoDetached: boolean
  lastPrompt?: string
  supervisorOutputSequence: number
  modelVisibleOutputSequence: number
  inputMode: "none" | "user"
  metadata: Record<string, unknown>
}

export type V2ReadyTerminalTask = {
  taskId: string
  terminalId: string
  projectId: string
  flowId: string
  goalId: string
  rootTurnId: string
  currentTurnId: string
  runtimeConfig: V2RuntimeConfig
  reason: string
  terminalName: string
  terminalStatus: V2Terminal["status"]
  exitCode?: number
  wakeEvent: TerminalWaitWakeOn
  suspendedTurn: V2Turn
}

export type V2ContinuedTerminalTask = V2ReadyTerminalTask & {
  turn: V2Turn
  userMessage: V2Message
  runtimeConfigId: string
  wakeContext: string
}

export type ClassicConversationDeletionScope = "classic_only" | "everywhere"

export type V2TaskLineage = {
  taskId: string
  rootTurnId: string
  currentTurnId: string
  turnIds: string[]
  status: string
  resumedCount: number
}

const DEFAULT_CONTEXT_POLICY = {
  unresolvedMaxItems: 5,
  unresolvedMaxAgeTurns: 3,
  softPressurePercent: 65,
  hardPressurePercent: 80,
  targetAfterCompactionPercent: 40,
} as const

type UploadedFile = { originalName: string; data: Buffer; mimeType?: string }

export type V2ContextPersistenceDecision = V2ContextDispositionDecision & Readonly<{
  decidedBy?: V2ContextDisposition["decidedBy"]
  reason?: string
  distillationInstruction?: string
  replacementContextItemId?: string
}>

type CreatedV2Turn = {
  flow: V2Flow
  turn: V2Turn
  userMessage: V2Message
  runtimeConfigId: string
}

type RoutingApplication = {
  routingRun: V2GoalRoutingRun
  goal: V2Goal
  transition?: V2GoalTransition
}

export type ClassicGoalRoutingContext = Readonly<{
  flowId: string
  currentGoalCandidate?: number
  candidates: readonly GoalCandidateCard[]
}>

export type V2MessagePage = Readonly<{
  messages: V2Message[]
  messageWindow: V2MessageWindow
}>

export type V2ContextCounts = Readonly<{
  immutableEvidenceCount: number
  activeItemCount: number
  releasedItemCount: number
}>

export class V2FlowStore {
  constructor(private readonly handle: DatabaseHandle) {}

  ensureFlow(projectId: string): V2FlowSnapshot {
    this.requireProject(projectId)
    const operation = this.handle.sqlite.transaction(() => {
      let row = this.handle.db.select().from(v2Flows).where(eq(v2Flows.projectId, projectId)).limit(1).get()
      if (!row) {
        const now = nowIso()
        this.handle.db
          .insert(v2Flows)
          .values({
            id: createId("v2flow"),
            projectId,
            status: "active",
            contextPolicyJson: JSON.stringify(DEFAULT_CONTEXT_POLICY),
            revision: 0,
            lastEventSequence: 0,
            createdAt: now,
            updatedAt: now,
          })
          .run()
        row = this.handle.db.select().from(v2Flows).where(eq(v2Flows.projectId, projectId)).limit(1).get()
      }
      if (!row) throw new SocratesError("v2_flow_create_failed", "The Seamless Flow could not be created.")
      let general = this.handle.db
        .select()
        .from(v2Goals)
        .where(and(eq(v2Goals.flowId, row.id), eq(v2Goals.kind, "general")))
        .limit(1)
        .get()
      if (!general) {
        const now = nowIso()
        const status = row.foregroundGoalId ? "parked" : "foreground"
        const id = createId("v2goal")
        this.handle.db.insert(v2Goals).values({
          id,
          flowId: row.id,
          projectId,
          ordinal: this.nextInteger("v2_goals", "ordinal", "flow_id", row.id),
          title: "General Conversation",
          summary: "Greetings, quick questions, recommendations, and other casual conversation that does not need a durable work focus.",
          kind: "general",
          status,
          origin: "system",
          priority: 10,
          pinned: true,
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
        }).run()
        this.insertGoalTransition({
          flowId: row.id,
          goalId: id,
          fromStatus: null,
          toStatus: status,
          reason: "created",
          note: "Created the singleton General Conversation focus.",
          createdAt: now,
        })
        const summary = "General Conversation · ready for casual questions and greetings."
        this.handle.db.insert(v2GoalCapsules).values({
          id: createId("v2cap"),
          flowId: row.id,
          goalId: id,
          version: 1,
          status: "active",
          summary,
          decisionsJson: "[]",
          openQuestionsJson: "[]",
          nextActionsJson: "[]",
          evidenceHandlesJson: "[]",
          sourceThroughSequence: 0,
          tokenEstimate: estimateTokens(summary),
          createdAt: now,
        }).run()
        if (!row.foregroundGoalId) {
          this.handle.db.update(v2Flows).set({ foregroundGoalId: id, revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, row.id)).run()
        }
        general = this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, id)).get()
      }
      if (!general) throw new SocratesError("v2_general_focus_create_failed", "The General Conversation focus could not be created.")
      return { flowId: row.id, generalGoalId: general.id }
    })
    const ensured = operation()
    this.archiveDormantGoals(projectId, ensured.flowId)
    return this.getSnapshot(projectId, ensured.flowId)
  }

  getSnapshot(projectId: string, flowId?: string): V2FlowSnapshot {
    const flowRow = flowId
      ? this.handle.db.select().from(v2Flows).where(and(eq(v2Flows.id, flowId), eq(v2Flows.projectId, projectId))).limit(1).get()
      : this.handle.db.select().from(v2Flows).where(eq(v2Flows.projectId, projectId)).limit(1).get()
    if (!flowRow || flowRow.status === "archived") {
      throw new SocratesError("v2_flow_not_found", "This project does not have an active Seamless Flow.", { recoverable: true })
    }
    const goals = this.handle.db.select().from(v2Goals).where(eq(v2Goals.flowId, flowRow.id)).orderBy(asc(v2Goals.ordinal)).all()
    const messagePage = this.loadMessagePage(flowRow.id, undefined, V2_FLOW_SNAPSHOT_MESSAGE_LIMIT)
    const latestCapsules = this.handle.db
      .select()
      .from(v2GoalCapsules)
      .where(and(eq(v2GoalCapsules.flowId, flowRow.id), eq(v2GoalCapsules.status, "active")))
      .orderBy(asc(v2GoalCapsules.goalId))
      .all()
      .map(mapCapsule)
    const activeTurnRow = this.handle.db
      .select()
      .from(v2Turns)
      .where(and(eq(v2Turns.flowId, flowRow.id), inArray(v2Turns.status, [...ACTIVE_TURN_STATUSES])))
      .orderBy(desc(v2Turns.ordinal))
      .limit(1)
      .get()
    const terminalRows = this.handle.db
      .select()
      .from(v2TerminalSessions)
      .where(and(eq(v2TerminalSessions.flowId, flowRow.id), inArray(v2TerminalSessions.status, [...ACTIVE_TERMINAL_STATUSES])))
      .orderBy(asc(v2TerminalSessions.startedAt))
      .all()
    const approvalRows = this.handle.db
      .select()
      .from(v2Approvals)
      .where(and(eq(v2Approvals.flowId, flowRow.id), eq(v2Approvals.status, "pending")))
      .orderBy(asc(v2Approvals.requestedAt))
      .all()
    const pendingClarificationRow = this.handle.db.select().from(v2GoalRoutingRuns).where(and(
      eq(v2GoalRoutingRuns.flowId, flowRow.id),
      eq(v2GoalRoutingRuns.status, "awaiting_clarification"),
    )).orderBy(desc(v2GoalRoutingRuns.startedAt)).limit(1).get()
    const flow = mapFlow(flowRow)
    const mappedGoals = goals.map(mapGoal)
    return {
      flow,
      ...(flow.foregroundGoalId
        ? { foregroundGoal: mappedGoals.find((goal) => goal.id === flow.foregroundGoalId) }
        : {}),
      goals: mappedGoals,
      latestCapsules,
      messages: messagePage.messages,
      messageWindow: messagePage.messageWindow,
      ...(activeTurnRow ? { activeTurn: mapTurn(activeTurnRow) } : {}),
      activeTerminals: terminalRows.map(mapTerminal),
      pendingApprovals: approvalRows.map(mapApproval),
      ...(pendingClarificationRow ? { pendingClarification: mapRoutingRun(pendingClarificationRow) } : {}),
      lastEventSequence: flowRow.lastEventSequence,
    }
  }

  listMessages(
    projectId: string,
    flowId: string,
    beforeOrdinal?: number,
    limit = V2_FLOW_SNAPSHOT_MESSAGE_LIMIT,
  ): V2MessagePage {
    this.requireFlow(projectId, flowId)
    return this.loadMessagePage(
      flowId,
      beforeOrdinal,
      Math.max(1, Math.min(V2_FLOW_MESSAGE_PAGE_MAX, Math.floor(limit))),
    )
  }

  getFlow(projectId: string, flowId: string): V2Flow {
    return this.getSnapshot(projectId, flowId).flow
  }

  ensureClassicBridge(projectId: string, flowId: string, goalId: string): {
    id: string
    conversationId: string
    sessionId: string
    activeOwner: "v2" | "classic"
  } {
    const existingHome = this.handle.db
      .select()
      .from(v2GoalClassicHomes)
      .where(and(eq(v2GoalClassicHomes.projectId, projectId), eq(v2GoalClassicHomes.flowId, flowId), eq(v2GoalClassicHomes.goalId, goalId)))
      .limit(1)
      .get()
    if (existingHome) {
      const bridge = this.handle.db.select().from(v2ClassicConversationBridges).where(eq(v2ClassicConversationBridges.id, existingHome.bridgeId)).limit(1).get()
      if (!bridge) throw new SocratesError("v2_classic_home_invalid", "The Classic home for this focus is unavailable.", { recoverable: true })
      return { id: bridge.id, conversationId: bridge.conversationId, sessionId: bridge.sessionId, activeOwner: bridge.activeOwner as "v2" | "classic" }
    }
    const created = this.handle.sqlite.transaction(() => {
      const project = this.requireProject(projectId)
      const goal = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.id, goalId), eq(v2Goals.flowId, flowId))).limit(1).get()
      if (!goal) throw new SocratesError("v2_goal_not_found", "The requested focus was not found.", { recoverable: true })
      const workspace = this.handle.db
        .select()
        .from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.isPrimary, true)))
        .limit(1)
        .get()
      const now = nowIso()
      const conversationId = createId("conv")
      const sessionId = createId("sess")
      const bridgeId = createId("v2bridge")
      this.handle.db.insert(conversations).values({
        id: conversationId,
        projectId,
        userId: project.userId,
        title: goal.title,
        status: goal.status === "archived" ? "archived" : "active",
        createdAt: now,
        updatedAt: now,
        ...(goal.status === "archived" ? { archivedAt: now } : {}),
        metadataJson: JSON.stringify({ source: "v2_bridge", flowId, goalId }),
      }).run()
      this.handle.db.insert(sessions).values({
        id: sessionId,
        conversationId,
        projectId,
        projectWorkspaceId: workspace?.id,
        workspacePath: workspace?.path,
        workspaceName: workspace?.path ? path.basename(workspace.path) : undefined,
        gitRepoRoot: workspace?.gitRepoRoot,
        gitBranch: workspace?.gitBranch,
        gitCommit: workspace?.gitCommit,
        status: "active",
        createdAt: now,
        updatedAt: now,
        metadataJson: JSON.stringify({ source: "v2_bridge", flowId, goalId }),
      }).run()
      this.handle.db.insert(v2ClassicConversationBridges).values({
        id: bridgeId,
        projectId,
        flowId,
        goalId,
        conversationId,
        sessionId,
        activeOwner: "v2",
        status: goal.status === "archived" ? "archived" : "active",
        createdAt: now,
        updatedAt: now,
      }).run()
      this.handle.db.insert(v2GoalClassicHomes).values({
        id: createId("v2home"),
        projectId,
        flowId,
        goalId,
        bridgeId,
        conversationId,
        sessionId,
        createdAt: now,
        updatedAt: now,
      }).run()
      return { id: bridgeId, conversationId, sessionId, activeOwner: "v2" as const }
    })
    const bridge = created()
    const completedGoalTurns = this.handle.db
      .select({ id: v2Turns.id })
      .from(v2Turns)
      .where(and(eq(v2Turns.flowId, flowId), eq(v2Turns.goalId, goalId), eq(v2Turns.status, "completed")))
      .orderBy(asc(v2Turns.ordinal))
      .all()
    for (const turn of completedGoalTurns) this.mirrorV2TurnToClassic(projectId, flowId, turn.id)
    return bridge
  }

  getClassicBridge(projectId: string, flowId: string, goalId: string) {
    this.requireFlow(projectId, flowId)
    return this.ensureClassicBridge(projectId, flowId, goalId)
  }

  openFocusInClassic(projectId: string, flowId: string, goalId: string) {
    this.requireFlow(projectId, flowId)
    if (this.hasActiveGoalWork(flowId, goalId)) {
      throw new SocratesError("v2_focus_still_active", "Wait for the current Seamless task, Terminal, or approval before opening this focus in Classic.", { recoverable: true })
    }
    const bridge = this.ensureClassicBridge(projectId, flowId, goalId)
    const now = nowIso()
    this.handle.db.update(v2ClassicConversationBridges).set({ goalId, activeOwner: "classic", updatedAt: now }).where(eq(v2ClassicConversationBridges.id, bridge.id)).run()
    return { ...bridge, activeOwner: "classic" as const }
  }

  continueClassicConversationInSeamless(projectId: string, conversationId: string): V2FlowSnapshot {
    const conversation = this.handle.db.select().from(conversations).where(and(eq(conversations.id, conversationId), eq(conversations.projectId, projectId))).limit(1).get()
    if (!conversation) throw new SocratesError("conversation_not_found", "The Classic conversation was not found.", { recoverable: true })
    const snapshot = this.ensureFlow(projectId)
    let bridge = this.handle.db.select().from(v2ClassicConversationBridges).where(eq(v2ClassicConversationBridges.conversationId, conversationId)).limit(1).get()
    if (!bridge) {
      const session = this.handle.db.select().from(sessions).where(eq(sessions.conversationId, conversationId)).orderBy(desc(sessions.createdAt)).limit(1).get()
      if (!session) throw new SocratesError("session_not_found", "This Classic conversation has no session to bridge.", { recoverable: true })
      const now = nowIso()
      const goalId = createId("v2goal")
      this.handle.sqlite.transaction(() => {
        this.handle.db.insert(v2Goals).values({
          id: goalId,
          flowId: snapshot.flow.id,
          projectId,
          ordinal: this.nextInteger("v2_goals", "ordinal", "flow_id", snapshot.flow.id),
          title: conversation.title?.trim() || "Classic conversation",
          summary: "Continued explicitly from Classic View.",
          kind: "work",
          status: "parked",
          origin: "user",
          priority: 50,
          pinned: false,
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
        }).run()
        this.insertGoalTransition({
          flowId: snapshot.flow.id,
          goalId,
          fromStatus: null,
          toStatus: "parked",
          reason: "created",
          note: "Created by explicit Continue in Seamless handoff.",
          createdAt: now,
        })
        const summaryText = `${conversation.title?.trim() || "Classic conversation"} · imported from Classic View.`
        this.handle.db.insert(v2GoalCapsules).values({
          id: createId("v2cap"), flowId: snapshot.flow.id, goalId, version: 1, status: "active",
          summary: summaryText, decisionsJson: "[]", openQuestionsJson: "[]", nextActionsJson: "[]", evidenceHandlesJson: "[]",
          sourceThroughSequence: 0, tokenEstimate: estimateTokens(summaryText), createdAt: now,
        }).run()
        const bridgeId = createId("v2bridge")
        this.handle.db.insert(v2ClassicConversationBridges).values({
          id: bridgeId, projectId, flowId: snapshot.flow.id, goalId,
          conversationId, sessionId: session.id, activeOwner: "classic", status: "active", createdAt: now, updatedAt: now,
        }).run()
        this.handle.db.insert(v2GoalClassicHomes).values({
          id: createId("v2home"), projectId, flowId: snapshot.flow.id, goalId, bridgeId,
          conversationId, sessionId: session.id, createdAt: now, updatedAt: now,
        }).run()
      })()
      bridge = this.handle.db.select().from(v2ClassicConversationBridges).where(eq(v2ClassicConversationBridges.conversationId, conversationId)).limit(1).get()
    }
    if (!bridge) throw new SocratesError("v2_bridge_create_failed", "The Classic conversation bridge could not be created.")
    const targetGoalId = bridge.goalId
    this.importClassicBridgeTurns(bridge.id)
    const now = nowIso()
    this.handle.db.update(v2ClassicConversationBridges).set({ goalId: targetGoalId, activeOwner: "v2", status: "active", archivedAt: null, updatedAt: now }).where(eq(v2ClassicConversationBridges.id, bridge.id)).run()
    const goal = this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, targetGoalId)).limit(1).get()
    this.updateFocus({
      projectId,
      flowId: bridge.flowId,
      goalId: targetGoalId,
      action: goal?.status === "archived" || goal?.status === "completed" ? "reopen" : "switch",
      note: "Continued from Classic View.",
    })
    return this.getSnapshot(projectId, bridge.flowId)
  }

  assertV2FocusOwnership(projectId: string, flowId: string, goalId: string): void {
    const home = this.handle.db.select().from(v2GoalClassicHomes).where(and(
      eq(v2GoalClassicHomes.projectId, projectId),
      eq(v2GoalClassicHomes.flowId, flowId),
      eq(v2GoalClassicHomes.goalId, goalId),
    )).limit(1).get()
    if (!home) return
    const bridge = this.handle.db.select().from(v2ClassicConversationBridges).where(eq(v2ClassicConversationBridges.id, home.bridgeId)).limit(1).get()
    if (bridge?.activeOwner !== "v2") {
      throw new SocratesError("v2_focus_owned_by_classic", "This focus is currently owned by Classic View. Continue it in Seamless to hand writing back before sending another message.", { recoverable: true })
    }
  }

  listRecentRoutingTurns(flowId: string, limit = 3): Array<{ goalId?: string; user: string; assistant: string }> {
    const rows = this.handle.db.select().from(v2Turns)
      .where(and(eq(v2Turns.flowId, flowId), eq(v2Turns.status, "completed")))
      .orderBy(desc(v2Turns.ordinal))
      .limit(Math.max(1, Math.min(3, limit)))
      .all()
      .reverse()
    return rows.flatMap((turn) => {
      const user = turn.userMessageId ? this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, turn.userMessageId)).limit(1).get() : undefined
      const assistant = turn.assistantMessageId ? this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, turn.assistantMessageId)).limit(1).get() : undefined
      if (!user || !assistant) return []
      return [{ ...(turn.goalId ? { goalId: turn.goalId } : {}), user: user.content, assistant: assistant.content }]
    })
  }

  prepareClassicGoalRouting(
    projectId: string,
    conversationId: string,
    retrievedGoalIds: readonly string[] = [],
  ): ClassicGoalRoutingContext {
    this.requireProject(projectId)
    const conversation = this.handle.db.select().from(conversations).where(and(
      eq(conversations.id, conversationId),
      eq(conversations.projectId, projectId),
    )).limit(1).get()
    if (!conversation) throw new SocratesError("conversation_not_found", "The Classic conversation was not found.", { recoverable: true })
    const snapshot = this.ensureFlow(projectId)
    const latestLink = this.handle.db.select().from(v2ClassicTurnGoalLinks)
      .where(eq(v2ClassicTurnGoalLinks.conversationId, conversationId))
      .orderBy(desc(v2ClassicTurnGoalLinks.updatedAt), desc(v2ClassicTurnGoalLinks.id))
      .limit(1)
      .get()
    const currentGoalId = this.handle.db.select({ goalId: v2ClassicConversationBridges.goalId }).from(v2ClassicConversationBridges)
      .where(eq(v2ClassicConversationBridges.conversationId, conversationId)).limit(1).get()?.goalId
      ?? latestLink?.goalId
    const goals = this.handle.db.select().from(v2Goals).where(and(
      eq(v2Goals.flowId, snapshot.flow.id),
      inArray(v2Goals.status, ["foreground", "parked", "blocked", "completed", "discarded"]),
    )).orderBy(desc(v2Goals.lastActiveAt)).all()
      .filter((goal) => goal.kind === "work" || goal.id === currentGoalId)
    const byId = new Map(goals.map((goal) => [goal.id, goal]))
    const orderedIds = uniqueStrings([
      ...(currentGoalId ? [currentGoalId] : []),
      ...retrievedGoalIds,
      ...goals.map((goal) => goal.id),
    ]).filter((goalId) => byId.has(goalId)).slice(0, 5)
    const latestCapsules = this.handle.db.select().from(v2GoalCapsules)
      .where(and(eq(v2GoalCapsules.flowId, snapshot.flow.id), eq(v2GoalCapsules.status, "active"))).all()
    const capsuleByGoal = new Map(latestCapsules.map((capsule) => [capsule.goalId, capsule]))
    const candidates = orderedIds.map((goalId, index): GoalCandidateCard => {
      const goal = byId.get(goalId)!
      return {
        goalId,
        candidate: index + 1,
        status: goal.status,
        title: goal.title,
        note: capsuleByGoal.get(goalId)?.summary ?? goal.summary ?? "No progress note yet.",
      }
    })
    const currentGoalCandidate = currentGoalId
      ? candidates.find((candidate) => candidate.goalId === currentGoalId)?.candidate
      : undefined
    return {
      flowId: snapshot.flow.id,
      ...(currentGoalCandidate === undefined ? {} : { currentGoalCandidate }),
      candidates,
    }
  }

  applyClassicGoalRoute(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    userMessageId: string
    userMessage: string
    context: ClassicGoalRoutingContext
    route: V2GoalRouterOutput
  }): ActiveGoalCard {
    const candidateByNumber = new Map(input.context.candidates.map((candidate) => [candidate.candidate, candidate]))
    let goalId: string
    const effectiveRoute = input.route.action === "clarify"
      ? input.context.currentGoalCandidate
        ? { action: "use" as const, candidates: [input.context.currentGoalCandidate], title: null }
        : { action: "create" as const, candidates: [], title: deriveGoalTitle(input.userMessage) }
      : input.route
    if (effectiveRoute.action === "use") {
      const selected = candidateByNumber.get(effectiveRoute.candidates[0] ?? -1)
      if (!selected) throw new SocratesError("classic_goal_candidate_invalid", "The Memory Router selected an unavailable goal candidate.", { recoverable: true })
      goalId = selected.goalId
    } else {
      const now = nowIso()
      goalId = createId("v2goal")
      const title = effectiveRoute.title?.trim() || deriveGoalTitle(input.userMessage)
      this.handle.sqlite.transaction(() => {
        this.handle.db.insert(v2Goals).values({
          id: goalId,
          flowId: input.context.flowId,
          projectId: input.projectId,
          ordinal: this.nextInteger("v2_goals", "ordinal", "flow_id", input.context.flowId),
          title,
          summary: input.userMessage.trim().slice(0, 2_000) || title,
          kind: "work",
          status: "parked",
          origin: "router",
          priority: 50,
          pinned: false,
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
        }).run()
        this.insertGoalTransition({
          flowId: input.context.flowId,
          goalId,
          turnId: input.turnId,
          fromStatus: null,
          toStatus: "parked",
          reason: "created",
          note: "Created by the Classic pre-turn Memory Router.",
          createdAt: now,
        })
        this.handle.db.insert(v2GoalCapsules).values({
          id: createId("v2cap"), flowId: input.context.flowId, goalId, version: 1, status: "active",
          summary: input.userMessage.trim().slice(0, 2_000) || title,
          decisionsJson: "[]", openQuestionsJson: "[]", nextActionsJson: JSON.stringify(["Respond to the latest user request."]), evidenceHandlesJson: "[]",
          sourceThroughSequence: 0, tokenEstimate: estimateTokens(input.userMessage), createdByTurnId: input.turnId, createdAt: now,
        }).run()
      })()
    }

    const goalBefore = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.id, goalId), eq(v2Goals.flowId, input.context.flowId))).limit(1).get()
    if (!goalBefore) throw new SocratesError("v2_goal_not_found", "The routed goal was not found.", { recoverable: true })
    this.updateFocus({
      projectId: input.projectId,
      flowId: input.context.flowId,
      goalId,
      action: goalBefore.status === "completed" || goalBefore.status === "discarded" || goalBefore.status === "archived" ? "reopen" : "switch",
      note: "Selected by the Classic pre-turn Memory Router.",
    })
    const now = nowIso()
    let bridge = this.handle.db.select().from(v2ClassicConversationBridges).where(eq(v2ClassicConversationBridges.conversationId, input.conversationId)).limit(1).get()
    if (!bridge) {
      const bridgeId = createId("v2bridge")
      this.handle.db.insert(v2ClassicConversationBridges).values({
        id: bridgeId, projectId: input.projectId, flowId: input.context.flowId, goalId,
        conversationId: input.conversationId, sessionId: input.sessionId, activeOwner: "classic", status: "active", createdAt: now, updatedAt: now,
      }).run()
      bridge = this.handle.db.select().from(v2ClassicConversationBridges).where(eq(v2ClassicConversationBridges.id, bridgeId)).get()
    } else {
      this.handle.db.update(v2ClassicConversationBridges).set({ goalId, sessionId: input.sessionId, activeOwner: "classic", updatedAt: now }).where(eq(v2ClassicConversationBridges.id, bridge.id)).run()
    }
    if (!bridge) throw new SocratesError("v2_bridge_create_failed", "The Classic goal bridge could not be saved.")
    const existingHome = this.handle.db.select().from(v2GoalClassicHomes).where(eq(v2GoalClassicHomes.goalId, goalId)).limit(1).get()
    if (!existingHome) {
      this.handle.db.insert(v2GoalClassicHomes).values({
        id: createId("v2home"), projectId: input.projectId, flowId: input.context.flowId, goalId,
        bridgeId: bridge.id, conversationId: input.conversationId, sessionId: input.sessionId, createdAt: now, updatedAt: now,
      }).run()
    }
    this.handle.db.insert(v2ClassicTurnGoalLinks).values({
      id: createId("v2ctgoal"), projectId: input.projectId, flowId: input.context.flowId, goalId,
      bridgeId: bridge.id, conversationId: input.conversationId, sessionId: input.sessionId,
      turnId: input.turnId, userMessageId: input.userMessageId, createdAt: now, updatedAt: now,
    }).onConflictDoNothing().run()
    const goal = this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, goalId)).get()
    if (!goal) throw new SocratesError("v2_goal_not_found", "The routed goal was not found.")
    return { goalId, title: goal.title, state: goal.status, note: goal.summary ?? "Work is active." }
  }

  finalizeClassicGoal(turnId: string, finalization: GoalFinalization, assistantMessageId?: string): void {
    const link = this.handle.db.select().from(v2ClassicTurnGoalLinks).where(eq(v2ClassicTurnGoalLinks.turnId, turnId)).limit(1).get()
    if (!link) return
    this.finalizeGoal(link.projectId, link.flowId, link.goalId, turnId, finalization)
    this.handle.db.update(v2ClassicTurnGoalLinks).set({ ...(assistantMessageId ? { assistantMessageId } : {}), updatedAt: nowIso() }).where(eq(v2ClassicTurnGoalLinks.id, link.id)).run()
  }

  finalizeGoal(projectId: string, flowId: string, goalId: string, turnId: string, finalization: GoalFinalization): void {
    this.requireFlow(projectId, flowId)
    const goal = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.id, goalId), eq(v2Goals.flowId, flowId))).limit(1).get()
    if (!goal) return
    const now = nowIso()
    const requestedStatus = finalization.state === "active" ? "foreground" : finalization.state
    const nextStatus = goal.kind === "general" ? "foreground" : requestedStatus
    this.handle.sqlite.transaction(() => {
      if (goal.status !== nextStatus) {
        this.handle.db.update(v2Goals).set({
          status: nextStatus,
          summary: finalization.note,
          lastActiveAt: now,
          completedAt: nextStatus === "completed" ? now : null,
          updatedAt: now,
        }).where(eq(v2Goals.id, goal.id)).run()
        this.insertGoalTransition({
          flowId, goalId, turnId, fromStatus: goal.status as V2Goal["status"], toStatus: nextStatus,
          reason: finalization.state === "completed" ? "completed" : finalization.state === "blocked" ? "blocked" : finalization.state === "discarded" ? "discarded" : "router_decision",
          note: finalization.note, createdAt: now,
        })
      } else {
        this.handle.db.update(v2Goals).set({ summary: finalization.note, lastActiveAt: now, updatedAt: now }).where(eq(v2Goals.id, goal.id)).run()
      }
      const flow = this.requireFlow(projectId, flowId)
      if (nextStatus !== "foreground" && flow.foregroundGoalId === goalId) {
        const general = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.flowId, flowId), eq(v2Goals.kind, "general"))).limit(1).get()
        if (general && general.id !== goalId) {
          this.handle.db.update(v2Goals).set({ status: "foreground", lastActiveAt: now, updatedAt: now }).where(eq(v2Goals.id, general.id)).run()
          this.insertGoalTransition({ flowId, goalId: general.id, turnId, fromStatus: general.status as V2Goal["status"], toStatus: "foreground", reason: "resumed", note: "Returned to General Conversation after goal finalization.", createdAt: now })
          this.handle.db.update(v2Flows).set({ foregroundGoalId: general.id, revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, flowId)).run()
        }
      }
    })()
  }

  getClassicGoalForTurn(turnId: string): ActiveGoalCard | undefined {
    const link = this.handle.db.select().from(v2ClassicTurnGoalLinks).where(eq(v2ClassicTurnGoalLinks.turnId, turnId)).limit(1).get()
    if (!link) return undefined
    const goal = this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, link.goalId)).limit(1).get()
    return goal ? { goalId: goal.id, title: goal.title, state: goal.status, note: goal.summary ?? "Work is active." } : undefined
  }

  attachClassicGoalAssistantMessage(turnId: string, assistantMessageId: string): void {
    this.handle.db.update(v2ClassicTurnGoalLinks).set({ assistantMessageId, updatedAt: nowIso() }).where(eq(v2ClassicTurnGoalLinks.turnId, turnId)).run()
  }

  useFocusLedger(input: {
    projectId: string
    flowId: string
    goalId: string
    turnId: string
    request: FocusLedgerToolInput
  }): FocusLedgerToolOutput {
    this.requireFlow(input.projectId, input.flowId)
    const current = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.id, input.goalId), eq(v2Goals.flowId, input.flowId))).limit(1).get()
    if (!current) throw new SocratesError("v2_goal_not_found", "The current focus was not found.")
    let pendingCompletion = false
    if (input.request.operation === "inspect" && input.request.goalId) {
      const inspected = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.id, input.request.goalId), eq(v2Goals.flowId, input.flowId))).limit(1).get()
      if (!inspected) throw new SocratesError("v2_goal_not_found", "The requested focus was not found.", { recoverable: true })
    } else if (input.request.operation === "update_current") {
      this.handle.db.update(v2Goals).set({ summary: input.request.summary, updatedAt: nowIso() }).where(eq(v2Goals.id, current.id)).run()
      this.refreshCapsule(current.id, input.flowId, input.turnId, nowIso(), "ledger_update")
    } else if (input.request.operation === "record_blocker") {
      const task = this.handle.db.select().from(v2AgentTasks).where(eq(v2AgentTasks.currentTurnId, input.turnId)).limit(1).get()
      if (!task) throw new SocratesError("v2_task_not_found", "The current task was not found.")
      const metadata = parseJsonObject(task.metadataJson)
      this.handle.db.update(v2AgentTasks).set({
        metadataJson: JSON.stringify({ ...metadata, focusBlocker: input.request.blocker }),
        updatedAt: nowIso(),
      }).where(eq(v2AgentTasks.id, task.id)).run()
    } else if (input.request.operation === "complete_current") {
      if (current.kind === "general") {
        throw new SocratesError("v2_general_focus_protected", "General Conversation cannot be completed.", { recoverable: true })
      }
      const task = this.handle.db.select().from(v2AgentTasks).where(eq(v2AgentTasks.currentTurnId, input.turnId)).limit(1).get()
      if (!task || task.goalId !== current.id) throw new SocratesError("v2_focus_ledger_scope", "Focus completion is restricted to the focus bound to this task.")
      const metadata = parseJsonObject(task.metadataJson)
      this.handle.db.update(v2AgentTasks).set({
        metadataJson: JSON.stringify({ ...metadata, pendingFocusCompletion: { outcome: input.request.outcome, requestedAt: nowIso() } }),
        updatedAt: nowIso(),
      }).where(eq(v2AgentTasks.id, task.id)).run()
      pendingCompletion = true
    }
    const goals = this.handle.db.select().from(v2Goals).where(eq(v2Goals.flowId, input.flowId)).orderBy(asc(v2Goals.ordinal)).all()
      .filter((goal) => input.request.operation !== "inspect" || !input.request.goalId || goal.id === input.request.goalId)
      .map((goal) => ({
        id: goal.id,
        title: goal.title,
        kind: goal.kind as "general" | "work",
        status: goal.status as V2Goal["status"],
        ...(goal.summary ? { summary: goal.summary } : {}),
        pinned: goal.pinned,
        lastActiveAt: goal.lastActiveAt,
      }))
    return {
      operation: input.request.operation,
      currentGoalId: current.id,
      goals,
      pendingCompletion,
      message: input.request.operation === "complete_current"
        ? "Completion is staged and will commit after the final response is saved. The focus will move to Finished, not Archived, and General Conversation will become current. Now provide the substantive user-facing answer, incorporating the outcome; do not merely confirm completion."
        : input.request.operation === "record_blocker"
          ? "Recorded the blocker on the current task."
          : input.request.operation === "update_current"
            ? "Updated the current focus summary."
            : `Loaded ${goals.length} focus${goals.length === 1 ? "" : "es"}.`,
    }
  }

  updateFocus(input: {
    projectId: string
    flowId: string
    goalId: string
    action: "switch" | "pause" | "finish" | "reopen" | "archive" | "pin" | "unpin"
    note?: string
  }): { goal: V2Goal; transitions: V2GoalTransition[] } {
    const operation = this.handle.sqlite.transaction(() => {
      const flow = this.requireFlow(input.projectId, input.flowId)
      const target = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.id, input.goalId), eq(v2Goals.flowId, input.flowId))).limit(1).get()
      if (!target) throw new SocratesError("v2_goal_not_found", "The requested focus was not found.", { recoverable: true })
      const now = nowIso()
      const transitions: V2GoalTransition[] = []
      if (input.action === "pin" || input.action === "unpin") {
        this.handle.db.update(v2Goals).set({ pinned: input.action === "pin", updatedAt: now }).where(eq(v2Goals.id, target.id)).run()
      } else {
        if (target.kind === "general" && (input.action === "finish" || input.action === "archive")) {
          throw new SocratesError("v2_general_focus_protected", "General Conversation cannot be finished or archived.", { recoverable: true })
        }
        if (input.action === "archive" && this.hasActiveGoalWork(input.flowId, target.id)) {
          throw new SocratesError("v2_focus_still_active", "This focus still has a running task, Terminal, or approval and cannot be archived.", { recoverable: true })
        }
        const current = flow.foregroundGoalId
          ? this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, flow.foregroundGoalId)).limit(1).get()
          : undefined
        const writeTransition = (row: typeof v2Goals.$inferSelect, toStatus: string, reason: V2GoalTransition["reason"], note: string) => {
          if (row.status === toStatus) return
          this.handle.db.update(v2Goals).set({
            status: toStatus,
            lastActiveAt: toStatus === "foreground" ? now : row.lastActiveAt,
            updatedAt: now,
            completedAt: toStatus === "completed" ? now : toStatus === "foreground" ? null : row.completedAt,
            archivedAt: toStatus === "archived" ? now : toStatus === "foreground" ? null : row.archivedAt,
          }).where(eq(v2Goals.id, row.id)).run()
          const inserted = this.insertGoalTransition({
            flowId: input.flowId,
            goalId: row.id,
            fromStatus: row.status as V2Goal["status"],
            toStatus: toStatus as V2Goal["status"],
            reason,
            note,
            createdAt: now,
          })
          transitions.push(mapTransition(inserted))
        }
        if (input.action === "switch" || input.action === "reopen") {
          if (target.status === "archived" && input.action !== "reopen") {
            throw new SocratesError("v2_focus_archived", "Reopen an archived focus before switching to it.", { recoverable: true })
          }
          if (current && current.id !== target.id) writeTransition(current, "parked", "focus_switch", `Paused while switching to ${target.title}.`)
          writeTransition(target, "foreground", input.action === "reopen" ? "reopened" : "user_intent", input.note ?? `Made ${target.title} the current focus.`)
          this.handle.db.update(v2Flows).set({ foregroundGoalId: target.id, revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, input.flowId)).run()
        } else if (input.action === "pause" || input.action === "finish") {
          const nextStatus = input.action === "finish" ? "completed" : "parked"
          writeTransition(target, nextStatus, input.action === "finish" ? "completed" : "user_intent", input.note ?? (input.action === "finish" ? "Marked finished by the user." : "Paused by the user."))
          if (flow.foregroundGoalId === target.id) {
            const general = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.flowId, input.flowId), eq(v2Goals.kind, "general"))).limit(1).get()
            if (general && general.id !== target.id) {
              writeTransition(general, "foreground", "resumed", "Returned to General Conversation.")
              this.handle.db.update(v2Flows).set({ foregroundGoalId: general.id, revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, input.flowId)).run()
            }
          }
        } else if (input.action === "archive") {
          if (target.status === "foreground") throw new SocratesError("v2_focus_current", "Pause or finish the current focus before archiving it.", { recoverable: true })
          writeTransition(target, "archived", "archived", input.note ?? "Archived by the user.")
        }
      }
      const row = this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, target.id)).get()
      if (!row) throw new SocratesError("v2_focus_update_failed", "The focus update could not be saved.")
      return { goal: mapGoal(row), transitions }
    })
    const result = operation()
    const archived = result.goal.status === "archived"
    const home = this.handle.db.select().from(v2GoalClassicHomes).where(eq(v2GoalClassicHomes.goalId, input.goalId)).limit(1).get()
    if (home) {
      this.handle.db.update(v2ClassicConversationBridges).set({ status: archived ? "archived" : "active", archivedAt: archived ? nowIso() : null, updatedAt: nowIso() }).where(eq(v2ClassicConversationBridges.id, home.bridgeId)).run()
      this.handle.db.update(conversations).set({ status: archived ? "archived" : "active", archivedAt: archived ? nowIso() : null, updatedAt: nowIso() }).where(eq(conversations.id, home.conversationId)).run()
    }
    return result
  }

  archiveDormantGoals(projectId: string, flowId: string, now = new Date()): V2Goal[] {
    this.requireFlow(projectId, flowId)
    const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString()
    const candidates = this.handle.db.select().from(v2Goals).where(and(
      eq(v2Goals.flowId, flowId),
      eq(v2Goals.status, "parked"),
      eq(v2Goals.kind, "work"),
      eq(v2Goals.pinned, false),
      lt(v2Goals.lastActiveAt, cutoff),
    )).all()
    const archived: V2Goal[] = []
    for (const goal of candidates) {
      if (this.hasActiveGoalWork(flowId, goal.id)) continue
      archived.push(this.updateFocus({ projectId, flowId, goalId: goal.id, action: "archive", note: "Auto-archived after seven inactive paused days." }).goal)
    }
    return archived
  }

  getClassicConversationDeletionImpact(projectId: string, conversationId: string): { linkedToFlow: boolean } {
    const conversation = this.handle.db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.projectId, projectId), eq(conversations.id, conversationId)))
      .limit(1).get()
    if (!conversation) throw new SocratesError("conversation_not_found", "Conversation not found", { recoverable: true })
    const bridge = this.handle.db.select({ id: v2ClassicConversationBridges.id }).from(v2ClassicConversationBridges)
      .where(and(eq(v2ClassicConversationBridges.projectId, projectId), eq(v2ClassicConversationBridges.conversationId, conversationId)))
      .limit(1).get()
    return { linkedToFlow: Boolean(bridge) }
  }

  deleteClassicConversationProjection(
    projectId: string,
    conversationId: string,
    scope: ClassicConversationDeletionScope,
  ): void {
    const bridge = this.handle.db.select().from(v2ClassicConversationBridges)
      .where(and(eq(v2ClassicConversationBridges.projectId, projectId), eq(v2ClassicConversationBridges.conversationId, conversationId)))
      .limit(1).get()
    if (!bridge) return
    const operation = this.handle.sqlite.transaction(() => {
      if (scope === "everywhere") {
        const turnIds = this.handle.sqlite.prepare(
          `SELECT DISTINCT m.turn_id AS turnId
           FROM v2_classic_message_links l
           INNER JOIN v2_messages m ON m.id = l.v2_message_id
           WHERE l.bridge_id = ? AND m.turn_id IS NOT NULL`,
        ).all(bridge.id).map((row) => (row as { turnId: string }).turnId)
        this.deleteV2TurnsWithinTransaction(turnIds)
      }
      this.handle.sqlite.prepare("DELETE FROM v2_goal_classic_homes WHERE bridge_id = ?").run(bridge.id)
      this.handle.sqlite.prepare("DELETE FROM v2_classic_turn_goal_links WHERE bridge_id = ?").run(bridge.id)
      this.handle.sqlite.prepare("DELETE FROM v2_classic_message_links WHERE bridge_id = ?").run(bridge.id)
      this.handle.sqlite.prepare("DELETE FROM v2_classic_conversation_bridges WHERE id = ?").run(bridge.id)
    })
    operation()
  }

  deleteTurn(projectId: string, flowId: string, turnId: string): { deletedTurnId: string } {
    const turn = this.requireTurn(projectId, flowId, turnId)
    if (ACTIVE_TURN_STATUSES.includes(turn.status as (typeof ACTIVE_TURN_STATUSES)[number])) {
      throw new SocratesError("v2_turn_still_active", "Stop this turn before deleting it.", { recoverable: true })
    }
    const operation = this.handle.sqlite.transaction(() => this.deleteV2TurnsWithinTransaction([turnId]))
    operation()
    return { deletedTurnId: turnId }
  }

  deleteGoal(projectId: string, flowId: string, goalId: string): { deletedGoalId: string; fallbackGoalId: string } {
    const flow = this.requireFlow(projectId, flowId)
    const goal = this.handle.db.select().from(v2Goals)
      .where(and(eq(v2Goals.flowId, flowId), eq(v2Goals.id, goalId)))
      .limit(1).get()
    if (!goal) throw new SocratesError("v2_goal_not_found", "Focus not found", { recoverable: true })
    if (goal.kind === "general") {
      throw new SocratesError("v2_general_focus_protected", "General Conversation cannot be deleted.", { recoverable: true })
    }
    if (this.hasActiveGoalWork(flowId, goalId)) {
      throw new SocratesError("v2_focus_still_active", "Stop this focus before deleting it.", { recoverable: true })
    }
    const fallback = this.handle.db.select().from(v2Goals)
      .where(and(eq(v2Goals.flowId, flowId), eq(v2Goals.kind, "general")))
      .limit(1).get()
    if (!fallback) throw new SocratesError("v2_general_focus_missing", "General Conversation is unavailable.")

    const operation = this.handle.sqlite.transaction(() => {
      const classicHomes = this.handle.db.select().from(v2GoalClassicHomes)
        .where(and(eq(v2GoalClassicHomes.flowId, flowId), eq(v2GoalClassicHomes.goalId, goalId))).all()
      const turnIds = this.handle.db.select({ id: v2Turns.id }).from(v2Turns)
        .where(and(eq(v2Turns.flowId, flowId), eq(v2Turns.goalId, goalId))).all().map((row) => row.id)
      const classicTurnIds = this.handle.db.select({ id: v2ClassicTurnGoalLinks.turnId }).from(v2ClassicTurnGoalLinks)
        .where(and(eq(v2ClassicTurnGoalLinks.flowId, flowId), eq(v2ClassicTurnGoalLinks.goalId, goalId))).all().map((row) => row.id)

      if (flow.foregroundGoalId === goalId) {
        this.handle.db.update(v2Goals).set({ status: "parked", updatedAt: nowIso() }).where(eq(v2Goals.id, goalId)).run()
        this.handle.db.update(v2Goals).set({ status: "foreground", lastActiveAt: nowIso(), updatedAt: nowIso() }).where(eq(v2Goals.id, fallback.id)).run()
      }
      this.deleteV2TurnsWithinTransaction(turnIds)
      this.deleteClassicTurnsWithinTransaction(classicTurnIds)
      this.authorizeEvidenceDeletion("goal", goalId)

      const contextIds = this.handle.db.select({ id: v2ContextItems.id }).from(v2ContextItems).where(eq(v2ContextItems.goalId, goalId)).all().map((row) => row.id)
      const capsuleIds = this.handle.db.select({ id: v2GoalCapsules.id }).from(v2GoalCapsules).where(eq(v2GoalCapsules.goalId, goalId)).all().map((row) => row.id)
      this.deleteContextSources(contextIds, [], capsuleIds)
      this.deleteRowsByIds("v2_context_dispositions", "context_item_id", contextIds)
      this.handle.sqlite.prepare("DELETE FROM v2_context_dispositions WHERE goal_id = ?").run(goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_context_items WHERE goal_id = ?").run(goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_evidence_items WHERE goal_id = ?").run(goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_goal_capsules WHERE goal_id = ?").run(goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_goal_message_links WHERE goal_id = ?").run(goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_goal_transitions WHERE goal_id = ?").run(goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_goal_routing_runs WHERE selected_goal_id = ? OR foreground_goal_id = ?").run(goalId, goalId)
      for (const table of [
        "v2_runtime_events", "v2_model_calls", "v2_usage_events", "v2_tool_calls", "v2_approvals",
        "v2_terminal_sessions", "v2_errors", "v2_artifacts", "v2_agent_tasks", "v2_speech_jobs",
        "v2_feedback", "v2_credential_input_requests", "v2_message_attachments", "v2_messages",
      ]) {
        this.handle.sqlite.prepare(`DELETE FROM ${table} WHERE goal_id = ?`).run(goalId)
      }
      this.handle.sqlite.prepare("DELETE FROM v2_classic_turn_goal_links WHERE goal_id = ?").run(goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_goal_classic_homes WHERE goal_id = ?").run(goalId)
      for (const home of classicHomes) {
        const remainingTurns = this.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM turns WHERE conversation_id = ?").get(home.conversationId) as { count: number }
        const remainingHomes = this.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM v2_goal_classic_homes WHERE conversation_id = ?").get(home.conversationId) as { count: number }
        if (remainingTurns.count === 0 && remainingHomes.count === 0) {
          this.handle.sqlite.prepare("DELETE FROM v2_classic_message_links WHERE bridge_id = ?").run(home.bridgeId)
          this.handle.sqlite.prepare("DELETE FROM v2_classic_turn_goal_links WHERE bridge_id = ?").run(home.bridgeId)
          this.handle.sqlite.prepare("DELETE FROM v2_classic_conversation_bridges WHERE id = ?").run(home.bridgeId)
          this.deleteEmptyClassicConversationWithinTransaction(home.conversationId)
        } else {
          this.handle.sqlite.prepare("UPDATE v2_classic_conversation_bridges SET goal_id = ?, updated_at = ? WHERE id = ?").run(fallback.id, nowIso(), home.bridgeId)
        }
      }
      this.handle.sqlite.prepare("UPDATE v2_classic_conversation_bridges SET goal_id = ?, updated_at = ? WHERE goal_id = ?").run(fallback.id, nowIso(), goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_goals WHERE id = ?").run(goalId)
      this.handle.sqlite.prepare("DELETE FROM v2_deletion_authorizations WHERE target_kind = 'goal' AND target_id = ?").run(goalId)
      this.handle.db.update(v2Flows).set({ foregroundGoalId: fallback.id, revision: sql`${v2Flows.revision} + 1`, updatedAt: nowIso() }).where(eq(v2Flows.id, flowId)).run()
    })
    operation()
    return { deletedGoalId: goalId, fallbackGoalId: fallback.id }
  }

  mirrorV2TurnToClassic(projectId: string, flowId: string, turnId: string): void {
    const turn = this.requireTurn(projectId, flowId, turnId)
    if (!turn.goalId || !turn.userMessageId || !turn.assistantMessageId || turn.status !== "completed") return
    const alreadyLinked = this.handle.db.select({ id: v2ClassicMessageLinks.id }).from(v2ClassicMessageLinks)
      .where(or(eq(v2ClassicMessageLinks.v2MessageId, turn.userMessageId), eq(v2ClassicMessageLinks.v2MessageId, turn.assistantMessageId)))
      .limit(1).get()
    if (alreadyLinked) return
    const home = this.handle.db.select().from(v2GoalClassicHomes).where(and(eq(v2GoalClassicHomes.flowId, flowId), eq(v2GoalClassicHomes.goalId, turn.goalId))).limit(1).get()
    if (!home) return
    const row = this.handle.db.select().from(v2ClassicConversationBridges).where(eq(v2ClassicConversationBridges.id, home.bridgeId)).limit(1).get()
    if (!row || row.activeOwner !== "v2") return
    const user = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, turn.userMessageId)).limit(1).get()
    const assistant = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, turn.assistantMessageId)).limit(1).get()
    if (!user || !assistant) return
    this.handle.sqlite.transaction(() => {
      const now = nowIso()
      const classicTurnId = createId("turn")
      const classicUserId = createId("msg")
      const classicAssistantId = createId("msg")
      this.handle.db.insert(turns).values({
        id: classicTurnId,
        sessionId: row.sessionId,
        conversationId: row.conversationId,
        userMessageId: classicUserId,
        assistantMessageId: classicAssistantId,
        status: "completed",
        startedAt: user.createdAt,
        completedAt: assistant.completedAt ?? now,
        metadataJson: JSON.stringify({ source: "v2_bridge", v2TurnId: turn.id, flowId, goalId: turn.goalId }),
      }).run()
      this.handle.db.insert(messages).values([
        {
          id: classicUserId,
          conversationId: row.conversationId,
          sessionId: row.sessionId,
          turnId: classicTurnId,
          role: "user",
          content: user.content,
          contentFormat: "markdown",
          status: "completed",
          createdAt: user.createdAt,
          completedAt: user.completedAt ?? user.createdAt,
          metadataJson: JSON.stringify({ source: "v2_bridge", v2MessageId: user.id }),
        },
        {
          id: classicAssistantId,
          conversationId: row.conversationId,
          sessionId: row.sessionId,
          turnId: classicTurnId,
          role: "assistant",
          content: assistant.content,
          contentFormat: "markdown",
          status: "completed",
          parentMessageId: classicUserId,
          createdAt: assistant.createdAt,
          completedAt: assistant.completedAt ?? assistant.createdAt,
          metadataJson: JSON.stringify({ source: "v2_bridge", v2MessageId: assistant.id }),
        },
      ]).run()
      this.handle.db.insert(v2ClassicMessageLinks).values([
        { id: createId("v2blink"), bridgeId: row.id, v2MessageId: user.id, classicMessageId: classicUserId, direction: "v2_to_classic", sourceRuntime: "v2", createdAt: now },
        { id: createId("v2blink"), bridgeId: row.id, v2MessageId: assistant.id, classicMessageId: classicAssistantId, direction: "v2_to_classic", sourceRuntime: "v2", createdAt: now },
      ]).run()
      this.handle.db.insert(v2ClassicTurnGoalLinks).values({
        id: createId("v2ctgoal"),
        projectId,
        flowId,
        goalId: turn.goalId!,
        bridgeId: row.id,
        conversationId: row.conversationId,
        sessionId: row.sessionId,
        turnId: classicTurnId,
        userMessageId: classicUserId,
        assistantMessageId: classicAssistantId,
        createdAt: now,
        updatedAt: now,
      }).run()
      const attachments = this.handle.db.select().from(v2MessageAttachments).where(and(eq(v2MessageAttachments.messageId, user.id), eq(v2MessageAttachments.status, "attached"))).all()
      for (const attachment of attachments) {
        this.handle.db.insert(messageAttachments).values({
          id: createId("att"),
          projectId,
          conversationId: row.conversationId,
          sessionId: row.sessionId,
          turnId: classicTurnId,
          messageId: classicUserId,
          artifactId: attachment.artifactId,
          kind: attachment.kind,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          uri: attachment.uri,
          status: "attached",
          createdAt: attachment.createdAt,
          updatedAt: now,
          metadataJson: JSON.stringify({ source: "v2_bridge", v2AttachmentId: attachment.id }),
        }).run()
      }
      this.handle.db.update(v2ClassicConversationBridges).set({
        goalId: turn.goalId!,
        lastV2MessageOrdinal: assistant.ordinal,
        lastClassicMessageCreatedAt: assistant.createdAt,
        updatedAt: now,
      }).where(eq(v2ClassicConversationBridges.id, row.id)).run()
      const goal = this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, turn.goalId!)).limit(1).get()
      this.handle.db.update(conversations).set({ title: goal?.title ?? "Socrates focus", updatedAt: now }).where(eq(conversations.id, row.conversationId)).run()
    })()
  }

  getTurn(projectId: string, flowId: string, turnId: string): V2Turn {
    return mapTurn(this.requireTurn(projectId, flowId, turnId))
  }

  createDraftAttachments(projectId: string, flowId: string, inputs: UploadedFile[]): V2MessageAttachment[] {
    const flow = this.requireFlow(projectId, flowId)
    validateAttachmentBatch(inputs)
    const workspacePath = this.requireWorkspacePath(projectId)
    const now = nowIso()
    const ids: string[] = []
    for (const input of inputs) {
      const mimeType = normalizeMimeType(input.mimeType, input.originalName)
      const kind = attachmentKind(mimeType)
      if (!kind) {
        throw new SocratesError("attachment_type_not_supported", "Flow attachments support images, plain-text files, and Agent Skill ZIPs only.", {
          details: { fileName: input.originalName, mimeType },
          recoverable: true,
        })
      }
      validateAttachmentSize(kind, input)
      const stored = storeAttachmentFile({ workspacePath, originalName: input.originalName, data: input.data })
      const artifactId = createId("v2art")
      const attachmentId = createId("v2att")
      const hash = crypto.createHash("sha256").update(input.data).digest("hex")
      this.handle.db.insert(v2Artifacts).values({
        id: artifactId,
        flowId: flow.id,
        projectId,
        kind: "message_attachment",
        path: stored.path,
        uri: stored.path,
        contentHash: hash,
        mimeType,
        sizeBytes: input.data.byteLength,
        createdAt: now,
      }).run()
      this.handle.db.insert(v2MessageAttachments).values({
        id: attachmentId,
        projectId,
        flowId: flow.id,
        artifactId,
        kind,
        fileName: stored.fileName,
        mimeType,
        sizeBytes: input.data.byteLength,
        uri: stored.path,
        status: "draft",
        createdAt: now,
        updatedAt: now,
      }).run()
      ids.push(attachmentId)
    }
    return this.getAttachments(projectId, flowId, ids)
  }

  getAttachmentContent(projectId: string, flowId: string, attachmentId: string): V2MessageAttachment {
    const row = this.handle.db
      .select()
      .from(v2MessageAttachments)
      .where(and(eq(v2MessageAttachments.id, attachmentId), eq(v2MessageAttachments.projectId, projectId), eq(v2MessageAttachments.flowId, flowId)))
      .limit(1)
      .get()
    if (!row || row.status === "deleted") throw new SocratesError("attachment_not_found", "Flow attachment not found.", { recoverable: true })
    return mapAttachment(row)
  }

  readCurrentTurnSkillZip(input: {
    projectId: string
    flowId: string
    turnId: string
    attachmentPath: string
  }): { filename: string; data: Buffer } {
    this.requireFlow(input.projectId, input.flowId)
    const requested = normalizeV2AttachmentReference(input.attachmentPath)
    const rows = this.handle.db
      .select()
      .from(v2MessageAttachments)
      .where(
        and(
          eq(v2MessageAttachments.projectId, input.projectId),
          eq(v2MessageAttachments.flowId, input.flowId),
          eq(v2MessageAttachments.turnId, input.turnId),
          eq(v2MessageAttachments.status, "attached"),
          eq(v2MessageAttachments.kind, "skill_zip"),
        ),
      )
      .all()
    const row = rows.find((candidate) => normalizeV2AttachmentReference(candidate.uri) === requested)
    if (!row) {
      throw new SocratesError(
        "skill_import_attachment_not_found",
        "The Agent Skill ZIP was not attached to the current Seamless Flow message.",
        { recoverable: true },
      )
    }
    const data = fs.readFileSync(row.uri)
    if (data.length > MAX_SKILL_ZIP_ATTACHMENT_BYTES) {
      throw new SocratesError("attachment_too_large", "Agent Skill ZIP attachments must be 20 MB or smaller.", { recoverable: true })
    }
    return { filename: row.fileName, data }
  }

  getTurnMemorySource(projectId: string, flowId: string, turnId: string): {
    messageId?: string
    messageExcerpt?: string
  } {
    this.requireFlow(projectId, flowId)
    const turn = this.requireTurn(projectId, flowId, turnId)
    const task = this.handle.db.select().from(v2AgentTasks).where(eq(v2AgentTasks.currentTurnId, turnId)).limit(1).get()
    const rootTurn = !turn.userMessageId && task
      ? this.handle.db.select().from(v2Turns).where(eq(v2Turns.id, task.rootTurnId)).limit(1).get()
      : undefined
    const sourceMessageId = turn.userMessageId ?? rootTurn?.userMessageId
    const message = sourceMessageId
      ? this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, sourceMessageId)).limit(1).get()
      : undefined
    return {
      ...(message?.id ? { messageId: message.id } : {}),
      ...(message?.content ? { messageExcerpt: truncateInline(message.content, 600) } : {}),
    }
  }

  getTaskLineageForTurn(projectId: string, flowId: string, turnId: string): V2TaskLineage {
    this.requireFlow(projectId, flowId)
    const turn = this.requireTurn(projectId, flowId, turnId)
    const turnMetadata = parseJsonObject(turn.metadataJson)
    const terminalTaskId = typeof turnMetadata.terminalTaskId === "string" ? turnMetadata.terminalTaskId : undefined
    const taskRows = this.handle.db.select().from(v2AgentTasks).where(and(
      eq(v2AgentTasks.projectId, projectId),
      eq(v2AgentTasks.flowId, flowId),
    )).all()
    const task = taskRows.find((candidate) => candidate.id === terminalTaskId)
      ?? taskRows.find((candidate) => candidate.rootTurnId === turnId || candidate.currentTurnId === turnId)
    if (!task) {
      throw new SocratesError("v2_task_evidence_unavailable", "No Seamless task lifecycle is registered for this turn.", { recoverable: true })
    }
    const turnIds = this.handle.db.select().from(v2Turns).where(and(
      eq(v2Turns.projectId, projectId),
      eq(v2Turns.flowId, flowId),
    )).orderBy(asc(v2Turns.ordinal)).all().filter((candidate) => {
      if (candidate.id === task.rootTurnId) return true
      return parseJsonObject(candidate.metadataJson).terminalTaskId === task.id
    }).map((candidate) => candidate.id)
    return {
      taskId: task.id,
      rootTurnId: task.rootTurnId,
      currentTurnId: task.currentTurnId,
      turnIds,
      status: task.status,
      resumedCount: Math.max(0, turnIds.length - 1),
    }
  }

  createTurn(input: {
    projectId: string
    flowId: string
    clientMessageId: string
    content: string
    attachmentIds?: string[]
    runtimeConfig: V2RuntimeConfig
  }): CreatedV2Turn {
    const operation = this.handle.sqlite.transaction(() => {
      const flowRow = this.requireFlow(input.projectId, input.flowId)
      const duplicate = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, input.clientMessageId)).limit(1).get()
      if (duplicate) {
        if (duplicate.flowId !== input.flowId || !duplicate.turnId) {
          throw new SocratesError("v2_client_message_conflict", "That client message id is already in use.", { recoverable: true })
        }
        const existingTurn = this.handle.db.select().from(v2Turns).where(eq(v2Turns.id, duplicate.turnId)).limit(1).get()
        const runtimeRow = existingTurn
          ? this.handle.db.select().from(v2TurnRuntimeConfigs).where(eq(v2TurnRuntimeConfigs.turnId, existingTurn.id)).limit(1).get()
          : undefined
        if (!existingTurn || !runtimeRow) throw new SocratesError("v2_turn_recovery_failed", "The existing Flow turn is incomplete.")
        return { flow: mapFlow(flowRow), turn: mapTurn(existingTurn), userMessage: mapMessage(duplicate), runtimeConfigId: runtimeRow.id }
      }
      const active = this.handle.db
        .select({ id: v2Turns.id })
        .from(v2Turns)
        .where(and(eq(v2Turns.flowId, input.flowId), inArray(v2Turns.status, [...ACTIVE_TURN_STATUSES])))
        .limit(1)
        .get()
      if (active) {
        throw new SocratesError("v2_turn_already_active", "This Flow is already working on a turn. Send a follow-up after it finishes.", {
          details: { activeTurnId: active.id },
          recoverable: true,
        })
      }
      const attachmentIds = uniqueStrings(input.attachmentIds ?? [])
      if (!input.content.trim() && attachmentIds.length === 0) {
        throw new SocratesError("v2_message_empty", "Write a message or attach a file before sending.", { recoverable: true })
      }
      if (attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
        throw new SocratesError("attachment_upload_limit_exceeded", `Attach up to ${MAX_MESSAGE_ATTACHMENTS} files to one message.`, { recoverable: true })
      }
      const attachmentRows = attachmentIds.length === 0
        ? []
        : this.handle.db.select().from(v2MessageAttachments).where(and(
            eq(v2MessageAttachments.projectId, input.projectId),
            eq(v2MessageAttachments.flowId, input.flowId),
            inArray(v2MessageAttachments.id, attachmentIds),
          )).all()
      if (attachmentRows.length !== attachmentIds.length || attachmentRows.some((row) => row.status !== "draft")) {
        throw new SocratesError("attachment_not_attachable", "One or more Flow attachments are missing or already used.", { recoverable: true })
      }
      const totalBytes = attachmentRows.reduce((sum, row) => sum + row.sizeBytes, 0)
      if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) {
        throw new SocratesError("attachment_total_too_large", "Attachments for one message must be 20 MB or smaller in total.", { recoverable: true })
      }
      const now = nowIso()
      const turnId = createId("v2turn")
      const runtimeConfigId = createId("v2trc")
      const turnOrdinal = this.nextInteger("v2_turns", "ordinal", "flow_id", input.flowId)
      const messageOrdinal = this.nextInteger("v2_messages", "ordinal", "flow_id", input.flowId)
      this.handle.db.insert(v2Turns).values({
        id: turnId,
        flowId: input.flowId,
        projectId: input.projectId,
        ordinal: turnOrdinal,
        userMessageId: input.clientMessageId,
        status: "routing",
        startedAt: now,
        updatedAt: now,
      }).run()
      this.handle.db.insert(v2TurnRuntimeConfigs).values({
        id: runtimeConfigId,
        turnId,
        flowId: input.flowId,
        providerId: input.runtimeConfig.providerId,
        authMode: input.runtimeConfig.authMode ?? "api_key",
        modelId: input.runtimeConfig.modelId,
        thinkingEnabled: input.runtimeConfig.thinkingEnabled,
        thinkingEffort: input.runtimeConfig.thinkingEffort,
        approvalMode: input.runtimeConfig.approvalMode,
        sandboxMode: input.runtimeConfig.sandboxMode,
        contextWindowTokens: input.runtimeConfig.contextWindowTokens,
        createdAt: now,
      }).run()
      this.handle.db.insert(v2Messages).values({
        id: input.clientMessageId,
        flowId: input.flowId,
        projectId: input.projectId,
        turnId,
        ordinal: messageOrdinal,
        role: "user",
        content: input.content,
        status: "completed",
        createdAt: now,
        completedAt: now,
      }).run()
      for (const row of attachmentRows) {
        this.handle.db.update(v2MessageAttachments).set({ turnId, messageId: input.clientMessageId, status: "attached", updatedAt: now }).where(eq(v2MessageAttachments.id, row.id)).run()
        this.handle.db.update(v2Artifacts).set({ turnId }).where(eq(v2Artifacts.id, row.artifactId)).run()
      }
      this.handle.db.insert(v2AgentTasks).values({
        id: createId("v2task"),
        flowId: input.flowId,
        projectId: input.projectId,
        rootTurnId: turnId,
        currentTurnId: turnId,
        status: "running",
        runtimeConfigJson: JSON.stringify(input.runtimeConfig),
        waitingOnTerminalIdsJson: "[]",
        createdAt: now,
        updatedAt: now,
      }).run()
      this.handle.db.update(v2Flows).set({ revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, input.flowId)).run()
      const turnRow = this.handle.db.select().from(v2Turns).where(eq(v2Turns.id, turnId)).get()
      const messageRow = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, input.clientMessageId)).get()
      const updatedFlow = this.handle.db.select().from(v2Flows).where(eq(v2Flows.id, input.flowId)).get()
      if (!turnRow || !messageRow || !updatedFlow) throw new SocratesError("v2_turn_create_failed", "The Flow turn could not be created.")
      return {
        flow: mapFlow(updatedFlow),
        turn: mapTurn(turnRow),
        userMessage: mapMessage(messageRow, attachmentRows.map(mapAttachment)),
        runtimeConfigId,
      }
    })
    return operation()
  }

  applyRouting(input: {
    projectId: string
    flowId: string
    turnId: string
    messageId: string
    messageContent: string
    result: V2GoalRouterResult
    providerId?: string
    modelId?: string
  }): RoutingApplication {
    if (input.result.decision.action === "clarify") {
      throw new SocratesError("v2_clarification_unresolved", "A clarification must be answered before applying focus routing.")
    }
    const operation = this.handle.sqlite.transaction(() => {
      const flowRow = this.requireFlow(input.projectId, input.flowId)
      const turnRow = this.requireTurn(input.projectId, input.flowId, input.turnId)
      if (turnRow.status !== "routing") {
        throw new SocratesError("v2_turn_not_routing", "This Flow turn has already been routed.", { recoverable: true })
      }
      const now = nowIso()
      const existingRoutingRun = this.handle.db.select().from(v2GoalRoutingRuns).where(eq(v2GoalRoutingRuns.turnId, input.turnId)).limit(1).get()
      const routingRunId = existingRoutingRun?.id ?? createId("v2route")
      const existingGoals = this.handle.db.select().from(v2Goals).where(eq(v2Goals.flowId, input.flowId)).orderBy(asc(v2Goals.ordinal)).all()
      let selectedGoalId = input.result.decision.primaryGoalId
      let createdGoal: typeof v2Goals.$inferSelect | undefined
      const currentForeground = existingGoals.find((goal) => goal.status === "foreground")
      if (input.result.decision.action === "create") {
        selectedGoalId = createId("v2goal")
        const title = input.result.decision.title?.trim() || deriveGoalTitle(input.messageContent)
        const ordinal = existingGoals.length === 0 ? 1 : Math.max(...existingGoals.map((goal) => goal.ordinal)) + 1
        this.handle.db.insert(v2Goals).values({
          id: selectedGoalId,
          flowId: input.flowId,
          projectId: input.projectId,
          ordinal,
          title,
          summary: input.messageContent.trim().slice(0, 2_000) || title,
          kind: "work",
          // Insert as parked while an existing foreground row still owns the
          // partial unique index. The same transaction parks the old goal and
          // promotes this one below.
          status: currentForeground ? "parked" : "foreground",
          origin: "router",
          priority: 50,
          pinned: false,
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
        }).run()
        createdGoal = this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, selectedGoalId)).get()
      }
      if (!selectedGoalId) throw new SocratesError("v2_router_goal_missing", "The goal router did not select a goal.")
      const selectedBefore = existingGoals.find((goal) => goal.id === selectedGoalId)
      if (!createdGoal && !selectedBefore) throw new SocratesError("v2_router_goal_invalid", "The goal router selected a goal outside this Flow.")
      let primaryTransition: typeof v2GoalTransitions.$inferSelect | undefined
      if (currentForeground && currentForeground.id !== selectedGoalId) {
        this.handle.db.update(v2Goals).set({ status: "parked", updatedAt: now }).where(eq(v2Goals.id, currentForeground.id)).run()
        this.insertGoalTransition({
          flowId: input.flowId,
          goalId: currentForeground.id,
          turnId: input.turnId,
          routingRunId,
          fromStatus: "foreground",
          toStatus: "parked",
          reason: "focus_switch",
          note: `Parked when routing turn ${input.turnId}.`,
          createdAt: now,
        })
        this.refreshCapsule(currentForeground.id, input.flowId, input.turnId, now, "parked")
      }
      if (createdGoal && createdGoal.status !== "foreground") {
        this.handle.db.update(v2Goals).set({ status: "foreground", lastActiveAt: now, updatedAt: now }).where(eq(v2Goals.id, selectedGoalId)).run()
      }
      if (selectedBefore && selectedBefore.status !== "foreground") {
        this.handle.db.update(v2Goals).set({ status: "foreground", lastActiveAt: now, updatedAt: now }).where(eq(v2Goals.id, selectedGoalId)).run()
        primaryTransition = this.insertGoalTransition({
          flowId: input.flowId,
          goalId: selectedGoalId,
          turnId: input.turnId,
          routingRunId,
          fromStatus: selectedBefore.status,
          toStatus: "foreground",
          reason: "resumed",
          note: `Resumed for turn ${input.turnId}.`,
          createdAt: now,
        })
      } else if (createdGoal) {
        primaryTransition = this.insertGoalTransition({
          flowId: input.flowId,
          goalId: selectedGoalId,
          turnId: input.turnId,
          routingRunId,
          fromStatus: null,
          toStatus: "foreground",
          reason: "created",
          note: "Created by the bounded Flow goal router.",
          createdAt: now,
        })
        const initialSummary = buildCapsuleSummary({
          title: createdGoal.title,
          objective: createdGoal.summary ?? createdGoal.title,
          latestRequest: input.messageContent,
          state: "foreground · awaiting first response",
        })
        this.handle.db.insert(v2GoalCapsules).values({
          id: createId("v2cap"),
          flowId: input.flowId,
          goalId: selectedGoalId,
          version: 1,
          status: "active",
          summary: initialSummary,
          decisionsJson: JSON.stringify(extractCapsuleDecisions(input.messageContent)),
          openQuestionsJson: JSON.stringify(extractQuestions(input.messageContent)),
          nextActionsJson: JSON.stringify(["Respond to the latest user request."]),
          evidenceHandlesJson: "[]",
          sourceThroughSequence: 0,
          tokenEstimate: estimateTokens(initialSummary),
          createdByTurnId: input.turnId,
          createdAt: now,
        }).run()
      } else {
        this.handle.db.update(v2Goals).set({ lastActiveAt: now, updatedAt: now }).where(eq(v2Goals.id, selectedGoalId)).run()
      }
      const decision = routingDecisionContract(input.result.decision)
      const routingValues = {
        id: routingRunId,
        flowId: input.flowId,
        projectId: input.projectId,
        turnId: input.turnId,
        messageId: input.messageId,
        foregroundGoalId: flowRow.foregroundGoalId,
        candidateGoalIdsJson: JSON.stringify(input.result.candidates.candidates.map((candidate) => candidate.goal.id)),
        selectedGoalId,
        decision,
        providerId: input.providerId,
        modelId: input.modelId,
        status: input.result.source === "fallback" ? "fallback" : "completed",
        fallbackReason: input.result.fallbackReason,
        startedAt: now,
        completedAt: now,
      }
      if (existingRoutingRun) {
        this.handle.db.update(v2GoalRoutingRuns).set({
          candidateGoalIdsJson: routingValues.candidateGoalIdsJson,
          selectedGoalId,
          decision,
          providerId: routingValues.providerId,
          modelId: routingValues.modelId,
          status: routingValues.status,
          fallbackReason: routingValues.fallbackReason,
          completedAt: now,
        }).where(eq(v2GoalRoutingRuns.id, routingRunId)).run()
      } else {
        this.handle.db.insert(v2GoalRoutingRuns).values(routingValues).run()
      }
      this.handle.db.update(v2Turns).set({ goalId: selectedGoalId, status: "running", updatedAt: now }).where(eq(v2Turns.id, input.turnId)).run()
      this.handle.db.update(v2Messages).set({ goalId: selectedGoalId }).where(eq(v2Messages.id, input.messageId)).run()
      this.handle.db.update(v2MessageAttachments).set({ goalId: selectedGoalId }).where(eq(v2MessageAttachments.messageId, input.messageId)).run()
      this.handle.db.update(v2Artifacts).set({ goalId: selectedGoalId }).where(and(eq(v2Artifacts.flowId, input.flowId), eq(v2Artifacts.turnId, input.turnId))).run()
      this.handle.db.update(v2AgentTasks).set({ goalId: selectedGoalId, updatedAt: now }).where(eq(v2AgentTasks.currentTurnId, input.turnId)).run()
      this.handle.db.insert(v2GoalMessageLinks).values({
        id: createId("v2link"), flowId: input.flowId, goalId: selectedGoalId, messageId: input.messageId, turnId: input.turnId, relation: "primary", createdAt: now,
      }).run()
      if (primaryTransition?.reason === "resumed") {
        this.refreshCapsule(selectedGoalId, input.flowId, input.turnId, now, "resumed")
      }
      this.handle.db.update(v2Flows).set({ foregroundGoalId: selectedGoalId, revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, input.flowId)).run()
      const routingRow = this.handle.db.select().from(v2GoalRoutingRuns).where(eq(v2GoalRoutingRuns.id, routingRunId)).get()
      const goalRow = this.handle.db.select().from(v2Goals).where(eq(v2Goals.id, selectedGoalId)).get()
      if (!routingRow || !goalRow) throw new SocratesError("v2_routing_persist_failed", "The Flow routing decision could not be persisted.")
      return {
        routingRun: mapRoutingRun(routingRow),
        goal: mapGoal(goalRow),
        ...(primaryTransition ? { transition: mapTransition(primaryTransition) } : {}),
      }
    })
    return operation()
  }

  requestRoutingClarification(input: {
    projectId: string
    flowId: string
    turnId: string
    messageId: string
    result: V2GoalRouterResult
    providerId?: string
    modelId?: string
  }): { routingRun: V2GoalRoutingRun; message: V2Message; turn: V2Turn } {
    const decision = input.result.decision
    if (decision.action !== "clarify" || !decision.clarificationQuestion || (decision.clarificationGoalIds?.length ?? 0) < 2) {
      throw new SocratesError("v2_clarification_invalid", "The router did not provide a valid focus clarification.")
    }
    const clarificationQuestion = decision.clarificationQuestion
    const operation = this.handle.sqlite.transaction(() => {
      const flow = this.requireFlow(input.projectId, input.flowId)
      const turn = this.requireTurn(input.projectId, input.flowId, input.turnId)
      if (turn.status !== "routing") throw new SocratesError("v2_turn_not_routing", "This Flow turn is no longer waiting for routing.", { recoverable: true })
      const now = nowIso()
      const routingRunId = createId("v2route")
      const assistantMessageId = createId("v2msg")
      this.handle.db.insert(v2GoalRoutingRuns).values({
        id: routingRunId,
        flowId: input.flowId,
        projectId: input.projectId,
        turnId: input.turnId,
        messageId: input.messageId,
        foregroundGoalId: flow.foregroundGoalId,
        candidateGoalIdsJson: JSON.stringify(input.result.candidates.candidates.map((candidate) => candidate.goal.id)),
        decision: "clarify",
        clarificationQuestion,
        clarificationCandidateGoalIdsJson: JSON.stringify(decision.clarificationGoalIds),
        providerId: input.providerId,
        modelId: input.modelId,
        status: "awaiting_clarification",
        startedAt: now,
      }).run()
      this.handle.db.insert(v2Messages).values({
        id: assistantMessageId,
        flowId: input.flowId,
        projectId: input.projectId,
        turnId: input.turnId,
        ordinal: this.nextInteger("v2_messages", "ordinal", "flow_id", input.flowId),
        role: "assistant",
        kind: "routing_clarification",
        content: clarificationQuestion,
        status: "completed",
        parentMessageId: input.messageId,
        createdAt: now,
        completedAt: now,
      }).run()
      this.handle.db.update(v2Turns).set({ status: "awaiting_clarification", waitingReason: "Waiting for one focus clarification.", updatedAt: now }).where(eq(v2Turns.id, input.turnId)).run()
      this.handle.db.update(v2AgentTasks).set({ status: "waiting", updatedAt: now }).where(eq(v2AgentTasks.currentTurnId, input.turnId)).run()
      this.handle.db.update(v2Flows).set({ revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, input.flowId)).run()
      const routingRow = this.handle.db.select().from(v2GoalRoutingRuns).where(eq(v2GoalRoutingRuns.id, routingRunId)).get()
      const messageRow = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, assistantMessageId)).get()
      const turnRow = this.handle.db.select().from(v2Turns).where(eq(v2Turns.id, input.turnId)).get()
      if (!routingRow || !messageRow || !turnRow) throw new SocratesError("v2_clarification_persist_failed", "The focus clarification could not be saved.")
      return { routingRun: mapRoutingRun(routingRow), message: mapMessage(messageRow), turn: mapTurn(turnRow) }
    })
    return operation()
  }

  resolveRoutingClarification(input: {
    projectId: string
    flowId: string
    routingRunId: string
    answerMessageId: string
    answer: string
  }): { created: CreatedV2Turn; routingRun: V2GoalRoutingRun; answerMessage: V2Message; clarificationAnswer: string } {
    const operation = this.handle.sqlite.transaction(() => {
      const flow = this.requireFlow(input.projectId, input.flowId)
      const routing = this.handle.db.select().from(v2GoalRoutingRuns).where(and(
        eq(v2GoalRoutingRuns.id, input.routingRunId),
        eq(v2GoalRoutingRuns.flowId, input.flowId),
        eq(v2GoalRoutingRuns.projectId, input.projectId),
      )).limit(1).get()
      if (!routing || routing.status !== "awaiting_clarification") {
        throw new SocratesError("v2_clarification_not_pending", "That focus clarification is no longer pending.", { recoverable: true })
      }
      const duplicate = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, input.answerMessageId)).limit(1).get()
      if (duplicate) throw new SocratesError("v2_client_message_conflict", "That client message id is already in use.", { recoverable: true })
      const turn = this.requireTurn(input.projectId, input.flowId, routing.turnId)
      const original = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, routing.messageId)).limit(1).get()
      const runtime = this.handle.db.select().from(v2TurnRuntimeConfigs).where(eq(v2TurnRuntimeConfigs.turnId, routing.turnId)).limit(1).get()
      if (!original || !runtime) throw new SocratesError("v2_clarification_recovery_failed", "The pending turn could not be restored.")
      const now = nowIso()
      this.handle.db.insert(v2Messages).values({
        id: input.answerMessageId,
        flowId: input.flowId,
        projectId: input.projectId,
        turnId: routing.turnId,
        ordinal: this.nextInteger("v2_messages", "ordinal", "flow_id", input.flowId),
        role: "user",
        kind: "routing_clarification",
        content: input.answer,
        status: "completed",
        createdAt: now,
        completedAt: now,
      }).run()
      this.handle.db.update(v2GoalRoutingRuns).set({ clarificationAnswerMessageId: input.answerMessageId, status: "running" }).where(eq(v2GoalRoutingRuns.id, routing.id)).run()
      this.handle.db.update(v2Turns).set({ status: "routing", waitingReason: null, updatedAt: now }).where(eq(v2Turns.id, routing.turnId)).run()
      this.handle.db.update(v2AgentTasks).set({ status: "running", updatedAt: now }).where(eq(v2AgentTasks.currentTurnId, routing.turnId)).run()
      const answerRow = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, input.answerMessageId)).get()
      const routingRow = this.handle.db.select().from(v2GoalRoutingRuns).where(eq(v2GoalRoutingRuns.id, routing.id)).get()
      const turnRow = this.handle.db.select().from(v2Turns).where(eq(v2Turns.id, routing.turnId)).get()
      if (!answerRow || !routingRow || !turnRow) throw new SocratesError("v2_clarification_resolve_failed", "The focus clarification answer could not be saved.")
      return {
        created: { flow: mapFlow(flow), turn: mapTurn(turnRow), userMessage: mapMessage(original), runtimeConfigId: runtime.id },
        routingRun: mapRoutingRun(routingRow),
        answerMessage: mapMessage(answerRow),
        clarificationAnswer: input.answer,
      }
    })
    return operation()
  }

  listGoalsForRouter(flowId: string): V2Goal[] {
    return this.handle.db
      .select()
      .from(v2Goals)
      .where(eq(v2Goals.flowId, flowId))
      .orderBy(asc(v2Goals.ordinal))
      .all()
      .map(mapGoal)
  }

  listCapsulesForRouter(flowId: string): V2GoalCapsule[] {
    return this.handle.db
      .select()
      .from(v2GoalCapsules)
      .where(and(eq(v2GoalCapsules.flowId, flowId), eq(v2GoalCapsules.status, "active")))
      .orderBy(asc(v2GoalCapsules.goalId))
      .all()
      .map(mapCapsule)
  }

  getRuntimeConfig(turnId: string): { id: string; runtimeConfig: V2RuntimeConfig } {
    const row = this.handle.db.select().from(v2TurnRuntimeConfigs).where(eq(v2TurnRuntimeConfigs.turnId, turnId)).limit(1).get()
    if (!row) throw new SocratesError("v2_runtime_config_not_found", "The Flow turn runtime configuration was not found.")
    return {
      id: row.id,
      runtimeConfig: {
        providerId: row.providerId as V2RuntimeConfig["providerId"],
        authMode: row.authMode as V2RuntimeConfig["authMode"],
        modelId: row.modelId,
        thinkingEnabled: row.thinkingEnabled,
        ...(row.thinkingEffort ? { thinkingEffort: row.thinkingEffort as NonNullable<V2RuntimeConfig["thinkingEffort"]> } : {}),
        approvalMode: row.approvalMode as V2RuntimeConfig["approvalMode"],
        sandboxMode: row.sandboxMode as V2RuntimeConfig["sandboxMode"],
        ...(row.contextWindowTokens ? { contextWindowTokens: row.contextWindowTokens } : {}),
      },
    }
  }

  getModelMessages(flowId: string, foregroundGoalId: string, includeImageParts = false): ModelMessage[] {
    const linkedMessages = this.handle.db
      .select({ messageId: v2GoalMessageLinks.messageId })
      .from(v2GoalMessageLinks)
      .where(and(eq(v2GoalMessageLinks.flowId, flowId), eq(v2GoalMessageLinks.goalId, foregroundGoalId)))
    const selected = this.handle.db
      .select()
      .from(v2Messages)
      .where(and(
        eq(v2Messages.flowId, flowId),
        inArray(v2Messages.role, ["user", "assistant", "developer", "system"]),
        eq(v2Messages.status, "completed"),
        or(
          eq(v2Messages.goalId, foregroundGoalId),
          inArray(v2Messages.id, linkedMessages),
          inArray(v2Messages.role, ["system", "developer"]),
        ),
      ))
      .orderBy(desc(v2Messages.ordinal))
      .limit(V2_MODEL_MESSAGE_LOAD_LIMIT)
      .all()
      .reverse()
    const attachmentRows = selected.length > 0
      ? this.handle.db.select().from(v2MessageAttachments).where(and(inArray(v2MessageAttachments.messageId, selected.map((row) => row.id)), eq(v2MessageAttachments.status, "attached"))).all()
      : []
    const attachmentsByMessage = new Map<string, typeof attachmentRows>()
    for (const row of attachmentRows) {
      if (!row.messageId) continue
      attachmentsByMessage.set(row.messageId, [...(attachmentsByMessage.get(row.messageId) ?? []), row])
    }
    return selected.map((row) => {
      const role = row.role as ModelMessage["role"]
      const attachments = attachmentsByMessage.get(row.id) ?? []
      const base = {
        role,
        content: row.content,
        id: row.id,
        ...(row.turnId ? { turnId: row.turnId } : {}),
      } satisfies ModelMessage
      if (attachments.length === 0 || role !== "user") return base
      const images = attachments.filter((attachment) => attachment.kind === "image")
      const attachmentReference = formatV2AttachmentReference(attachments)
      if (!includeImageParts || images.length === 0) {
        const omitted = images.length > 0 && !includeImageParts
          ? `[${images.length} image attachment${images.length === 1 ? "" : "s"} retained in chat but pixels were not sent because the selected model does not support vision.]\n`
          : ""
        const manifest = `${omitted}${attachmentReference}`
        return {
          ...base,
          content: row.content.trim() ? `${row.content}\n\n${manifest}` : manifest,
        }
      }
      const parts: ModelMessage["content"] = [{
        type: "text",
        text: [row.content.trim(), attachmentReference].filter(Boolean).join("\n\n"),
      }]
      for (const image of images) {
        try {
          const data = fs.readFileSync(image.uri)
          parts.push({
            type: "image",
            mediaType: image.mimeType,
            data: `data:${image.mimeType};base64,${data.toString("base64")}`,
            fileName: image.fileName,
          })
        } catch {
          // The durable attachment manifest remains visible even when a local
          // image file becomes temporarily unreadable.
        }
      }
      return {
        ...base,
        content: parts,
      }
    })
  }

  completeTurn(input: { projectId: string; flowId: string; turnId: string; content: string; reasoning?: string }): V2Message {
    const completionTask = this.handle.db.select().from(v2AgentTasks).where(eq(v2AgentTasks.currentTurnId, input.turnId)).limit(1).get()
    const pendingCompletion = completionTask ? parseJsonObject(completionTask.metadataJson).pendingFocusCompletion : undefined
    const completionOutcome = pendingCompletion && typeof pendingCompletion === "object" && typeof (pendingCompletion as Record<string, unknown>).outcome === "string"
      ? (pendingCompletion as Record<string, unknown>).outcome as string
      : undefined
    const responseContent = completionOutcome
      ? ensureCompletionOutcomeVisible(input.content, completionOutcome)
      : input.content
    const operation = this.handle.sqlite.transaction(() => {
      const turn = this.requireTurn(input.projectId, input.flowId, input.turnId)
      if (!turn.goalId) throw new SocratesError("v2_turn_goal_missing", "The Flow turn has not been assigned to a goal.")
      if (!ACTIVE_TURN_STATUSES.includes(turn.status as (typeof ACTIVE_TURN_STATUSES)[number])) {
        throw new SocratesError("v2_turn_not_active", "This Flow turn is no longer active.", { recoverable: true })
      }
      const now = nowIso()
      const messageId = createId("v2msg")
      const ordinal = this.nextInteger("v2_messages", "ordinal", "flow_id", input.flowId)
      this.handle.db.insert(v2Messages).values({
        id: messageId,
        flowId: input.flowId,
        projectId: input.projectId,
        goalId: turn.goalId,
        turnId: input.turnId,
        ordinal,
        role: "assistant",
        content: responseContent,
        reasoning: input.reasoning,
        status: "completed",
        parentMessageId: turn.userMessageId,
        createdAt: now,
        completedAt: now,
      }).run()
      this.handle.db.update(v2Turns).set({ assistantMessageId: messageId, status: "completed", updatedAt: now, completedAt: now }).where(eq(v2Turns.id, input.turnId)).run()
      this.handle.db.update(v2AgentTasks).set({ status: "completed", updatedAt: now, completedAt: now }).where(eq(v2AgentTasks.currentTurnId, input.turnId)).run()
      this.handle.db.update(v2Goals).set({ lastActiveAt: now, updatedAt: now }).where(eq(v2Goals.id, turn.goalId)).run()
      this.handle.db.update(v2Flows).set({ revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, input.flowId)).run()
      this.handle.db.insert(v2GoalMessageLinks).values({
        id: createId("v2link"), flowId: input.flowId, goalId: turn.goalId, messageId, turnId: input.turnId, relation: "primary", createdAt: now,
      }).run()
      this.refreshCapsule(turn.goalId, input.flowId, input.turnId, now, "turn_completed")
      const row = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, messageId)).get()
      if (!row) throw new SocratesError("v2_turn_complete_failed", "The Flow response could not be saved.")
      return mapMessage(row)
    })
    const message = operation()
    const completedTurn = this.requireTurn(input.projectId, input.flowId, input.turnId)
    if (completedTurn.goalId && pendingCompletion && typeof pendingCompletion === "object") {
      const outcome = completionOutcome ?? "Completed by Socrates."
      this.updateFocus({ projectId: input.projectId, flowId: input.flowId, goalId: completedTurn.goalId, action: "finish", note: outcome })
    }
    this.mirrorV2TurnToClassic(input.projectId, input.flowId, input.turnId)
    return message
  }

  failTurn(input: { projectId: string; flowId: string; turnId: string; error: unknown; source?: string }): V2Error {
    const normalized = normalizeUnknownError(input.error)
    const operation = this.handle.sqlite.transaction(() => {
      const turn = this.requireTurn(input.projectId, input.flowId, input.turnId)
      const now = nowIso()
      const error = this.insertError({
        projectId: input.projectId,
        flowId: input.flowId,
        ...(turn.goalId ? { goalId: turn.goalId } : {}),
        turnId: input.turnId,
        source: input.source ?? "main_agent",
        code: normalized.code,
        message: normalized.message,
        ...(normalized.details === undefined ? {} : { details: normalized.details }),
        recoverable: normalized.recoverable,
        ...(normalized.stack ? { stack: normalized.stack } : {}),
      })
      this.handle.db.update(v2Turns).set({ status: "failed", errorId: error.id, updatedAt: now, failedAt: now }).where(eq(v2Turns.id, input.turnId)).run()
      this.handle.db.update(v2AgentTasks).set({ status: "failed", updatedAt: now, completedAt: now }).where(eq(v2AgentTasks.currentTurnId, input.turnId)).run()
      if (turn.goalId) this.refreshCapsule(turn.goalId, input.flowId, input.turnId, now, "failed")
      return error
    })
    return operation()
  }

  cancelTurn(projectId: string, flowId: string, turnId: string, reason = "Cancelled by the user."): V2Turn {
    const turn = this.requireTurn(projectId, flowId, turnId)
    if (!ACTIVE_TURN_STATUSES.includes(turn.status as (typeof ACTIVE_TURN_STATUSES)[number])) return mapTurn(turn)
    const now = nowIso()
    this.handle.db.update(v2Turns).set({ status: "cancelled", waitingReason: reason, updatedAt: now, cancelledAt: now }).where(eq(v2Turns.id, turnId)).run()
    this.handle.db.update(v2AgentTasks).set({ status: "cancelled", updatedAt: now, completedAt: now }).where(eq(v2AgentTasks.currentTurnId, turnId)).run()
    if (turn.goalId) this.refreshCapsule(turn.goalId, flowId, turnId, now, "cancelled")
    const updated = this.handle.db.select().from(v2Turns).where(eq(v2Turns.id, turnId)).get()
    if (!updated) throw new SocratesError("v2_turn_not_found", "Flow turn not found.")
    return mapTurn(updated)
  }

  recoverInterruptedTurns(reason = "Socrates restarted before this Flow turn completed."): number {
    const rows = this.handle.db.select().from(v2Turns).where(inArray(v2Turns.status, [...ACTIVE_TURN_STATUSES])).all()
    const now = nowIso()
    let recovered = 0
    for (const row of rows) {
      const task = this.handle.db.select().from(v2AgentTasks).where(eq(v2AgentTasks.currentTurnId, row.id)).limit(1).get()
      // A durable Terminal wait is intentionally inactive from the model's
      // perspective. The supervisor reconciliation owns its next transition.
      if (row.status === "waiting" && task?.status === "waiting") continue
      // If the server fell between claiming a wake and launching the next
      // model request, put the same V2 task back on the ready queue. No new
      // user message and no Classic task row are created.
      if (task?.status === "running" && task.currentTurnId !== task.rootTurnId) {
        const metadata = parseJsonObject(task.metadataJson)
        const lastWake = parseV2TaskReady(metadata.lastWake)
        if (lastWake) {
          this.handle.db.update(v2Turns).set({
            status: "suspended",
            updatedAt: now,
            completedAt: now,
            metadataJson: JSON.stringify({ ...parseJsonObject(row.metadataJson), recoveredForTerminalResume: true }),
          }).where(eq(v2Turns.id, row.id)).run()
          this.handle.db.update(v2AgentTasks).set({
            status: "ready",
            waitingOnTerminalIdsJson: "[]",
            updatedAt: now,
            metadataJson: JSON.stringify({ ...metadata, ready: lastWake }),
          }).where(eq(v2AgentTasks.id, task.id)).run()
          recovered += 1
          continue
        }
      }
      const error = this.insertError({ projectId: row.projectId, flowId: row.flowId, turnId: row.id, source: "recovery", code: "v2_turn_interrupted", message: reason, recoverable: true })
      this.handle.db.update(v2Turns).set({ status: "failed", errorId: error.id, updatedAt: now, failedAt: now }).where(eq(v2Turns.id, row.id)).run()
      this.handle.db.update(v2AgentTasks).set({ status: "failed", updatedAt: now, completedAt: now }).where(eq(v2AgentTasks.currentTurnId, row.id)).run()
      recovered += 1
    }
    return recovered
  }

  appendRuntimeEvent(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    type: `v2.${string}`
    source: string
    payload: unknown
  }): V2RuntimeEvent {
    const operation = this.handle.sqlite.transaction(() => {
      this.requireFlow(input.projectId, input.flowId)
      const now = nowIso()
      this.handle.db.update(v2Flows).set({
        lastEventSequence: sql`${v2Flows.lastEventSequence} + 1`,
        updatedAt: now,
      }).where(eq(v2Flows.id, input.flowId)).run()
      const sequenceRow = this.handle.db.select({ sequence: v2Flows.lastEventSequence }).from(v2Flows).where(eq(v2Flows.id, input.flowId)).get()
      if (!sequenceRow) throw new SocratesError("v2_flow_not_found", "Flow not found.")
      const id = createId("v2evt")
      this.handle.db.insert(v2RuntimeEvents).values({
        id,
        flowId: input.flowId,
        projectId: input.projectId,
        goalId: input.goalId,
        turnId: input.turnId,
        sequence: sequenceRow.sequence,
        type: input.type,
        source: input.source,
        payloadJson: JSON.stringify(input.payload ?? null),
        createdAt: now,
      }).run()
      const row = this.handle.db.select().from(v2RuntimeEvents).where(eq(v2RuntimeEvents.id, id)).get()
      if (!row) throw new SocratesError("v2_event_persist_failed", "The Flow event could not be persisted.")
      return mapRuntimeEvent(row)
    })
    return operation()
  }

  listRuntimeEvents(projectId: string, flowId: string, afterSequence = 0, limit = 500): V2RuntimeEvent[] {
    this.requireFlow(projectId, flowId)
    return this.handle.db
      .select()
      .from(v2RuntimeEvents)
      .where(and(eq(v2RuntimeEvents.flowId, flowId), sql`${v2RuntimeEvents.sequence} > ${Math.max(0, afterSequence)}`))
      .orderBy(asc(v2RuntimeEvents.sequence))
      .limit(Math.max(1, Math.min(2_000, limit)))
      .all()
      .map(mapRuntimeEvent)
  }

  createModelCall(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    role: V2ModelCall["role"]
    providerId: string
    modelId: string
    request: unknown
  }): string {
    const id = createId("v2mcall")
    this.handle.db.insert(v2ModelCalls).values({
      id,
      flowId: input.flowId,
      projectId: input.projectId,
      goalId: input.goalId,
      turnId: input.turnId,
      role: input.role,
      providerId: input.providerId,
      modelId: input.modelId,
      status: "running",
      requestJson: JSON.stringify(input.request ?? null),
      startedAt: nowIso(),
    }).run()
    return id
  }

  completeModelCall(input: {
    modelCallId: string
    response?: unknown
    providerResponse?: unknown
    errorId?: string
    cancelled?: boolean
  }): V2ModelCall {
    const now = nowIso()
    this.handle.db.update(v2ModelCalls).set({
      status: input.cancelled ? "cancelled" : input.errorId ? "failed" : "completed",
      responseJson: input.response === undefined ? undefined : JSON.stringify(input.response),
      providerResponseJson: input.providerResponse === undefined ? undefined : JSON.stringify(input.providerResponse),
      errorId: input.errorId,
      completedAt: now,
    }).where(eq(v2ModelCalls.id, input.modelCallId)).run()
    const row = this.handle.db.select().from(v2ModelCalls).where(eq(v2ModelCalls.id, input.modelCallId)).get()
    if (!row) throw new SocratesError("v2_model_call_not_found", "Flow model call not found.")
    return mapModelCall(row)
  }

  recordUsage(input: {
    modelCallId: string
    inputTokens?: number
    outputTokens?: number
    reasoningTokens?: number
    cachedInputTokens?: number
    totalTokens?: number
    costUsd?: number
    raw?: unknown
  }): V2UsageEvent {
    const call = this.handle.db.select().from(v2ModelCalls).where(eq(v2ModelCalls.id, input.modelCallId)).get()
    if (!call) throw new SocratesError("v2_model_call_not_found", "Flow model call not found.")
    const inputTokens = nonNegative(input.inputTokens)
    const outputTokens = nonNegative(input.outputTokens)
    const reasoningTokens = nonNegative(input.reasoningTokens)
    const cachedInputTokens = nonNegative(input.cachedInputTokens)
    const totalTokens = nonNegative(input.totalTokens ?? inputTokens + outputTokens + reasoningTokens)
    const id = createId("v2usage")
    this.handle.db.insert(v2UsageEvents).values({
      id,
      flowId: call.flowId,
      projectId: call.projectId,
      goalId: call.goalId,
      turnId: call.turnId,
      modelCallId: call.id,
      providerId: call.providerId,
      modelId: call.modelId,
      inputTokens,
      outputTokens,
      reasoningTokens,
      cachedInputTokens,
      totalTokens,
      costUsd: input.costUsd,
      costSource: input.costUsd === undefined ? "unavailable" : "provider",
      rawUsageJson: input.raw === undefined ? undefined : JSON.stringify(input.raw),
      createdAt: nowIso(),
    }).onConflictDoUpdate({
      target: v2UsageEvents.modelCallId,
      set: { inputTokens, outputTokens, reasoningTokens, cachedInputTokens, totalTokens, costUsd: input.costUsd, rawUsageJson: input.raw === undefined ? undefined : JSON.stringify(input.raw) },
    }).run()
    const row = this.handle.db.select().from(v2UsageEvents).where(eq(v2UsageEvents.modelCallId, call.id)).get()
    if (!row) throw new SocratesError("v2_usage_persist_failed", "Flow usage could not be persisted.")
    return mapUsage(row)
  }

  createToolCall(input: {
    id: string
    projectId: string
    flowId: string
    goalId?: string
    turnId: string
    modelCallId?: string
    providerToolCallId?: string
    toolName: string
    arguments: unknown
    requiresApproval: boolean
  }): V2ToolCall {
    this.handle.db.insert(v2ToolCalls).values({
      id: input.id,
      flowId: input.flowId,
      projectId: input.projectId,
      goalId: input.goalId,
      turnId: input.turnId,
      modelCallId: input.modelCallId,
      providerToolCallId: input.providerToolCallId,
      toolName: input.toolName,
      status: input.requiresApproval ? "awaiting_approval" : "running",
      argumentsJson: JSON.stringify(input.arguments ?? null),
      requiresApproval: input.requiresApproval,
      startedAt: nowIso(),
    }).run()
    return this.getToolCall(input.id)
  }

  completeToolCall(toolCallId: string, result: unknown): V2ToolCall {
    this.handle.db.update(v2ToolCalls).set({ status: "completed", resultJson: JSON.stringify(result ?? null), completedAt: nowIso() }).where(eq(v2ToolCalls.id, toolCallId)).run()
    return this.getToolCall(toolCallId)
  }

  failToolCall(toolCallId: string, errorId: string): V2ToolCall {
    this.handle.db.update(v2ToolCalls).set({ status: "failed", errorId, completedAt: nowIso() }).where(eq(v2ToolCalls.id, toolCallId)).run()
    return this.getToolCall(toolCallId)
  }

  recordError(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    source: string
    code: string
    message: string
    details?: unknown
    stack?: string
    recoverable: boolean
  }): V2Error {
    return this.insertError(input)
  }

  createApproval(input: {
    id: string
    projectId: string
    flowId: string
    goalId?: string
    turnId: string
    toolCallId: string
    actionKind: string
    action: unknown
  }): V2Approval {
    const now = nowIso()
    this.handle.db.insert(v2Approvals).values({
      id: input.id,
      flowId: input.flowId,
      projectId: input.projectId,
      goalId: input.goalId,
      turnId: input.turnId,
      toolCallId: input.toolCallId,
      status: "pending",
      actionKind: input.actionKind,
      actionJson: JSON.stringify(input.action ?? null),
      requestedAt: now,
    }).run()
    this.handle.db.update(v2ToolCalls).set({ approvalId: input.id, status: "awaiting_approval" }).where(eq(v2ToolCalls.id, input.toolCallId)).run()
    const row = this.handle.db.select().from(v2Approvals).where(eq(v2Approvals.id, input.id)).get()
    if (!row) throw new SocratesError("v2_approval_create_failed", "Flow approval could not be created.")
    return mapApproval(row)
  }

  resolveApproval(projectId: string, flowId: string, approvalId: string, decision: "approved" | "rejected", reason?: string): V2Approval {
    const row = this.handle.db.select().from(v2Approvals).where(and(eq(v2Approvals.id, approvalId), eq(v2Approvals.projectId, projectId), eq(v2Approvals.flowId, flowId))).get()
    if (!row) throw new SocratesError("v2_approval_not_found", "Flow approval not found.", { recoverable: true })
    if (row.status !== "pending") throw new SocratesError("v2_approval_already_resolved", "This Flow approval was already resolved.", { recoverable: true })
    const now = nowIso()
    this.handle.db.update(v2Approvals).set({ status: decision, decision, reason, decidedBy: "user", decidedAt: now }).where(eq(v2Approvals.id, approvalId)).run()
    if (row.toolCallId) this.handle.db.update(v2ToolCalls).set({ status: decision === "approved" ? "running" : "failed" }).where(eq(v2ToolCalls.id, row.toolCallId)).run()
    return mapApproval(this.handle.db.select().from(v2Approvals).where(eq(v2Approvals.id, approvalId)).get() as typeof row)
  }

  createCredentialRequest(input: {
    id: string
    projectId: string
    flowId: string
    goalId?: string
    turnId: string
    toolCallId: string
    providerToolCallId?: string
    serverId: string
    serverLabel?: string
    envKey: string
    source: "user_input" | "workspace_env"
  }): V2CredentialInputRequest {
    this.handle.db.insert(v2CredentialInputRequests).values({
      ...input,
      status: "pending",
      requestedAt: nowIso(),
    }).run()
    return this.getCredentialRequest(input.projectId, input.flowId, input.id)
  }

  resolveCredentialRequest(projectId: string, flowId: string, requestId: string, status: "submitted" | "cancelled"): V2CredentialInputRequest {
    const request = this.getCredentialRequest(projectId, flowId, requestId)
    if (request.status !== "pending") throw new SocratesError("v2_credential_request_resolved", "This credential request was already resolved.", { recoverable: true })
    this.handle.db.update(v2CredentialInputRequests).set({ status, resolvedAt: nowIso() }).where(eq(v2CredentialInputRequests.id, requestId)).run()
    return this.getCredentialRequest(projectId, flowId, requestId)
  }

  submitFeedback(input: {
    projectId: string
    flowId: string
    messageId: string
    turnId?: string
    modelCallId?: string
    rating: "thumbs_up" | "thumbs_down"
    reasonCode?: string
    note?: string
  }): V2Feedback {
    const message = this.handle.db.select().from(v2Messages).where(and(eq(v2Messages.id, input.messageId), eq(v2Messages.flowId, input.flowId), eq(v2Messages.projectId, input.projectId))).get()
    if (!message || message.role !== "assistant") throw new SocratesError("v2_feedback_message_not_found", "Choose a Socrates response from this Flow.", { recoverable: true })
    const existing = this.handle.db.select().from(v2Feedback).where(eq(v2Feedback.messageId, input.messageId)).get()
    const now = nowIso()
    if (existing) {
      this.handle.db.update(v2Feedback).set({ rating: input.rating, reasonCode: input.reasonCode, note: input.note, updatedAt: now }).where(eq(v2Feedback.id, existing.id)).run()
    } else {
      this.handle.db.insert(v2Feedback).values({
        id: createId("v2fb"), flowId: input.flowId, projectId: input.projectId, goalId: message.goalId,
        turnId: input.turnId ?? message.turnId, messageId: message.id, modelCallId: input.modelCallId,
        rating: input.rating, reasonCode: input.reasonCode, note: input.note, createdBy: "user", createdAt: now, updatedAt: now,
      }).run()
    }
    const row = this.handle.db.select().from(v2Feedback).where(eq(v2Feedback.messageId, input.messageId)).get()
    if (!row) throw new SocratesError("v2_feedback_persist_failed", "Flow feedback could not be saved.")
    return mapFeedback(row)
  }

  recordEvidence(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    sourceKind: V2EvidenceItem["sourceKind"]
    sourceId?: string
    sourceUri?: string
    title: string
    content?: string
    mimeType?: string
    locator?: unknown
    metadata?: Record<string, unknown>
    rank?: number
    includeInContext?: boolean
  }): { evidence: V2EvidenceItem; contextItem?: V2ContextItem } {
    this.requireFlow(input.projectId, input.flowId)
    const exactContent = input.content ?? ""
    const now = nowIso()
    const evidenceId = createId("v2evd")
    const contentHash = crypto.createHash("sha256").update(exactContent || input.sourceUri || input.title).digest("hex")
    const handle = `evidence://${input.flowId}/${evidenceId}`
    this.handle.db.insert(v2EvidenceItems).values({
      id: evidenceId,
      handle,
      flowId: input.flowId,
      projectId: input.projectId,
      goalId: input.goalId,
      turnId: input.turnId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourceUri: input.sourceUri,
      title: input.title,
      mimeType: input.mimeType,
      content: input.content,
      contentHash,
      sizeBytes: input.content === undefined ? undefined : Buffer.byteLength(input.content),
      tokenEstimate: input.content === undefined ? undefined : estimateTokens(input.content),
      locatorJson: input.locator === undefined ? undefined : JSON.stringify(input.locator),
      createdAt: now,
      metadataJson: input.metadata === undefined ? undefined : JSON.stringify(input.metadata),
    }).run()
    let contextItem: V2ContextItem | undefined
    if (input.content !== undefined && input.includeInContext !== false) {
      const turnOrdinal = input.turnId
        ? this.handle.db.select({ ordinal: v2Turns.ordinal }).from(v2Turns).where(eq(v2Turns.id, input.turnId)).get()?.ordinal ?? 1
        : 1
      const contextId = createId("v2ctx")
      this.handle.db.insert(v2ContextItems).values({
        id: contextId,
        flowId: input.flowId,
        goalId: input.goalId,
        turnId: input.turnId,
        kind: "evidence_exact",
        state: "active",
        content: input.content,
        tokenEstimate: estimateTokens(input.content),
        rank: Math.max(0, input.rank ?? 50),
        activeFromTurnOrdinal: turnOrdinal,
        createdAt: now,
        updatedAt: now,
      }).run()
      this.handle.db.insert(v2ContextItemSources).values({
        id: createId("v2ctxsrc"), contextItemId: contextId, evidenceItemId: evidenceId, sourceOrder: 0, createdAt: now,
      }).run()
      const contextRow = this.handle.db.select().from(v2ContextItems).where(eq(v2ContextItems.id, contextId)).get()
      if (contextRow) contextItem = mapContextItem(contextRow)
    }
    const evidenceRow = this.handle.db.select().from(v2EvidenceItems).where(eq(v2EvidenceItems.id, evidenceId)).get()
    if (!evidenceRow) throw new SocratesError("v2_evidence_persist_failed", "Flow evidence could not be saved.")
    return { evidence: mapEvidence(evidenceRow), ...(contextItem ? { contextItem } : {}) }
  }

  getCoreContextState(flowId: string, turnIds?: readonly string[]): V2ContextState {
    return this.loadCoreContextState(flowId, turnIds, false)
  }

  /**
   * Returns only the projection eligible for the next model request. Released
   * rows and their expensive exact evidence stay durable in SQLite but are not
   * materialized by routine post-turn maintenance.
   */
  getActiveCoreContextState(flowId: string, turnIds?: readonly string[]): V2ContextState {
    return this.loadCoreContextState(flowId, turnIds, true)
  }

  /**
   * Loads the bounded, reference-only context projection used to assemble the
   * next foreground model request. Exact evidence bytes and the duplicate
   * exact text held by projection rows are deliberately not selected here.
   */
  getActiveContextItems(
    flowId: string,
    foregroundGoalId?: string,
    limit = V2_ACTIVE_CONTEXT_ITEM_LOAD_LIMIT,
  ): CoreV2ContextItem[] {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(V2_ACTIVE_CONTEXT_ITEM_LOAD_LIMIT, Math.floor(limit)))
      : V2_ACTIVE_CONTEXT_ITEM_LOAD_LIMIT
    const rows = this.handle.db
      .select({
        id: v2ContextItems.id,
        flowId: v2ContextItems.flowId,
        goalId: v2ContextItems.goalId,
        rank: v2ContextItems.rank,
        tokenEstimate: v2ContextItems.tokenEstimate,
        activeFromTurnOrdinal: v2ContextItems.activeFromTurnOrdinal,
        metadataJson: v2ContextItems.metadataJson,
        distilledText: sql<string | null>`CASE WHEN ${v2ContextItems.kind} = 'evidence_distill' THEN ${v2ContextItems.content} ELSE NULL END`,
        evidenceId: v2EvidenceItems.id,
        evidenceFlowId: v2EvidenceItems.flowId,
        evidenceSourceKind: v2EvidenceItems.sourceKind,
        evidenceHandle: v2EvidenceItems.handle,
        evidenceContentHash: v2EvidenceItems.contentHash,
        evidenceCreatedAt: v2EvidenceItems.createdAt,
      })
      .from(v2ContextItems)
      .innerJoin(v2ContextItemSources, and(
        eq(v2ContextItemSources.contextItemId, v2ContextItems.id),
        eq(v2ContextItemSources.sourceOrder, 0),
      ))
      .innerJoin(v2EvidenceItems, eq(v2EvidenceItems.id, v2ContextItemSources.evidenceItemId))
      .where(and(
        eq(v2ContextItems.flowId, flowId),
        eq(v2ContextItems.state, "active"),
        foregroundGoalId
          ? or(isNull(v2ContextItems.goalId), eq(v2ContextItems.goalId, foregroundGoalId))
          : undefined,
      ))
      .orderBy(
        sql`CASE WHEN (
          SELECT disposition
          FROM v2_context_dispositions
          WHERE context_item_id = ${v2ContextItems.id}
          ORDER BY version DESC
          LIMIT 1
        ) = 'unresolved' THEN 0 ELSE 1 END`,
        asc(v2ContextItems.rank),
        desc(v2ContextItems.updatedAt),
      )
      .limit(boundedLimit)
      .all()
    if (rows.length === 0) return []
    const latestDispositions = latestDispositionRows(this.handle.db
      .select()
      .from(v2ContextDispositions)
      .where(and(
        eq(v2ContextDispositions.flowId, flowId),
        inArray(v2ContextDispositions.contextItemId, rows.map((row) => row.id)),
      ))
      .orderBy(desc(v2ContextDispositions.version))
      .all())
    return rows.map((row): CoreV2ContextItem => {
      const disposition = latestDispositions.get(row.id)
      const kind = (disposition?.disposition ?? "keep_exact") as V2ContextDispositionDecision["disposition"]
      const metadata = parseJsonObject(row.metadataJson)
      return {
        id: row.id,
        flowId: row.flowId,
        ...(row.goalId ? { goalId: row.goalId } : {}),
        evidenceRef: {
          evidenceId: row.evidenceId,
          flowId: row.evidenceFlowId,
          sourceType: row.evidenceSourceKind,
          sourceLocator: row.evidenceHandle,
          contentHash: row.evidenceContentHash,
          capturedAt: row.evidenceCreatedAt,
        },
        disposition: kind,
        representation: kind === "distill" ? "distilled" : "exact",
        ...(kind === "distill" && row.distilledText ? { distilledText: row.distilledText } : {}),
        tokenEstimate: row.tokenEstimate,
        active: true,
        priority: 100 - row.rank,
        createdAtCompletedTurn: row.activeFromTurnOrdinal,
        decidedAtCompletedTurn: Number(metadata.decidedAtCompletedTurn ?? row.activeFromTurnOrdinal),
        ...(kind === "unresolved" ? {
          unresolvedSinceCompletedTurn: Number(metadata.unresolvedSinceCompletedTurn ?? row.activeFromTurnOrdinal),
          reviewDueAtCompletedTurn: Number(metadata.reviewDueAtCompletedTurn ?? row.activeFromTurnOrdinal + 3),
        } : {}),
      }
    })
  }

  getContextCounts(flowId: string): V2ContextCounts {
    const row = this.handle.sqlite.prepare(`
      SELECT
        (SELECT COUNT(*) FROM v2_evidence_items WHERE flow_id = ?) AS immutableEvidenceCount,
        (SELECT COUNT(*) FROM v2_context_items WHERE flow_id = ? AND state = 'active') AS activeItemCount,
        (SELECT COUNT(*) FROM v2_context_items WHERE flow_id = ? AND state = 'released') AS releasedItemCount
    `).get(flowId, flowId, flowId) as {
      immutableEvidenceCount: number
      activeItemCount: number
      releasedItemCount: number
    }
    return row
  }

  getLatestEvidenceByMetadata(
    flowId: string,
    metadata: Readonly<{ kind: string; goalId: string }>,
  ): ImmutableEvidenceRecord | undefined {
    const row = this.handle.db
      .select()
      .from(v2EvidenceItems)
      .where(and(
        eq(v2EvidenceItems.flowId, flowId),
        sql`json_extract(${v2EvidenceItems.metadataJson}, '$.kind') = ${metadata.kind}`,
        sql`json_extract(${v2EvidenceItems.metadataJson}, '$.goalId') = ${metadata.goalId}`,
      ))
      .orderBy(desc(v2EvidenceItems.createdAt))
      .limit(1)
      .get()
    return row ? mapCoreEvidence(row) : undefined
  }

  persistContextDispositions(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId: string
    decisions: readonly V2ContextPersistenceDecision[]
    completedTurn: number
  }): V2ContextDisposition[] {
    // The pure core policy is called by the orchestrator before this method.
    // This persistence layer re-checks the two non-negotiable bounds so direct
    // callers cannot bypass them.
    const unresolvedBefore = this.getActiveCoreContextState(input.flowId).items.filter((item) => item.disposition === "unresolved")
    const afterById = new Map(unresolvedBefore.map((item) => [item.id, item]))
    for (const decision of input.decisions) {
      if (decision.disposition === "unresolved") afterById.set(decision.contextItemId, unresolvedBefore.find((item) => item.id === decision.contextItemId) ?? ({} as never))
      else afterById.delete(decision.contextItemId)
    }
    if (afterById.size > 5) throw new SocratesError("v2_context_unresolved_limit", "Flow can retain at most five unresolved context items.", { recoverable: true })
    const now = nowIso()
    const result: V2ContextDisposition[] = []
    const operation = this.handle.sqlite.transaction(() => {
      for (const decision of input.decisions) {
        const item = this.handle.db.select().from(v2ContextItems).where(and(eq(v2ContextItems.id, decision.contextItemId), eq(v2ContextItems.flowId, input.flowId))).get()
        if (!item) throw new SocratesError("v2_context_item_not_found", "Flow context item not found.", { recoverable: true })
        const prior = this.handle.db.select().from(v2ContextDispositions).where(eq(v2ContextDispositions.contextItemId, item.id)).orderBy(desc(v2ContextDispositions.version)).limit(1).get()
        const priorMetadata = parseJsonObject(item.metadataJson)
        const unresolvedSince = decision.disposition === "unresolved"
          ? Number(priorMetadata.unresolvedSinceCompletedTurn ?? input.completedTurn)
          : undefined
        const reviewDue = unresolvedSince === undefined ? undefined : Number(priorMetadata.reviewDueAtCompletedTurn ?? unresolvedSince + 3)
        if (decision.disposition === "unresolved" && reviewDue !== undefined && input.completedTurn >= reviewDue) {
          throw new SocratesError("v2_context_unresolved_review_due", "This unresolved context item must now be kept, distilled, or released.", {
            details: { contextItemId: item.id, reviewDueAtCompletedTurn: reviewDue }, recoverable: true,
          })
        }
        const id = createId("v2disp")
        this.handle.db.insert(v2ContextDispositions).values({
          id,
          flowId: input.flowId,
          goalId: item.goalId ?? input.goalId,
          turnId: input.turnId,
          contextItemId: item.id,
          version: (prior?.version ?? 0) + 1,
          disposition: decision.disposition,
          reason: (decision.reason?.trim() || "Flow self-pruning decision").slice(0, 4_000),
          decidedBy: decision.decidedBy ?? "main_agent",
          unresolvedAgeTurns: decision.disposition === "unresolved" ? Math.max(0, input.completedTurn - (unresolvedSince ?? input.completedTurn)) : undefined,
          unresolvedMaxAgeTurns: decision.disposition === "unresolved" ? 3 : undefined,
          distillationInstruction: decision.disposition === "distill"
            ? (decision.distillationInstruction?.trim() || "Retain only query-relevant facts and exact evidence handles.").slice(0, 4_000)
            : undefined,
          replacementContextItemId: decision.replacementContextItemId,
          createdAt: now,
        }).run()
        const metadata = {
          ...priorMetadata,
          decidedAtCompletedTurn: input.completedTurn,
          ...(decision.disposition === "unresolved" ? { unresolvedSinceCompletedTurn: unresolvedSince, reviewDueAtCompletedTurn: reviewDue } : {}),
        }
        if (decision.disposition !== "unresolved") {
          delete metadata.unresolvedSinceCompletedTurn
          delete metadata.reviewDueAtCompletedTurn
        }
        this.handle.db.update(v2ContextItems).set({
          state: decision.disposition === "release" ? "released" : "active",
          releasedAtTurnOrdinal: decision.disposition === "release" ? input.completedTurn : null,
          ...(decision.disposition === "distill" && decision.distilledText ? { content: decision.distilledText, kind: "evidence_distill", tokenEstimate: estimateTokens(decision.distilledText) } : {}),
          updatedAt: now,
          metadataJson: JSON.stringify(metadata),
        }).where(eq(v2ContextItems.id, item.id)).run()
        const persisted = this.handle.db.select().from(v2ContextDispositions).where(eq(v2ContextDispositions.id, id)).get()
        if (persisted) result.push(mapDisposition(persisted))
      }
    })
    operation()
    return result
  }

  getContextItem(flowId: string, contextItemId: string): V2ContextItem {
    const row = this.handle.db
      .select()
      .from(v2ContextItems)
      .where(and(eq(v2ContextItems.id, contextItemId), eq(v2ContextItems.flowId, flowId)))
      .limit(1)
      .get()
    if (!row) throw new SocratesError("v2_context_item_not_found", "Flow context item not found.", { recoverable: true })
    return mapContextItem(row)
  }

  retrieveExactEvidence(flowId: string, evidenceIds: readonly string[]): ImmutableEvidenceRecord[] {
    const ids = uniqueStrings(evidenceIds)
    if (ids.length === 0) return []
    return this.handle.db.select().from(v2EvidenceItems).where(and(eq(v2EvidenceItems.flowId, flowId), inArray(v2EvidenceItems.id, ids))).all().map((row) => ({
      ref: { evidenceId: row.id, flowId: row.flowId, sourceType: row.sourceKind, sourceLocator: row.handle, contentHash: row.contentHash, capturedAt: row.createdAt },
      exactContent: row.content ?? "",
      ...(row.metadataJson ? { metadata: parseJsonObject(row.metadataJson) } : {}),
    }))
  }

  createTerminal(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    name: string
    command: string
    cwd: string
    autoDetached?: boolean
    metadata?: Record<string, unknown>
  }): V2Terminal {
    const id = createId("v2term")
    const now = nowIso()
    this.handle.db.insert(v2TerminalSessions).values({
      id, flowId: input.flowId, projectId: input.projectId, goalId: input.goalId, turnId: input.turnId,
      workspacePath: this.requireWorkspacePath(input.projectId), name: input.name, command: input.command, cwd: input.cwd,
      status: "starting", autoDetached: input.autoDetached ?? false, awaitingInput: false, stateVersion: 0, startedAt: now, updatedAt: now,
      metadataJson: JSON.stringify(input.metadata ?? {}),
    }).run()
    return this.getTerminal(input.projectId, input.flowId, id)
  }

  updateTerminal(terminalId: string, patch: Partial<{
    status: V2Terminal["status"]
    platform: string
    shellKind: string
    shellExecutable: string
    processId: string
    exitCode: number
    signal: string
    autoDetached: boolean
    awaitingInput: boolean
    lastPrompt: string
    completedAt: string
    name: string
    metadata: Record<string, unknown>
  }>): V2Terminal {
    const current = this.handle.db.select().from(v2TerminalSessions).where(eq(v2TerminalSessions.id, terminalId)).get()
    if (!current) throw new SocratesError("v2_terminal_not_found", "Flow Terminal not found.", { recoverable: true })
    const { metadata, ...columns } = patch
    this.handle.db.update(v2TerminalSessions).set({
      ...columns,
      ...(metadata ? { metadataJson: JSON.stringify({ ...parseJsonObject(current.metadataJson), ...metadata }) } : {}),
      stateVersion: sql`${v2TerminalSessions.stateVersion} + 1`,
      updatedAt: nowIso(),
    }).where(eq(v2TerminalSessions.id, terminalId)).run()
    const row = this.handle.db.select().from(v2TerminalSessions).where(eq(v2TerminalSessions.id, terminalId)).get()
    if (!row) throw new SocratesError("v2_terminal_not_found", "Flow Terminal not found.", { recoverable: true })
    return mapTerminal(row)
  }

  appendTerminalOutput(terminalId: string, stream: string, text: string, redacted = false): number {
    const terminal = this.handle.db.select().from(v2TerminalSessions).where(eq(v2TerminalSessions.id, terminalId)).get()
    if (!terminal) throw new SocratesError("v2_terminal_not_found", "Flow Terminal not found.", { recoverable: true })
    const sequence = this.nextInteger("v2_terminal_output_chunks", "sequence", "terminal_session_id", terminalId, 0)
    this.handle.db.insert(v2TerminalOutputChunks).values({
      id: createId("v2tout"), terminalSessionId: terminalId, flowId: terminal.flowId, sequence, stream, text, redacted, createdAt: nowIso(),
    }).run()
    return sequence
  }

  listTerminalRuntimeRecords(flowId?: string, activeOnly = false): V2TerminalRuntimeRecord[] {
    const rows = flowId
      ? this.handle.db.select().from(v2TerminalSessions).where(eq(v2TerminalSessions.flowId, flowId)).orderBy(asc(v2TerminalSessions.startedAt)).all()
      : this.handle.db.select().from(v2TerminalSessions).orderBy(asc(v2TerminalSessions.startedAt)).all()
    return rows
      .filter((row) => !activeOnly || ACTIVE_TERMINAL_STATUSES.includes(row.status as (typeof ACTIVE_TERMINAL_STATUSES)[number]))
      .map(mapTerminalRuntimeRecord)
  }

  findTerminalRuntimeRecord(projectId: string, flowId: string, identifier: string): V2TerminalRuntimeRecord | undefined {
    this.requireFlow(projectId, flowId)
    const rows = this.handle.db.select().from(v2TerminalSessions).where(and(
      eq(v2TerminalSessions.projectId, projectId),
      eq(v2TerminalSessions.flowId, flowId),
    )).orderBy(desc(v2TerminalSessions.startedAt)).all()
    const exact = rows.find((row) => row.id === identifier || row.processId === identifier)
    if (exact) return mapTerminalRuntimeRecord(exact)
    const byName = rows.filter((row) => row.name === identifier)
    const active = byName.filter((row) => ACTIVE_TERMINAL_STATUSES.includes(row.status as (typeof ACTIVE_TERMINAL_STATUSES)[number]))
    if (active.length === 1 && active[0]) return mapTerminalRuntimeRecord(active[0])
    if (byName.length === 1 && byName[0]) return mapTerminalRuntimeRecord(byName[0])
    return undefined
  }

  terminalOutputSnapshot(terminalId: string, fromSequence = 0, charLimit = 16_000): {
    stdout: string
    stderr: string
    nextSequence: number
    truncated: boolean
    originalLength: number
    returnedLength: number
  } {
    const terminal = this.handle.db.select().from(v2TerminalSessions).where(eq(v2TerminalSessions.id, terminalId)).get()
    if (!terminal) throw new SocratesError("v2_terminal_not_found", "Flow Terminal not found.", { recoverable: true })
    const chunks = this.handle.db.select().from(v2TerminalOutputChunks).where(and(
      eq(v2TerminalOutputChunks.terminalSessionId, terminalId),
      sql`${v2TerminalOutputChunks.sequence} >= ${Math.max(0, fromSequence)}`,
    )).orderBy(asc(v2TerminalOutputChunks.sequence)).all()
    const stdoutRaw = chunks.filter((chunk) => !chunk.redacted && chunk.stream !== "stderr" && chunk.stream !== "input").map((chunk) => chunk.text).join("")
    const stderrRaw = chunks.filter((chunk) => !chunk.redacted && chunk.stream === "stderr").map((chunk) => chunk.text).join("")
    const originalLength = stdoutRaw.length + stderrRaw.length
    const bounded = `${stdoutRaw}${stderrRaw}`.slice(0, Math.max(1, charLimit))
    const stdout = bounded.slice(0, Math.min(stdoutRaw.length, bounded.length))
    const stderr = bounded.slice(stdout.length)
    return {
      stdout,
      stderr,
      nextSequence: chunks.length > 0 ? (chunks.at(-1)?.sequence ?? fromSequence - 1) + 1 : fromSequence,
      truncated: bounded.length < originalLength,
      originalLength,
      returnedLength: bounded.length,
    }
  }

  setTerminalRuntimeCursors(terminalId: string, patch: { supervisorOutputSequence?: number; modelVisibleOutputSequence?: number }): void {
    const record = this.handle.db.select().from(v2TerminalSessions).where(eq(v2TerminalSessions.id, terminalId)).get()
    if (!record) throw new SocratesError("v2_terminal_not_found", "Flow Terminal not found.", { recoverable: true })
    this.handle.db.update(v2TerminalSessions).set({
      metadataJson: JSON.stringify({ ...parseJsonObject(record.metadataJson), ...patch }),
      updatedAt: nowIso(),
    }).where(eq(v2TerminalSessions.id, terminalId)).run()
  }

  registerTerminalWait(input: {
    projectId: string
    flowId: string
    goalId: string
    turnId: string
    wait: WaitToolInput
  }): { status: "waiting" | "already_ready"; message: string } {
    const turn = this.requireTurn(input.projectId, input.flowId, input.turnId)
    const task = this.handle.db.select().from(v2AgentTasks).where(and(
      eq(v2AgentTasks.currentTurnId, input.turnId),
      eq(v2AgentTasks.status, "running"),
    )).limit(1).get()
    if (!task) throw new SocratesError("v2_agent_task_not_running", "This Flow task can no longer wait for a Terminal.", { recoverable: true })
    const terminals = this.resolveNamedTerminals(input.projectId, input.flowId, input.wait.terminalNames)
    const ready = terminals.find((terminal) => {
      const event = wakeEventForV2Terminal(terminal)
      return event ? input.wait.wakeOn.includes(event) : false
    })
    if (ready) return { status: "already_ready", message: `Terminal "${ready.name}" already has a requested event; continue now.` }
    const now = nowIso()
    const metadata = parseJsonObject(task.metadataJson)
    this.handle.sqlite.transaction(() => {
      const changed = this.handle.db.update(v2AgentTasks).set({
        status: "waiting",
        waitingOnTerminalIdsJson: JSON.stringify(terminals.map((terminal) => terminal.id)),
        updatedAt: now,
        metadataJson: JSON.stringify({
          ...metadata,
          wait: {
            terminalNames: input.wait.terminalNames,
            wakeOn: input.wait.wakeOn,
            reason: input.wait.reason,
            registeredAt: now,
          },
        }),
      }).where(and(eq(v2AgentTasks.id, task.id), eq(v2AgentTasks.status, "running"))).run().changes
      if (changed === 0) throw new SocratesError("v2_agent_task_not_running", "This Flow task can no longer wait for a Terminal.", { recoverable: true })
      this.handle.db.update(v2Turns).set({
        status: "waiting",
        waitingReason: input.wait.reason,
        updatedAt: now,
        metadataJson: JSON.stringify({ ...parseJsonObject(turn.metadataJson), terminalTaskId: task.id }),
      }).where(eq(v2Turns.id, input.turnId)).run()
      this.refreshCapsule(input.goalId, input.flowId, input.turnId, now, "waiting")
    })()
    return { status: "waiting", message: "Task suspended until a requested Terminal event occurs." }
  }

  claimTerminalTaskWake(terminalId: string, wakeEvent: TerminalWaitWakeOn): V2ReadyTerminalTask[] {
    const terminal = this.handle.db.select().from(v2TerminalSessions).where(eq(v2TerminalSessions.id, terminalId)).get()
    if (!terminal) return []
    const waiting = this.handle.db.select().from(v2AgentTasks).where(eq(v2AgentTasks.status, "waiting")).all()
    const now = nowIso()
    const ready: V2ReadyTerminalTask[] = []
    this.handle.sqlite.transaction(() => {
      for (const task of waiting) {
        const terminalIds = parseStringArray(task.waitingOnTerminalIdsJson)
        const metadata = parseJsonObject(task.metadataJson)
        const wait = parseV2TaskWait(metadata.wait)
        if (!terminalIds.includes(terminalId) || !wait?.wakeOn.includes(wakeEvent)) continue
        const readyMetadata = { terminalId, wakeEvent, reason: wait.reason, wokenAt: now }
        const changed = this.handle.db.update(v2AgentTasks).set({
          status: "ready",
          waitingOnTerminalIdsJson: "[]",
          updatedAt: now,
          metadataJson: JSON.stringify({ ...metadata, ready: readyMetadata, lastWake: readyMetadata }),
        }).where(and(eq(v2AgentTasks.id, task.id), eq(v2AgentTasks.status, "waiting"))).run().changes
        if (changed === 0) continue
        const waitingTurn = this.requireTurn(task.projectId, task.flowId, task.currentTurnId)
        this.handle.db.update(v2Turns).set({
          status: "suspended",
          updatedAt: now,
          completedAt: now,
          metadataJson: JSON.stringify({ ...parseJsonObject(waitingTurn.metadataJson), terminalTaskId: task.id, wakeEvent }),
        }).where(eq(v2Turns.id, task.currentTurnId)).run()
        const mapped = this.readyTerminalTask(task.id)
        if (mapped) ready.push(mapped)
      }
    })()
    return ready
  }

  listReadyTerminalTasks(): V2ReadyTerminalTask[] {
    return this.handle.db.select({ id: v2AgentTasks.id }).from(v2AgentTasks).where(eq(v2AgentTasks.status, "ready")).all()
      .flatMap((row) => this.readyTerminalTask(row.id) ?? [])
  }

  beginTerminalTaskContinuation(task: V2ReadyTerminalTask): V2ContinuedTerminalTask | undefined {
    const now = nowIso()
    const turnId = createId("v2turn")
    const runtimeConfigId = createId("v2trc")
    const continued = this.handle.sqlite.transaction(() => {
      const current = this.handle.db.select().from(v2AgentTasks).where(and(eq(v2AgentTasks.id, task.taskId), eq(v2AgentTasks.status, "ready"))).limit(1).get()
      if (!current) return undefined
      const rootTurn = this.requireTurn(task.projectId, task.flowId, task.rootTurnId)
      if (!rootTurn.userMessageId) throw new SocratesError("v2_task_root_message_missing", "The Flow task root message is unavailable.")
      const userRow = this.handle.db.select().from(v2Messages).where(eq(v2Messages.id, rootTurn.userMessageId)).limit(1).get()
      if (!userRow) throw new SocratesError("v2_task_root_message_missing", "The Flow task root message is unavailable.")
      const ordinal = this.nextInteger("v2_turns", "ordinal", "flow_id", task.flowId)
      this.handle.db.insert(v2Turns).values({
        id: turnId,
        flowId: task.flowId,
        projectId: task.projectId,
        goalId: task.goalId,
        ordinal,
        status: "running",
        startedAt: now,
        updatedAt: now,
        metadataJson: JSON.stringify({ resumedFromTurnId: task.currentTurnId, terminalTaskId: task.taskId, wakeEvent: task.wakeEvent }),
      }).run()
      insertV2RuntimeConfig(this.handle, runtimeConfigId, turnId, task.flowId, task.runtimeConfig, now)
      const metadata = parseJsonObject(current.metadataJson)
      delete metadata.ready
      this.handle.db.update(v2AgentTasks).set({
        status: "running",
        currentTurnId: turnId,
        waitingOnTerminalIdsJson: "[]",
        updatedAt: now,
        metadataJson: JSON.stringify({ ...metadata, continuationCount: Number(metadata.continuationCount ?? 0) + 1 }),
      }).where(eq(v2AgentTasks.id, task.taskId)).run()
      const row = this.handle.db.select().from(v2Turns).where(eq(v2Turns.id, turnId)).get()
      if (!row) throw new SocratesError("v2_task_continuation_failed", "The Flow task continuation could not be created.")
      const terminalRecord = this.findTerminalRuntimeRecord(task.projectId, task.flowId, task.terminalId)
      const output = this.terminalOutputSnapshot(task.terminalId, terminalRecord?.modelVisibleOutputSequence ?? 0, 8_000)
      this.setTerminalRuntimeCursors(task.terminalId, { modelVisibleOutputSequence: output.nextSequence })
      const wakeContext = [
        `You were waiting for Terminal "${task.terminalName}".`,
        `Wake reason: ${task.wakeEvent}.`,
        `Terminal status: ${task.terminalStatus}${task.exitCode === undefined ? "" : `; exit code ${task.exitCode}`}.`,
        `Wait reason: ${task.reason}.`,
        output.stdout || output.stderr ? `New Terminal output:\n${[output.stdout, output.stderr].filter(Boolean).join("\n")}` : "No new Terminal output was captured.",
        "Continue the same task from this lifecycle evidence. Do not restart already-attempted work.",
      ].join("\n")
      return { turn: mapTurn(row), userMessage: mapMessage(userRow), wakeContext }
    })()
    return continued ? { ...task, ...continued, runtimeConfigId } : undefined
  }

  getArtifact(projectId: string, flowId: string, artifactId: string): V2Artifact {
    const row = this.handle.db.select().from(v2Artifacts).where(and(eq(v2Artifacts.id, artifactId), eq(v2Artifacts.projectId, projectId), eq(v2Artifacts.flowId, flowId))).get()
    if (!row) throw new SocratesError("v2_artifact_not_found", "Flow artifact not found.", { recoverable: true })
    return mapArtifact(row)
  }

  requireFlowScope(input: { projectId: string; flowId: string }): void {
    this.requireFlow(input.projectId, input.flowId)
  }

  createSpeechArtifact(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    kind: "speech_input" | "speech_output"
    fileName: string
    mimeType: string
    data: Buffer
  }): V2Artifact {
    this.requireFlow(input.projectId, input.flowId)
    const stored = storeAttachmentFile({
      workspacePath: this.requireWorkspacePath(input.projectId),
      originalName: input.fileName,
      data: input.data,
    })
    const id = createId("v2art")
    this.handle.db.insert(v2Artifacts).values({
      id,
      flowId: input.flowId,
      projectId: input.projectId,
      goalId: input.goalId,
      turnId: input.turnId,
      kind: input.kind,
      path: stored.path,
      uri: stored.path,
      contentHash: crypto.createHash("sha256").update(input.data).digest("hex"),
      mimeType: input.mimeType,
      sizeBytes: input.data.byteLength,
      createdAt: nowIso(),
    }).run()
    return this.getArtifact(input.projectId, input.flowId, id)
  }

  readSpeechArtifact(input: { projectId: string; flowId: string; artifactId: string }): V2SpeechArtifactContent {
    const artifact = this.getArtifact(input.projectId, input.flowId, input.artifactId)
    return { artifact, ...(artifact.path ? { path: artifact.path } : {}) }
  }

  createSpeechJob(input: { projectId: string; flowId: string; request: V2CreateSpeechJobRequest }): V2SpeechJob {
    this.requireFlow(input.projectId, input.flowId)
    const id = createId("v2speech")
    const request = input.request
    this.handle.db.insert(v2SpeechJobs).values({
      id,
      flowId: input.flowId,
      projectId: input.projectId,
      goalId: request.goalId,
      turnId: request.turnId,
      messageId: request.messageId,
      kind: request.kind,
      engine: request.engine,
      modelId: request.modelId,
      status: "queued",
      inputArtifactId: request.kind === "transcription" ? request.inputArtifactId : undefined,
      inputText: request.kind === "synthesis" ? request.inputText : undefined,
      voiceId: request.kind === "synthesis" ? request.voiceId : undefined,
      speed: request.kind === "synthesis" ? request.speed : undefined,
      language: request.language,
      createdAt: nowIso(),
    }).run()
    return this.getSpeechJob({ projectId: input.projectId, flowId: input.flowId, jobId: id })
  }

  updateSpeechJob(input: { projectId: string; flowId: string; jobId: string; update: V2SpeechJobUpdate }): V2SpeechJob {
    const current = this.getSpeechJob(input)
    let errorId: string | undefined
    if (input.update.status === "failed") {
      errorId = this.insertError({
        projectId: input.projectId,
        flowId: input.flowId,
        ...(current.goalId ? { goalId: current.goalId } : {}),
        ...(current.turnId ? { turnId: current.turnId } : {}),
        source: "speech",
        code: input.update.error.code,
        message: input.update.error.message,
        ...(input.update.error.details === undefined ? {} : { details: input.update.error.details }),
        recoverable: input.update.error.recoverable,
      }).id
    }
    this.handle.db.update(v2SpeechJobs).set({
      status: input.update.status,
      ...("startedAt" in input.update ? { startedAt: input.update.startedAt } : {}),
      ...("completedAt" in input.update ? { completedAt: input.update.completedAt } : {}),
      ...("durationMs" in input.update ? { durationMs: input.update.durationMs } : {}),
      ...("transcriptText" in input.update ? { transcriptText: input.update.transcriptText } : {}),
      ...("outputArtifactId" in input.update ? { outputArtifactId: input.update.outputArtifactId } : {}),
      ...(errorId ? { errorId } : {}),
      ...("usage" in input.update || "providerRaw" in input.update
        ? { metadataJson: JSON.stringify({ ...("usage" in input.update ? { usage: input.update.usage } : {}), ...("providerRaw" in input.update ? { providerRaw: input.update.providerRaw } : {}) }) }
        : {}),
    }).where(and(eq(v2SpeechJobs.id, input.jobId), eq(v2SpeechJobs.projectId, input.projectId), eq(v2SpeechJobs.flowId, input.flowId))).run()
    return this.getSpeechJob(input)
  }

  getSpeechJob(input: { projectId: string; flowId: string; jobId: string }): V2SpeechJob {
    const row = this.handle.db.select().from(v2SpeechJobs).where(and(eq(v2SpeechJobs.id, input.jobId), eq(v2SpeechJobs.projectId, input.projectId), eq(v2SpeechJobs.flowId, input.flowId))).get()
    if (!row) throw new SocratesError("v2_speech_job_not_found", "Flow speech job not found.", { recoverable: true })
    return mapSpeechJob(row)
  }

  countV1Rows(): Record<string, number> {
    const tables = [
      "conversations",
      "sessions",
      "turns",
      "messages",
      "message_attachments",
      "model_calls",
      "tool_calls",
      "approvals",
      "events",
      "terminal_sessions",
      "terminal_output_chunks",
      "agent_tasks",
      "agent_task_waits",
      "agent_task_turns",
      "message_feedback",
    ]
    const bridgeProjectionTables = new Set(["conversations", "sessions", "turns", "messages", "message_attachments"])
    return Object.fromEntries(tables.map((table) => {
      const where = bridgeProjectionTables.has(table)
        ? ` WHERE metadata_json IS NULL OR metadata_json NOT LIKE '%\"source\":\"v2_bridge\"%'`
        : ""
      return [table, Number((this.handle.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}${where}`).get() as { count: number }).count)]
    }))
  }

  private getAttachments(projectId: string, flowId: string, ids: string[]): V2MessageAttachment[] {
    if (ids.length === 0) return []
    return this.handle.db.select().from(v2MessageAttachments).where(and(eq(v2MessageAttachments.projectId, projectId), eq(v2MessageAttachments.flowId, flowId), inArray(v2MessageAttachments.id, ids))).all().map(mapAttachment)
  }

  private getToolCall(id: string): V2ToolCall {
    const row = this.handle.db.select().from(v2ToolCalls).where(eq(v2ToolCalls.id, id)).get()
    if (!row) throw new SocratesError("v2_tool_call_not_found", "Flow tool call not found.")
    return mapToolCall(row)
  }

  private getCredentialRequest(projectId: string, flowId: string, id: string): V2CredentialInputRequest {
    const row = this.handle.db.select().from(v2CredentialInputRequests).where(and(eq(v2CredentialInputRequests.id, id), eq(v2CredentialInputRequests.projectId, projectId), eq(v2CredentialInputRequests.flowId, flowId))).get()
    if (!row) throw new SocratesError("v2_credential_request_not_found", "Flow credential request not found.", { recoverable: true })
    return mapCredentialRequest(row)
  }

  private resolveNamedTerminals(
    projectId: string,
    flowId: string,
    names: readonly string[],
  ): Array<typeof v2TerminalSessions.$inferSelect> {
    this.requireFlow(projectId, flowId)
    const requested = uniqueStrings(names)
    if (requested.length === 0) {
      throw new SocratesError("v2_terminal_wait_empty", "Choose at least one Terminal to wait for.", { recoverable: true })
    }
    const rows = this.handle.db.select().from(v2TerminalSessions).where(and(
      eq(v2TerminalSessions.projectId, projectId),
      eq(v2TerminalSessions.flowId, flowId),
      inArray(v2TerminalSessions.name, requested),
    )).orderBy(desc(v2TerminalSessions.startedAt)).all()
    return requested.map((name) => {
      const matches = rows.filter((row) => row.name === name)
      const active = matches.filter((row) => ACTIVE_TERMINAL_STATUSES.includes(row.status as (typeof ACTIVE_TERMINAL_STATUSES)[number]))
      const selected = active[0] ?? matches[0]
      if (!selected) {
        throw new SocratesError("v2_terminal_not_found", `Flow Terminal "${name}" was not found.`, { recoverable: true })
      }
      if (active.length > 1) {
        throw new SocratesError("v2_terminal_ambiguous", `More than one active Flow Terminal is named "${name}".`, { recoverable: true })
      }
      return selected
    })
  }

  private readyTerminalTask(taskId: string): V2ReadyTerminalTask | undefined {
    const task = this.handle.db.select().from(v2AgentTasks).where(and(
      eq(v2AgentTasks.id, taskId),
      eq(v2AgentTasks.status, "ready"),
    )).limit(1).get()
    if (!task) return undefined
    const metadata = parseJsonObject(task.metadataJson)
    const ready = parseV2TaskReady(metadata.ready)
    if (!ready) return undefined
    const terminal = this.handle.db.select().from(v2TerminalSessions).where(and(
      eq(v2TerminalSessions.id, ready.terminalId),
      eq(v2TerminalSessions.projectId, task.projectId),
      eq(v2TerminalSessions.flowId, task.flowId),
    )).limit(1).get()
    const suspendedTurn = this.handle.db.select().from(v2Turns).where(and(
      eq(v2Turns.id, task.currentTurnId),
      eq(v2Turns.projectId, task.projectId),
      eq(v2Turns.flowId, task.flowId),
    )).limit(1).get()
    if (!terminal || !suspendedTurn) return undefined
    const goalId = task.goalId ?? suspendedTurn.goalId
    if (!goalId) return undefined
    const parsedRuntimeConfig = v2RuntimeConfigSchema.safeParse(parseJson(task.runtimeConfigJson))
    if (!parsedRuntimeConfig.success) return undefined
    return {
      taskId: task.id,
      terminalId: terminal.id,
      projectId: task.projectId,
      flowId: task.flowId,
      goalId,
      rootTurnId: task.rootTurnId,
      currentTurnId: task.currentTurnId,
      runtimeConfig: parsedRuntimeConfig.data,
      reason: ready.reason,
      terminalName: terminal.name,
      terminalStatus: terminal.status as V2Terminal["status"],
      ...(terminal.exitCode === null ? {} : { exitCode: terminal.exitCode }),
      wakeEvent: ready.wakeEvent,
      suspendedTurn: mapTurn(suspendedTurn),
    }
  }

  private getTerminal(projectId: string, flowId: string, id: string): V2Terminal {
    const row = this.handle.db.select().from(v2TerminalSessions).where(and(eq(v2TerminalSessions.id, id), eq(v2TerminalSessions.projectId, projectId), eq(v2TerminalSessions.flowId, flowId))).get()
    if (!row) throw new SocratesError("v2_terminal_not_found", "Flow Terminal not found.", { recoverable: true })
    return mapTerminal(row)
  }

  private loadMessagePage(flowId: string, beforeOrdinal: number | undefined, limit: number): V2MessagePage {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(V2_FLOW_MESSAGE_PAGE_MAX, Math.floor(limit)))
      : V2_FLOW_SNAPSHOT_MESSAGE_LIMIT
    const rowsDescending = this.handle.db
      .select()
      .from(v2Messages)
      .where(beforeOrdinal === undefined
        ? eq(v2Messages.flowId, flowId)
        : and(eq(v2Messages.flowId, flowId), lt(v2Messages.ordinal, beforeOrdinal)))
      .orderBy(desc(v2Messages.ordinal))
      .limit(boundedLimit + 1)
      .all()
    const hasEarlier = rowsDescending.length > boundedLimit
    const rows = rowsDescending.slice(0, boundedLimit).reverse()
    const attachmentRows = rows.length === 0
      ? []
      : this.handle.db
          .select()
          .from(v2MessageAttachments)
          .where(and(
            inArray(v2MessageAttachments.messageId, rows.map((row) => row.id)),
            eq(v2MessageAttachments.status, "attached"),
          ))
          .all()
    const attachmentsByMessage = new Map<string, V2MessageAttachment[]>()
    for (const row of attachmentRows) {
      if (!row.messageId) continue
      attachmentsByMessage.set(row.messageId, [...(attachmentsByMessage.get(row.messageId) ?? []), mapAttachment(row)])
    }
    const messages = rows.map((row) => mapMessage(row, attachmentsByMessage.get(row.id)))
    return {
      messages,
      messageWindow: {
        hasEarlier,
        ...(hasEarlier && messages[0] ? { beforeOrdinal: messages[0].ordinal } : {}),
      },
    }
  }

  private loadCoreContextState(
    flowId: string,
    turnIds: readonly string[] | undefined,
    activeOnly: boolean,
  ): V2ContextState {
    const selectedTurnIds = turnIds ? uniqueStrings(turnIds) : undefined
    if (selectedTurnIds && selectedTurnIds.length === 0) return { evidence: [], items: [] }
    const itemWhere = selectedTurnIds
      ? activeOnly
        ? and(
            eq(v2ContextItems.flowId, flowId),
            eq(v2ContextItems.state, "active"),
            inArray(v2ContextItems.turnId, selectedTurnIds),
          )
        : and(eq(v2ContextItems.flowId, flowId), inArray(v2ContextItems.turnId, selectedTurnIds))
      : activeOnly
        ? and(eq(v2ContextItems.flowId, flowId), eq(v2ContextItems.state, "active"))
        : eq(v2ContextItems.flowId, flowId)
    const itemRows = this.handle.db
      .select()
      .from(v2ContextItems)
      .where(itemWhere)
      .orderBy(asc(v2ContextItems.rank), asc(v2ContextItems.createdAt))
      .all()
    if (activeOnly && itemRows.length === 0) return { evidence: [], items: [] }

    const itemIds = itemRows.map((row) => row.id)
    const sources = itemIds.length === 0
      ? []
      : this.handle.db
          .select()
          .from(v2ContextItemSources)
          .where(inArray(v2ContextItemSources.contextItemId, itemIds))
          .orderBy(asc(v2ContextItemSources.sourceOrder))
          .all()
    const linkedEvidenceIds = uniqueStrings(sources.flatMap((source) => source.evidenceItemId ? [source.evidenceItemId] : []))
    const evidenceRows = activeOnly
      ? linkedEvidenceIds.length === 0
        ? []
        : this.handle.db
            .select()
            .from(v2EvidenceItems)
            .where(and(eq(v2EvidenceItems.flowId, flowId), inArray(v2EvidenceItems.id, linkedEvidenceIds)))
            .orderBy(asc(v2EvidenceItems.createdAt))
            .all()
      : this.handle.db
          .select()
          .from(v2EvidenceItems)
          .where(selectedTurnIds
            ? and(eq(v2EvidenceItems.flowId, flowId), inArray(v2EvidenceItems.turnId, selectedTurnIds))
            : eq(v2EvidenceItems.flowId, flowId))
          .orderBy(asc(v2EvidenceItems.createdAt))
          .all()
    const dispositionRows = itemIds.length === 0
      ? []
      : this.handle.db
          .select()
          .from(v2ContextDispositions)
          .where(and(
            eq(v2ContextDispositions.flowId, flowId),
            inArray(v2ContextDispositions.contextItemId, itemIds),
          ))
          .orderBy(desc(v2ContextDispositions.version))
          .all()
    const latestDispositions = latestDispositionRows(dispositionRows)
    const evidence = evidenceRows.map(mapCoreEvidence)
    const evidenceById = new Map(evidence.map((record) => [record.ref.evidenceId, record]))
    const evidenceSourceByItem = new Map<string, string>()
    for (const source of sources) {
      if (source.evidenceItemId && !evidenceSourceByItem.has(source.contextItemId)) {
        evidenceSourceByItem.set(source.contextItemId, source.evidenceItemId)
      }
    }
    const items: CoreV2ContextItem[] = itemRows.flatMap((row): CoreV2ContextItem[] => {
      const evidenceId = evidenceSourceByItem.get(row.id)
      const evidenceRecord = evidenceId ? evidenceById.get(evidenceId) : undefined
      if (!evidenceRecord) return []
      const disposition = latestDispositions.get(row.id)
      const kind = (disposition?.disposition ?? (row.state === "released" ? "release" : "keep_exact")) as V2ContextDispositionDecision["disposition"]
      const metadata = parseJsonObject(row.metadataJson)
      return [{
        id: row.id,
        flowId: row.flowId,
        ...(row.goalId ? { goalId: row.goalId } : {}),
        evidenceRef: evidenceRecord.ref,
        disposition: kind,
        representation: kind === "distill" ? "distilled" as const : "exact" as const,
        ...(kind === "distill" ? { distilledText: row.content } : {}),
        tokenEstimate: row.tokenEstimate,
        active: row.state === "active",
        priority: 100 - row.rank,
        createdAtCompletedTurn: row.activeFromTurnOrdinal,
        decidedAtCompletedTurn: Number(metadata.decidedAtCompletedTurn ?? row.activeFromTurnOrdinal),
        ...(kind === "unresolved" ? {
          unresolvedSinceCompletedTurn: Number(metadata.unresolvedSinceCompletedTurn ?? row.activeFromTurnOrdinal),
          reviewDueAtCompletedTurn: Number(metadata.reviewDueAtCompletedTurn ?? row.activeFromTurnOrdinal + 3),
        } : {}),
      }]
    })
    return { evidence, items }
  }

  private importClassicBridgeTurns(bridgeId: string): void {
    const bridge = this.handle.db.select().from(v2ClassicConversationBridges).where(eq(v2ClassicConversationBridges.id, bridgeId)).limit(1).get()
    if (!bridge) throw new SocratesError("v2_bridge_not_found", "The Classic conversation bridge was not found.", { recoverable: true })
    const classicTurns = this.handle.db.select().from(turns).where(and(eq(turns.conversationId, bridge.conversationId), eq(turns.status, "completed"))).orderBy(asc(turns.startedAt)).all()
    for (const classicTurn of classicTurns) {
      if (!classicTurn.userMessageId || !classicTurn.assistantMessageId) continue
      const existing = this.handle.db.select({ id: v2ClassicMessageLinks.id }).from(v2ClassicMessageLinks).where(or(
        eq(v2ClassicMessageLinks.classicMessageId, classicTurn.userMessageId),
        eq(v2ClassicMessageLinks.classicMessageId, classicTurn.assistantMessageId),
      )).limit(1).get()
      if (existing) continue
      const user = this.handle.db.select().from(messages).where(eq(messages.id, classicTurn.userMessageId)).limit(1).get()
      const assistant = this.handle.db.select().from(messages).where(eq(messages.id, classicTurn.assistantMessageId)).limit(1).get()
      if (!user || !assistant) continue
      const goalLink = this.handle.db.select().from(v2ClassicTurnGoalLinks).where(eq(v2ClassicTurnGoalLinks.turnId, classicTurn.id)).limit(1).get()
      const goalId = goalLink?.goalId ?? bridge.goalId
      this.handle.sqlite.transaction(() => {
        const now = nowIso()
        const v2TurnId = createId("v2turn")
        const v2UserId = createId("v2msg")
        const v2AssistantId = createId("v2msg")
        this.handle.db.insert(v2Turns).values({
          id: v2TurnId,
          flowId: bridge.flowId,
          projectId: bridge.projectId,
          goalId,
          ordinal: this.nextInteger("v2_turns", "ordinal", "flow_id", bridge.flowId),
          userMessageId: v2UserId,
          assistantMessageId: v2AssistantId,
          status: "completed",
          startedAt: classicTurn.startedAt,
          updatedAt: classicTurn.completedAt ?? now,
          completedAt: classicTurn.completedAt ?? now,
          metadataJson: JSON.stringify({ source: "classic_bridge", classicTurnId: classicTurn.id }),
        }).run()
        this.handle.db.insert(v2Messages).values([
          {
            id: v2UserId, flowId: bridge.flowId, projectId: bridge.projectId, goalId, turnId: v2TurnId,
            ordinal: this.nextInteger("v2_messages", "ordinal", "flow_id", bridge.flowId), role: "user", kind: "bridge_import",
            content: user.content, status: "completed", createdAt: user.createdAt, completedAt: user.completedAt ?? user.createdAt,
            metadataJson: JSON.stringify({ source: "classic_bridge", classicMessageId: user.id }),
          },
          {
            id: v2AssistantId, flowId: bridge.flowId, projectId: bridge.projectId, goalId, turnId: v2TurnId,
            ordinal: this.nextInteger("v2_messages", "ordinal", "flow_id", bridge.flowId) + 1, role: "assistant", kind: "bridge_import",
            content: assistant.content, status: "completed", parentMessageId: v2UserId, createdAt: assistant.createdAt, completedAt: assistant.completedAt ?? assistant.createdAt,
            metadataJson: JSON.stringify({ source: "classic_bridge", classicMessageId: assistant.id }),
          },
        ]).run()
        this.handle.db.insert(v2GoalMessageLinks).values([
          { id: createId("v2link"), flowId: bridge.flowId, goalId, messageId: v2UserId, turnId: v2TurnId, relation: "primary", createdAt: now },
          { id: createId("v2link"), flowId: bridge.flowId, goalId, messageId: v2AssistantId, turnId: v2TurnId, relation: "primary", createdAt: now },
        ]).run()
        this.handle.db.insert(v2ClassicMessageLinks).values([
          { id: createId("v2blink"), bridgeId: bridge.id, v2MessageId: v2UserId, classicMessageId: user.id, direction: "classic_to_v2", sourceRuntime: "classic", createdAt: now },
          { id: createId("v2blink"), bridgeId: bridge.id, v2MessageId: v2AssistantId, classicMessageId: assistant.id, direction: "classic_to_v2", sourceRuntime: "classic", createdAt: now },
        ]).run()
        const classicAttachments = this.handle.db.select().from(messageAttachments).where(and(eq(messageAttachments.messageId, user.id), eq(messageAttachments.status, "attached"))).all()
        for (const attachment of classicAttachments) {
          const artifactId = createId("v2art")
          this.handle.db.insert(v2Artifacts).values({
            id: artifactId, flowId: bridge.flowId, projectId: bridge.projectId, goalId, turnId: v2TurnId,
            kind: "message_attachment", path: attachment.uri, uri: attachment.uri, mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes, createdAt: attachment.createdAt,
          }).run()
          this.handle.db.insert(v2MessageAttachments).values({
            id: createId("v2att"), projectId: bridge.projectId, flowId: bridge.flowId, goalId,
            turnId: v2TurnId, messageId: v2UserId, artifactId, kind: attachment.kind, fileName: attachment.fileName,
            mimeType: attachment.mimeType, sizeBytes: attachment.sizeBytes, uri: attachment.uri, status: "attached",
            createdAt: attachment.createdAt, updatedAt: now,
          }).run()
        }
        this.handle.db.update(v2ClassicConversationBridges).set({ lastClassicMessageCreatedAt: assistant.createdAt, updatedAt: now }).where(eq(v2ClassicConversationBridges.id, bridge.id)).run()
        this.handle.db.update(v2Flows).set({ revision: sql`${v2Flows.revision} + 1`, updatedAt: now }).where(eq(v2Flows.id, bridge.flowId)).run()
        this.refreshCapsule(goalId, bridge.flowId, v2TurnId, now, "turn_completed")
      })()
    }
  }

  private authorizeEvidenceDeletion(targetKind: "turn" | "goal" | "flow", targetId: string): void {
    this.handle.db.insert(v2DeletionAuthorizations).values({
      id: createId("v2del"),
      targetKind,
      targetId,
      createdAt: nowIso(),
    }).onConflictDoNothing().run()
  }

  private deleteRowsByIds(table: string, column: string, ids: string[]): void {
    const unique = [...new Set(ids)]
    if (unique.length === 0) return
    const placeholders = unique.map(() => "?").join(", ")
    this.handle.sqlite.prepare(`DELETE FROM ${table} WHERE ${column} IN (${placeholders})`).run(...unique)
  }

  private deleteContextSources(contextIds: string[], evidenceIds: string[], capsuleIds: string[], messageIds: string[] = []): void {
    this.deleteRowsByIds("v2_context_item_sources", "context_item_id", contextIds)
    this.deleteRowsByIds("v2_context_item_sources", "evidence_item_id", evidenceIds)
    this.deleteRowsByIds("v2_context_item_sources", "capsule_id", capsuleIds)
    this.deleteRowsByIds("v2_context_item_sources", "message_id", messageIds)
  }

  private deleteV2TurnsWithinTransaction(turnIds: string[]): void {
    const uniqueTurnIds = [...new Set(turnIds)]
    if (uniqueTurnIds.length === 0) return
    const placeholders = uniqueTurnIds.map(() => "?").join(", ")
    const messageIds = this.handle.sqlite.prepare(
      `SELECT id FROM v2_messages WHERE turn_id IN (${placeholders})`,
    ).all(...uniqueTurnIds).map((row) => (row as { id: string }).id)
    const classicTurnIds = messageIds.length === 0 ? [] : this.handle.sqlite.prepare(
      `SELECT DISTINCT m.turn_id AS id
       FROM v2_classic_message_links l
       INNER JOIN messages m ON m.id = l.classic_message_id
       WHERE l.v2_message_id IN (${messageIds.map(() => "?").join(", ")}) AND m.turn_id IS NOT NULL`,
    ).all(...messageIds).map((row) => (row as { id: string }).id)
    const contextIds = this.handle.sqlite.prepare(
      `SELECT id FROM v2_context_items WHERE turn_id IN (${placeholders})`,
    ).all(...uniqueTurnIds).map((row) => (row as { id: string }).id)
    const evidenceIds = this.handle.sqlite.prepare(
      `SELECT id FROM v2_evidence_items WHERE turn_id IN (${placeholders})`,
    ).all(...uniqueTurnIds).map((row) => (row as { id: string }).id)
    const capsuleIds = this.handle.sqlite.prepare(
      `SELECT id FROM v2_goal_capsules WHERE created_by_turn_id IN (${placeholders})`,
    ).all(...uniqueTurnIds).map((row) => (row as { id: string }).id)
    const terminalIds = this.handle.sqlite.prepare(
      `SELECT id FROM v2_terminal_sessions WHERE turn_id IN (${placeholders})`,
    ).all(...uniqueTurnIds).map((row) => (row as { id: string }).id)
    const affectedGoalIds = this.handle.sqlite.prepare(
      `SELECT DISTINCT goal_id AS id FROM v2_turns WHERE id IN (${placeholders}) AND goal_id IS NOT NULL`,
    ).all(...uniqueTurnIds).map((row) => (row as { id: string }).id)

    for (const turnId of uniqueTurnIds) this.authorizeEvidenceDeletion("turn", turnId)
    this.deleteContextSources(contextIds, evidenceIds, capsuleIds, messageIds)
    this.deleteRowsByIds("v2_context_dispositions", "context_item_id", contextIds)
    this.deleteRowsByIds("v2_terminal_output_chunks", "terminal_session_id", terminalIds)
    this.deleteRowsByIds("v2_classic_message_links", "v2_message_id", messageIds)
    this.deleteRowsByIds("v2_goal_message_links", "message_id", messageIds)
    this.deleteRowsByIds("v2_feedback", "message_id", messageIds)

    for (const table of [
      "v2_turn_runtime_configs", "v2_goal_routing_runs", "v2_context_dispositions", "v2_context_items",
      "v2_runtime_events", "v2_usage_events", "v2_tool_calls", "v2_approvals", "v2_terminal_sessions",
      "v2_errors", "v2_artifacts", "v2_speech_jobs", "v2_feedback", "v2_credential_input_requests",
      "v2_message_attachments", "v2_model_calls",
    ]) {
      this.deleteRowsByIds(table, "turn_id", uniqueTurnIds)
    }
    this.handle.sqlite.prepare(
      `DELETE FROM v2_agent_tasks WHERE root_turn_id IN (${placeholders}) OR current_turn_id IN (${placeholders})`,
    ).run(...uniqueTurnIds, ...uniqueTurnIds)
    this.deleteRowsByIds("v2_goal_transitions", "turn_id", uniqueTurnIds)
    this.deleteRowsByIds("v2_goal_capsules", "created_by_turn_id", uniqueTurnIds)
    this.deleteRowsByIds("v2_evidence_items", "turn_id", uniqueTurnIds)
    this.deleteRowsByIds("v2_messages", "turn_id", uniqueTurnIds)
    this.deleteRowsByIds("v2_turns", "id", uniqueTurnIds)
    this.deleteRowsByIds("v2_deletion_authorizations", "target_id", uniqueTurnIds)
    this.deleteClassicTurnsWithinTransaction(classicTurnIds)
    this.deleteRowsByIds("v2_goal_capsules", "goal_id", affectedGoalIds)
  }

  private deleteClassicTurnsWithinTransaction(turnIds: string[]): void {
    const uniqueTurnIds = [...new Set(turnIds)]
    if (uniqueTurnIds.length === 0) return
    const placeholders = uniqueTurnIds.map(() => "?").join(", ")
    const shellCommandIds = this.handle.sqlite.prepare(
      `SELECT id FROM shell_commands WHERE turn_id IN (${placeholders})`,
    ).all(...uniqueTurnIds).map((row) => (row as { id: string }).id)
    const traceDocumentIds = this.handle.sqlite.prepare(
      `SELECT id FROM trace_documents WHERE turn_id IN (${placeholders})`,
    ).all(...uniqueTurnIds).map((row) => (row as { id: string }).id)
    const taskIds = this.handle.sqlite.prepare(
      `SELECT id FROM agent_tasks
       WHERE root_turn_id IN (${placeholders}) OR current_turn_id IN (${placeholders})
          OR id IN (SELECT task_id FROM agent_task_turns WHERE turn_id IN (${placeholders}))`,
    ).all(...uniqueTurnIds, ...uniqueTurnIds, ...uniqueTurnIds).map((row) => (row as { id: string }).id)

    this.deleteRowsByIds("shell_output_chunks", "shell_command_id", shellCommandIds)
    this.deleteRowsByIds("trace_embeddings", "trace_document_id", traceDocumentIds)
    const deleteFts = this.handle.sqlite.prepare("DELETE FROM trace_documents_fts WHERE trace_document_id = ?")
    for (const id of traceDocumentIds) deleteFts.run(id)
    this.deleteRowsByIds("trace_documents", "id", traceDocumentIds)
    this.deleteRowsByIds("agent_task_waits", "task_id", taskIds)
    this.deleteRowsByIds("agent_task_turns", "task_id", taskIds)
    this.deleteRowsByIds("task_evidence_references", "task_id", taskIds)
    this.deleteRowsByIds("agent_tasks", "id", taskIds)
    for (const table of [
      "turn_runtime_configs", "model_stream_chunks", "model_usage", "ai_usage_events", "turn_usage_reports",
      "message_feedback", "message_attachments", "audio_outputs", "voice_inputs", "patches", "file_operations",
      "shell_commands", "approvals", "tool_calls", "context_usage_snapshots", "model_calls",
      "artifacts", "errors", "events", "messages",
      "trace_index_jobs", "notifications",
    ]) {
      this.deleteRowsByIds(table, "turn_id", uniqueTurnIds)
    }
    this.deleteRowsByIds("v2_classic_turn_goal_links", "turn_id", uniqueTurnIds)
    this.deleteRowsByIds("turns", "id", uniqueTurnIds)
  }

  private deleteEmptyClassicConversationWithinTransaction(conversationId: string): void {
    const sessionIds = this.handle.sqlite.prepare("SELECT id FROM sessions WHERE conversation_id = ?").all(conversationId).map((row) => (row as { id: string }).id)
    const terminalIds = this.handle.sqlite.prepare("SELECT id FROM terminal_sessions WHERE conversation_id = ?").all(conversationId).map((row) => (row as { id: string }).id)
    const shellCommandIds = this.handle.sqlite.prepare("SELECT id FROM shell_commands WHERE conversation_id = ?").all(conversationId).map((row) => (row as { id: string }).id)
    const traceDocumentIds = this.handle.sqlite.prepare("SELECT id FROM trace_documents WHERE conversation_id = ?").all(conversationId).map((row) => (row as { id: string }).id)
    this.deleteRowsByIds("terminal_output_chunks", "terminal_session_id", terminalIds)
    this.deleteRowsByIds("shell_output_chunks", "shell_command_id", shellCommandIds)
    this.deleteRowsByIds("trace_embeddings", "trace_document_id", traceDocumentIds)
    const deleteFts = this.handle.sqlite.prepare("DELETE FROM trace_documents_fts WHERE trace_document_id = ?")
    for (const id of traceDocumentIds) deleteFts.run(id)
    this.deleteRowsByIds("trace_documents", "id", traceDocumentIds)
    this.deleteRowsByIds("session_state", "session_id", sessionIds)
    for (const table of [
      "message_feedback", "message_attachments", "audio_outputs", "voice_inputs", "patches", "file_operations",
      "shell_commands", "terminal_sessions", "approvals", "tool_calls", "context_usage_snapshots", "model_calls",
      "artifacts", "errors", "events", "messages", "turns", "trace_index_jobs", "notifications",
    ]) {
      this.handle.sqlite.prepare(`DELETE FROM ${table} WHERE conversation_id = ?`).run(conversationId)
    }
    this.handle.sqlite.prepare("DELETE FROM sessions WHERE conversation_id = ?").run(conversationId)
    this.handle.sqlite.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId)
  }

  private hasActiveGoalWork(flowId: string, goalId: string): boolean {
    const activeTurn = this.handle.db.select({ id: v2Turns.id }).from(v2Turns).where(and(
      eq(v2Turns.flowId, flowId),
      eq(v2Turns.goalId, goalId),
      inArray(v2Turns.status, [...ACTIVE_TURN_STATUSES]),
    )).limit(1).get()
    if (activeTurn) return true
    const activeTerminal = this.handle.db.select({ id: v2TerminalSessions.id }).from(v2TerminalSessions).where(and(
      eq(v2TerminalSessions.flowId, flowId),
      eq(v2TerminalSessions.goalId, goalId),
      inArray(v2TerminalSessions.status, [...ACTIVE_TERMINAL_STATUSES]),
    )).limit(1).get()
    if (activeTerminal) return true
    return Boolean(this.handle.db.select({ id: v2Approvals.id }).from(v2Approvals).where(and(
      eq(v2Approvals.flowId, flowId),
      eq(v2Approvals.goalId, goalId),
      eq(v2Approvals.status, "pending"),
    )).limit(1).get())
  }

  private requireProject(projectId: string): typeof projects.$inferSelect {
    const row = this.handle.db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.status, "active"))).limit(1).get()
    if (!row) throw new SocratesError("project_not_found", "Project not found.", { recoverable: true })
    return row
  }

  private requireFlow(projectId: string, flowId: string): typeof v2Flows.$inferSelect {
    const row = this.handle.db.select().from(v2Flows).where(and(eq(v2Flows.id, flowId), eq(v2Flows.projectId, projectId))).limit(1).get()
    if (!row || row.status === "archived") throw new SocratesError("v2_flow_not_found", "Seamless Flow not found.", { recoverable: true })
    return row
  }

  private requireTurn(projectId: string, flowId: string, turnId: string): typeof v2Turns.$inferSelect {
    const row = this.handle.db.select().from(v2Turns).where(and(eq(v2Turns.id, turnId), eq(v2Turns.projectId, projectId), eq(v2Turns.flowId, flowId))).limit(1).get()
    if (!row) throw new SocratesError("v2_turn_not_found", "Flow turn not found.", { recoverable: true })
    return row
  }

  private requireWorkspacePath(projectId: string): string {
    const row = this.handle.db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.projectId, projectId), eq(projectWorkspaces.isPrimary, true), inArray(projectWorkspaces.status, ["active", "missing"]))).limit(1).get()
    if (!row?.path) throw new SocratesError("project_workspace_path_missing", "Project does not have a primary workspace path.", { recoverable: true })
    return row.path
  }

  private nextInteger(table: string, column: string, scopeColumn: string, scopeId: string, initial = 1): number {
    const row = this.handle.sqlite.prepare(`SELECT MAX(${column}) AS value FROM ${table} WHERE ${scopeColumn} = ?`).get(scopeId) as { value: number | null }
    return row.value === null ? initial : row.value + 1
  }

  private insertGoalTransition(input: {
    flowId: string
    goalId: string
    turnId?: string
    routingRunId?: string
    fromStatus: string | null
    toStatus: string
    reason: string
    note?: string
    createdAt: string
  }): typeof v2GoalTransitions.$inferSelect {
    const id = createId("v2gtr")
    this.handle.db.insert(v2GoalTransitions).values({
      ...input,
      id,
      sequence: this.nextInteger("v2_goal_transitions", "sequence", "flow_id", input.flowId),
    }).run()
    const row = this.handle.db.select().from(v2GoalTransitions).where(eq(v2GoalTransitions.id, id)).get()
    if (!row) throw new SocratesError("v2_goal_transition_failed", "Flow goal transition could not be saved.")
    return row
  }

  private refreshCapsule(
    goalId: string,
    flowId: string,
    turnId: string,
    now: string,
    trigger: "turn_completed" | "parked" | "resumed" | "waiting" | "failed" | "cancelled" | "ledger_update",
  ): void {
    const previous = this.handle.db.select().from(v2GoalCapsules).where(eq(v2GoalCapsules.goalId, goalId)).orderBy(desc(v2GoalCapsules.version)).limit(1).get()
    const goal = this.handle.db.select().from(v2Goals).where(and(eq(v2Goals.id, goalId), eq(v2Goals.flowId, flowId))).limit(1).get()
    if (!goal) return
    const messages = this.handle.db.select().from(v2Messages).where(and(
      eq(v2Messages.goalId, goalId),
      inArray(v2Messages.role, ["user", "assistant"]),
    )).orderBy(desc(v2Messages.ordinal)).limit(24).all()
    const latestUser = messages.find((message) => message.role === "user")?.content
    const latestAssistant = messages.find((message) => message.role === "assistant")?.content
    const evidenceHandles = this.handle.db.select({ handle: v2EvidenceItems.handle }).from(v2EvidenceItems).where(eq(v2EvidenceItems.goalId, goalId)).orderBy(desc(v2EvidenceItems.createdAt)).limit(50).all().map((row) => row.handle)
    const turnOrdinal = this.handle.db.select({ ordinal: v2Turns.ordinal }).from(v2Turns).where(eq(v2Turns.id, turnId)).get()?.ordinal ?? 0
    const waitingTurn = this.handle.db.select({ waitingReason: v2Turns.waitingReason }).from(v2Turns).where(and(
      eq(v2Turns.goalId, goalId),
      eq(v2Turns.status, "waiting"),
    )).orderBy(desc(v2Turns.ordinal)).limit(1).get()
    const pendingApprovals = this.handle.db.select({ actionKind: v2Approvals.actionKind }).from(v2Approvals).where(and(
      eq(v2Approvals.goalId, goalId),
      eq(v2Approvals.status, "pending"),
    )).limit(10).all()
    const activeTerminals = this.handle.db.select({ name: v2TerminalSessions.name, status: v2TerminalSessions.status }).from(v2TerminalSessions).where(and(
      eq(v2TerminalSessions.goalId, goalId),
      inArray(v2TerminalSessions.status, [...ACTIVE_TERMINAL_STATUSES]),
    )).limit(10).all()
    const unresolved = this.handle.sqlite.prepare(
      `SELECT COALESCE(e.handle, ci.id) AS handle
       FROM v2_context_items ci
       LEFT JOIN v2_context_item_sources src ON src.context_item_id = ci.id
       LEFT JOIN v2_evidence_items e ON e.id = src.evidence_item_id
       JOIN v2_context_dispositions d ON d.id = (
         SELECT newest.id FROM v2_context_dispositions newest
         WHERE newest.context_item_id = ci.id
         ORDER BY newest.version DESC LIMIT 1
       )
       WHERE ci.goal_id = ? AND ci.state = 'active' AND d.disposition = 'unresolved'
       LIMIT 5`,
    ).all(goalId) as Array<{ handle: string }>
    const latestError = this.handle.db.select({ code: v2Errors.code, message: v2Errors.message }).from(v2Errors).where(eq(v2Errors.goalId, goalId)).orderBy(desc(v2Errors.createdAt)).limit(1).get()

    const decisions = uniqueStrings([
      ...parseJsonArray(previous?.decisionsJson ?? "[]"),
      ...extractCapsuleDecisions(latestUser ?? ""),
      ...extractCapsuleDecisions(latestAssistant ?? ""),
    ]).slice(-20)
    const openQuestions = uniqueStrings([
      ...(waitingTurn?.waitingReason ? [`Waiting: ${waitingTurn.waitingReason}`] : []),
      ...pendingApprovals.map((approval) => `Approval needed: ${approval.actionKind.replaceAll("_", " ")}`),
      ...unresolved.map((item) => `Review unresolved evidence: ${item.handle}`),
      ...((trigger === "failed" && latestError) ? [`Resolve ${latestError.code}: ${latestError.message}`] : []),
    ]).slice(0, 20)
    const nextActions = uniqueStrings([
      ...(waitingTurn?.waitingReason ? [`Resume when the Terminal wait completes: ${waitingTurn.waitingReason}`] : []),
      ...activeTerminals.map((terminal) => `Continue Terminal ${terminal.name} (${terminal.status}).`),
      ...pendingApprovals.map((approval) => `Resolve approval for ${approval.actionKind.replaceAll("_", " ")}.`),
      ...unresolved.map((item) => `Classify ${item.handle} as keep exact, distill, or release.`),
    ]).slice(0, 20)
    const state = [goal.status, trigger.replaceAll("_", " ")].join(" · ")
    const summary = buildCapsuleSummary({
      title: goal.title,
      objective: goal.summary ?? goal.title,
      ...(latestUser ? { latestRequest: latestUser } : {}),
      ...(latestAssistant ? { latestOutcome: latestAssistant } : {}),
      state,
      openLoopCount: openQuestions.length,
    })
    const previousHandles = parseJsonArray(previous?.evidenceHandlesJson ?? "[]")
    const materialTurn = !previous
      || previous.version === 1
      || turnOrdinal - previous.sourceThroughSequence >= 2
      || decisions.length > parseJsonArray(previous?.decisionsJson ?? "[]").length
      || openQuestions.length > 0
      || evidenceHandles.some((handle) => !previousHandles.includes(handle))
      || (latestAssistant?.length ?? 0) >= 600
    if (trigger === "turn_completed" && !materialTurn) return
    if (previous?.status === "active") this.handle.db.update(v2GoalCapsules).set({ status: "superseded" }).where(eq(v2GoalCapsules.id, previous.id)).run()
    this.handle.db.insert(v2GoalCapsules).values({
      id: createId("v2cap"), flowId, goalId, version: (previous?.version ?? 0) + 1, status: "active",
      summary,
      decisionsJson: JSON.stringify(decisions),
      openQuestionsJson: JSON.stringify(openQuestions),
      nextActionsJson: JSON.stringify(nextActions),
      evidenceHandlesJson: JSON.stringify(evidenceHandles),
      sourceThroughSequence: turnOrdinal,
      tokenEstimate: estimateTokens([summary, ...decisions, ...openQuestions, ...nextActions].join("\n")),
      createdByTurnId: turnId,
      createdAt: now,
    }).run()
  }

  private insertError(input: {
    projectId: string
    flowId: string
    goalId?: string
    turnId?: string
    source: string
    code: string
    message: string
    details?: unknown
    stack?: string
    recoverable: boolean
  }): V2Error {
    const id = createId("v2err")
    this.handle.db.insert(v2Errors).values({
      id, flowId: input.flowId, projectId: input.projectId, goalId: input.goalId, turnId: input.turnId,
      source: input.source, code: input.code, message: input.message, stack: input.stack,
      detailsJson: input.details === undefined ? undefined : JSON.stringify(input.details), recoverable: input.recoverable, createdAt: nowIso(),
    }).run()
    const row = this.handle.db.select().from(v2Errors).where(eq(v2Errors.id, id)).get()
    if (!row) throw new SocratesError("v2_error_persist_failed", "Flow error could not be saved.")
    return mapError(row)
  }
}

const ensureCompletionOutcomeVisible = (response: string, outcome: string): string => {
  const trimmedResponse = response.trim()
  const trimmedOutcome = outcome.trim()
  if (!trimmedOutcome) return response
  const outcomeTokens = completionContentTokens(trimmedOutcome)
  const responseTokens = new Set(completionContentTokens(trimmedResponse))
  const coveredTokens = outcomeTokens.filter((token) => responseTokens.has(token)).length
  if (outcomeTokens.length === 0 || coveredTokens / outcomeTokens.length >= 0.4) return response
  return [trimmedOutcome, trimmedResponse].filter(Boolean).join("\n\n")
}

const completionContentTokens = (value: string): string[] => [
  ...new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{4,}/gu) ?? [])
      .filter((token) => !COMPLETION_CONTENT_STOP_WORDS.has(token)),
  ),
]

const COMPLETION_CONTENT_STOP_WORDS = new Set([
  "after", "before", "completed", "completion", "current", "focus", "from", "have", "reported", "that", "the", "this", "with",
])

const mapFlow = (row: typeof v2Flows.$inferSelect): V2Flow => ({
  id: row.id,
  projectId: row.projectId,
  status: row.status as V2Flow["status"],
  ...(row.foregroundGoalId ? { foregroundGoalId: row.foregroundGoalId } : {}),
  revision: row.revision,
  lastEventSequence: row.lastEventSequence,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
})

const mapGoal = (row: typeof v2Goals.$inferSelect): V2Goal => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ordinal: row.ordinal,
  title: row.title,
  ...(row.summary ? { summary: row.summary } : {}),
  kind: row.kind as V2Goal["kind"],
  status: row.status as V2Goal["status"],
  origin: row.origin as V2Goal["origin"],
  priority: row.priority,
  pinned: row.pinned,
  lastActiveAt: row.lastActiveAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
})

const mapTransition = (row: typeof v2GoalTransitions.$inferSelect): V2GoalTransition => ({
  id: row.id,
  flowId: row.flowId,
  goalId: row.goalId,
  ...(row.turnId ? { turnId: row.turnId } : {}),
  ...(row.routingRunId ? { routingRunId: row.routingRunId } : {}),
  fromStatus: row.fromStatus as V2GoalTransition["fromStatus"],
  toStatus: row.toStatus as V2GoalTransition["toStatus"],
  reason: row.reason as V2GoalTransition["reason"],
  ...(row.note ? { note: row.note } : {}),
  sequence: row.sequence,
  createdAt: row.createdAt,
})

const mapRoutingRun = (row: typeof v2GoalRoutingRuns.$inferSelect): V2GoalRoutingRun => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  turnId: row.turnId,
  messageId: row.messageId,
  ...(row.foregroundGoalId ? { foregroundGoalId: row.foregroundGoalId } : {}),
  candidateGoalIds: parseJsonArray(row.candidateGoalIdsJson),
  ...(row.selectedGoalId ? { selectedGoalId: row.selectedGoalId } : {}),
  ...(row.decision ? { decision: row.decision as V2GoalRoutingRun["decision"] } : {}),
  ...(row.confidence === null ? {} : { confidence: row.confidence }),
  ...(row.rationale ? { rationale: row.rationale } : {}),
  ...(row.clarificationQuestion ? { clarificationQuestion: row.clarificationQuestion } : {}),
  clarificationCandidateGoalIds: parseJsonArray(row.clarificationCandidateGoalIdsJson),
  ...(row.clarificationAnswerMessageId ? { clarificationAnswerMessageId: row.clarificationAnswerMessageId } : {}),
  ...(row.providerId ? { providerId: row.providerId as V2GoalRoutingRun["providerId"] } : {}),
  ...(row.modelId ? { modelId: row.modelId } : {}),
  status: row.status as V2GoalRoutingRun["status"],
  ...(row.fallbackReason ? { fallbackReason: row.fallbackReason } : {}),
  startedAt: row.startedAt,
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
})

const mapCapsule = (row: typeof v2GoalCapsules.$inferSelect): V2GoalCapsule => ({
  id: row.id,
  flowId: row.flowId,
  goalId: row.goalId,
  version: row.version,
  status: row.status as V2GoalCapsule["status"],
  summary: row.summary,
  decisions: parseJsonArray(row.decisionsJson),
  openQuestions: parseJsonArray(row.openQuestionsJson),
  nextActions: parseJsonArray(row.nextActionsJson),
  evidenceHandles: parseJsonArray(row.evidenceHandlesJson),
  sourceThroughSequence: row.sourceThroughSequence,
  tokenEstimate: row.tokenEstimate,
  ...(row.createdByTurnId ? { createdByTurnId: row.createdByTurnId } : {}),
  createdAt: row.createdAt,
})

const mapAttachment = (row: typeof v2MessageAttachments.$inferSelect): V2MessageAttachment => ({
  id: row.id,
  projectId: row.projectId,
  flowId: row.flowId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  ...(row.messageId ? { messageId: row.messageId } : {}),
  artifactId: row.artifactId,
  kind: row.kind as V2MessageAttachment["kind"],
  fileName: row.fileName,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
  uri: row.uri,
  url: `/api/v2/projects/${encodeURIComponent(row.projectId)}/flows/${encodeURIComponent(row.flowId)}/attachments/${encodeURIComponent(row.id)}/content`,
  status: row.status as V2MessageAttachment["status"],
  createdAt: row.createdAt,
})

const mapMessage = (row: typeof v2Messages.$inferSelect, attachments?: V2MessageAttachment[]): V2Message => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  ordinal: row.ordinal,
  role: row.role as V2Message["role"],
  kind: row.kind as V2Message["kind"],
  content: row.content,
  ...(row.reasoning ? { reasoning: row.reasoning } : {}),
  status: row.status as V2Message["status"],
  ...(row.parentMessageId ? { parentMessageId: row.parentMessageId } : {}),
  ...(attachments && attachments.length > 0 ? { attachments } : {}),
  createdAt: row.createdAt,
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
})

const mapTurn = (row: typeof v2Turns.$inferSelect): V2Turn => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ordinal: row.ordinal,
  ...(row.userMessageId ? { userMessageId: row.userMessageId } : {}),
  ...(row.assistantMessageId ? { assistantMessageId: row.assistantMessageId } : {}),
  status: row.status as V2Turn["status"],
  ...(row.waitingReason ? { waitingReason: row.waitingReason } : {}),
  ...(row.errorId ? { errorId: row.errorId } : {}),
  startedAt: row.startedAt,
  updatedAt: row.updatedAt,
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  ...(row.failedAt ? { failedAt: row.failedAt } : {}),
  ...(row.cancelledAt ? { cancelledAt: row.cancelledAt } : {}),
})

const mapRuntimeEvent = (row: typeof v2RuntimeEvents.$inferSelect): V2RuntimeEvent => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  sequence: row.sequence,
  type: row.type,
  source: row.source,
  payload: parseJson(row.payloadJson),
  createdAt: row.createdAt,
})

const mapModelCall = (row: typeof v2ModelCalls.$inferSelect): V2ModelCall => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  role: row.role as V2ModelCall["role"],
  providerId: row.providerId as V2ModelCall["providerId"],
  modelId: row.modelId,
  status: row.status as V2ModelCall["status"],
  ...(row.errorId ? { errorId: row.errorId } : {}),
  startedAt: row.startedAt,
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
})

const mapUsage = (row: typeof v2UsageEvents.$inferSelect): V2UsageEvent => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  modelCallId: row.modelCallId,
  providerId: row.providerId as V2UsageEvent["providerId"],
  modelId: row.modelId,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  reasoningTokens: row.reasoningTokens,
  cachedInputTokens: row.cachedInputTokens,
  totalTokens: row.totalTokens,
  ...(row.costUsd === null ? {} : { costUsd: row.costUsd }),
  createdAt: row.createdAt,
})

const mapToolCall = (row: typeof v2ToolCalls.$inferSelect): V2ToolCall => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  turnId: row.turnId,
  ...(row.modelCallId ? { modelCallId: row.modelCallId } : {}),
  toolName: row.toolName,
  status: row.status as V2ToolCall["status"],
  arguments: parseJson(row.argumentsJson),
  ...(row.resultJson ? { result: parseJson(row.resultJson) } : {}),
  requiresApproval: row.requiresApproval,
  ...(row.approvalId ? { approvalId: row.approvalId } : {}),
  ...(row.errorId ? { errorId: row.errorId } : {}),
  ...(row.startedAt ? { startedAt: row.startedAt } : {}),
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
})

const mapApproval = (row: typeof v2Approvals.$inferSelect): V2Approval => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  turnId: row.turnId,
  ...(row.toolCallId ? { toolCallId: row.toolCallId } : {}),
  status: row.status as V2Approval["status"],
  actionKind: row.actionKind,
  action: parseJson(row.actionJson),
  ...(row.decision ? { decision: row.decision as NonNullable<V2Approval["decision"]> } : {}),
  ...(row.reason ? { reason: row.reason } : {}),
  requestedAt: row.requestedAt,
  ...(row.decidedAt ? { decidedAt: row.decidedAt } : {}),
})

const mapFeedback = (row: typeof v2Feedback.$inferSelect): V2Feedback => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  messageId: row.messageId,
  ...(row.modelCallId ? { modelCallId: row.modelCallId } : {}),
  rating: row.rating as V2Feedback["rating"],
  ...(row.reasonCode ? { reasonCode: row.reasonCode } : {}),
  ...(row.note ? { note: row.note } : {}),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const mapCredentialRequest = (row: typeof v2CredentialInputRequests.$inferSelect): V2CredentialInputRequest => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  turnId: row.turnId,
  toolCallId: row.toolCallId,
  ...(row.providerToolCallId ? { providerToolCallId: row.providerToolCallId } : {}),
  serverId: row.serverId,
  ...(row.serverLabel ? { serverLabel: row.serverLabel } : {}),
  envKey: row.envKey,
  source: row.source as V2CredentialInputRequest["source"],
  status: row.status as V2CredentialInputRequest["status"],
  requestedAt: row.requestedAt,
  ...(row.resolvedAt ? { resolvedAt: row.resolvedAt } : {}),
})

const mapEvidence = (row: typeof v2EvidenceItems.$inferSelect): V2EvidenceItem => ({
  id: row.id,
  handle: row.handle,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  sourceKind: row.sourceKind as V2EvidenceItem["sourceKind"],
  ...(row.sourceId ? { sourceId: row.sourceId } : {}),
  ...(row.sourceUri ? { sourceUri: row.sourceUri } : {}),
  title: row.title,
  ...(row.mimeType ? { mimeType: row.mimeType } : {}),
  ...(row.content === null ? {} : { content: row.content }),
  contentHash: row.contentHash,
  ...(row.sizeBytes === null ? {} : { sizeBytes: row.sizeBytes }),
  ...(row.tokenEstimate === null ? {} : { tokenEstimate: row.tokenEstimate }),
  ...(row.locatorJson ? { locator: parseJson(row.locatorJson) } : {}),
  createdAt: row.createdAt,
})

const mapCoreEvidence = (row: typeof v2EvidenceItems.$inferSelect): ImmutableEvidenceRecord => ({
  ref: {
    evidenceId: row.id,
    flowId: row.flowId,
    sourceType: row.sourceKind,
    sourceLocator: row.handle,
    contentHash: row.contentHash,
    capturedAt: row.createdAt,
  },
  exactContent: row.content ?? "",
  ...(row.metadataJson ? { metadata: parseJsonObject(row.metadataJson) } : {}),
})

const mapContextItem = (row: typeof v2ContextItems.$inferSelect): V2ContextItem => ({
  id: row.id,
  flowId: row.flowId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  kind: row.kind as V2ContextItem["kind"],
  state: row.state as V2ContextItem["state"],
  content: row.content,
  tokenEstimate: row.tokenEstimate,
  rank: row.rank,
  activeFromTurnOrdinal: row.activeFromTurnOrdinal,
  ...(row.releasedAtTurnOrdinal === null ? {} : { releasedAtTurnOrdinal: row.releasedAtTurnOrdinal }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

const mapDisposition = (row: typeof v2ContextDispositions.$inferSelect): V2ContextDisposition => ({
  id: row.id,
  flowId: row.flowId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  turnId: row.turnId,
  contextItemId: row.contextItemId,
  version: row.version,
  disposition: row.disposition as V2ContextDisposition["disposition"],
  reason: row.reason,
  decidedBy: row.decidedBy as V2ContextDisposition["decidedBy"],
  ...(row.unresolvedAgeTurns === null ? {} : { unresolvedAgeTurns: row.unresolvedAgeTurns }),
  ...(row.unresolvedMaxAgeTurns === null ? {} : { unresolvedMaxAgeTurns: row.unresolvedMaxAgeTurns }),
  ...(row.distillationInstruction ? { distillationInstruction: row.distillationInstruction } : {}),
  ...(row.replacementContextItemId ? { replacementContextItemId: row.replacementContextItemId } : {}),
  createdAt: row.createdAt,
})

const mapTerminal = (row: typeof v2TerminalSessions.$inferSelect): V2Terminal => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  name: row.name,
  command: row.command,
  cwd: row.cwd,
  status: row.status as V2Terminal["status"],
  awaitingInput: row.awaitingInput,
  stateVersion: row.stateVersion,
  ...(row.exitCode === null ? {} : { exitCode: row.exitCode }),
  startedAt: row.startedAt,
  updatedAt: row.updatedAt,
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
})

const mapTerminalRuntimeRecord = (row: typeof v2TerminalSessions.$inferSelect): V2TerminalRuntimeRecord => {
  const metadata = parseJsonObject(row.metadataJson)
  const inputMode = metadata.inputMode === "user" ? "user" as const : "none" as const
  return {
    terminal: mapTerminal(row),
    workspacePath: row.workspacePath,
    ...(row.processId ? { processId: row.processId } : {}),
    ...(row.platform ? { platform: row.platform } : {}),
    ...(row.shellKind ? { shellKind: row.shellKind } : {}),
    ...(row.shellExecutable ? { shellExecutable: row.shellExecutable } : {}),
    ...(row.signal ? { signal: row.signal } : {}),
    autoDetached: row.autoDetached,
    ...(row.lastPrompt ? { lastPrompt: row.lastPrompt } : {}),
    supervisorOutputSequence: nonNegativeNumber(metadata.supervisorOutputSequence),
    modelVisibleOutputSequence: nonNegativeNumber(metadata.modelVisibleOutputSequence),
    inputMode,
    metadata,
  }
}

const wakeEventForV2Terminal = (row: typeof v2TerminalSessions.$inferSelect): TerminalWaitWakeOn | undefined => {
  if (row.status === "awaiting_input" || row.awaitingInput) return "input_required"
  if (row.status === "exited") return row.exitCode === 0 ? "completed" : "failed"
  if (["stopped", "detached", "stale", "missing"].includes(row.status)) return "failed"
  return undefined
}

const mapArtifact = (row: typeof v2Artifacts.$inferSelect): V2Artifact => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  kind: row.kind,
  ...(row.path ? { path: row.path } : {}),
  ...(row.uri ? { uri: row.uri } : {}),
  ...(row.contentHash ? { contentHash: row.contentHash } : {}),
  ...(row.mimeType ? { mimeType: row.mimeType } : {}),
  ...(row.sizeBytes === null ? {} : { sizeBytes: row.sizeBytes }),
  createdAt: row.createdAt,
})

const mapSpeechJob = (row: typeof v2SpeechJobs.$inferSelect): V2SpeechJob => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  ...(row.messageId ? { messageId: row.messageId } : {}),
  kind: row.kind,
  engine: row.engine,
  modelId: row.modelId,
  status: row.status,
  ...(row.inputArtifactId ? { inputArtifactId: row.inputArtifactId } : {}),
  ...(row.inputText ? { inputText: row.inputText } : {}),
  ...(row.outputArtifactId ? { outputArtifactId: row.outputArtifactId } : {}),
  ...(row.transcriptText ? { transcriptText: row.transcriptText } : {}),
  ...(row.voiceId ? { voiceId: row.voiceId } : {}),
  ...(row.speed === null ? {} : { speed: row.speed }),
  ...(row.language ? { language: row.language } : {}),
  ...(row.durationMs === null ? {} : { durationMs: row.durationMs }),
  ...(row.errorId ? { errorId: row.errorId } : {}),
  ...(row.startedAt ? { startedAt: row.startedAt } : {}),
  ...(row.completedAt ? { completedAt: row.completedAt } : {}),
  createdAt: row.createdAt,
} as V2SpeechJob)

const mapError = (row: typeof v2Errors.$inferSelect): V2Error => ({
  id: row.id,
  flowId: row.flowId,
  projectId: row.projectId,
  ...(row.goalId ? { goalId: row.goalId } : {}),
  ...(row.turnId ? { turnId: row.turnId } : {}),
  source: row.source,
  code: row.code,
  message: row.message,
  recoverable: row.recoverable,
  ...(row.detailsJson ? { details: parseJson(row.detailsJson) } : {}),
  createdAt: row.createdAt,
})

const formatV2AttachmentReference = (
  attachments: Array<{ kind: string; fileName: string; uri: string; mimeType: string; sizeBytes: number }>,
): string =>
  [
    "Conversation attachments are stored in the workspace. Before answering from an attached text file, inspect it with read or search instead of guessing. For an Agent Skill ZIP, use skills preview_import with the exact attachmentPath below; do not read or unzip it with generic tools:",
    ...attachments.map(
      (attachment) =>
        `- ${attachment.kind} ${attachment.fileName}: ${v2AttachmentReferencePath(attachment.uri)} (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`,
    ),
  ].join("\n")

const v2AttachmentReferencePath = (uri: string): string => {
  const normalized = uri.split(path.sep).join("/")
  const marker = "/.socrates/"
  const markerIndex = normalized.indexOf(marker)
  return markerIndex >= 0 ? normalized.slice(markerIndex + 1) : path.basename(uri)
}

const normalizeV2AttachmentReference = (value: string): string => {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "")
  const marker = "/.socrates/"
  const markerIndex = normalized.indexOf(marker)
  return markerIndex >= 0 ? normalized.slice(markerIndex + 1) : normalized.replace(/^\/+/, "")
}

const truncateInline = (value: string, maxLength: number): string => {
  const normalized = value.trim().replace(/\s+/g, " ")
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`
}

const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/svg+xml"])
const textMimeTypes = new Set(["text/plain"])
const zipMimeTypes = new Set(["application/zip", "application/x-zip-compressed"])

const attachmentKind = (mimeType: string): "image" | "text" | "skill_zip" | undefined =>
  imageMimeTypes.has(mimeType) ? "image" : textMimeTypes.has(mimeType) ? "text" : zipMimeTypes.has(mimeType) ? "skill_zip" : undefined

const normalizeMimeType = (mimeType: string | undefined, fileName: string): string => {
  if (mimeType && mimeType !== "application/octet-stream") return mimeType.toLowerCase()
  const lower = fileName.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".heic")) return "image/heic"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) return "text/plain"
  if (lower.endsWith(".zip")) return "application/zip"
  return mimeType?.toLowerCase() ?? "application/octet-stream"
}

const validateAttachmentBatch = (inputs: UploadedFile[]): void => {
  if (inputs.length === 0) throw new SocratesError("attachment_file_required", "Choose at least one Flow attachment.", { recoverable: true })
  if (inputs.length > MAX_MESSAGE_ATTACHMENTS) throw new SocratesError("attachment_upload_limit_exceeded", `Attach up to ${MAX_MESSAGE_ATTACHMENTS} files to one message.`, { recoverable: true })
  const total = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
  if (total > MAX_MESSAGE_ATTACHMENT_BYTES) throw new SocratesError("attachment_total_too_large", "Attachments for one message must be 20 MB or smaller in total.", { recoverable: true })
}

const validateAttachmentSize = (kind: "image" | "text" | "skill_zip", input: UploadedFile): void => {
  const max = kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : kind === "skill_zip" ? MAX_SKILL_ZIP_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES
  if (input.data.byteLength > max) throw new SocratesError("attachment_too_large", "This Flow attachment exceeds the allowed size.", {
    details: { fileName: input.originalName, sizeBytes: input.data.byteLength, maxAttachmentBytes: max }, recoverable: true,
  })
}

const routingDecisionContract = (decision: V2GoalRoutingDecision): V2GoalRoutingRun["decision"] =>
  decision.action === "continue" ? "continue_foreground" : decision.action === "resume" ? "resume_parked" : "create_goal"

const deriveGoalTitle = (content: string): string => {
  const normalized = content.trim().replace(/\s+/g, " ")
  if (!normalized) return "New goal"
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77).trimEnd()}…`
}

const buildCapsuleSummary = (input: {
  title: string
  objective: string
  latestRequest?: string
  latestOutcome?: string
  state: string
  openLoopCount?: number
}): string => [
  `Goal: ${truncateInline(input.title, 500)}`,
  `Objective: ${truncateInline(input.objective, 2_000)}`,
  ...(input.latestRequest ? [`Latest request: ${truncateInline(input.latestRequest, 4_000)}`] : []),
  ...(input.latestOutcome ? [`Latest outcome: ${truncateInline(input.latestOutcome, 4_000)}`] : []),
  `State: ${truncateInline(input.state, 500)}`,
  ...((input.openLoopCount ?? 0) > 0 ? [`Open loops: ${input.openLoopCount}`] : []),
].join("\n")

const capsuleSentences = (content: string): string[] => content
  .split(/(?<=[.!?])\s+|\n+/)
  .map((value) => truncateInline(value, 1_000))
  .filter(Boolean)

const extractCapsuleDecisions = (content: string): string[] => uniqueStrings(
  capsuleSentences(content).filter((sentence) =>
    /\b(must|should|shall|never|always|do not|don't|decid(?:e|ed)|agree(?:d)?|constraint|require(?:d|ment)?|will use|keep|separate|only)\b/i.test(sentence),
  ),
).slice(0, 12)

const extractQuestions = (content: string): string[] => uniqueStrings(
  capsuleSentences(content).filter((sentence) => sentence.endsWith("?")),
).slice(0, 10)

const estimateTokens = (content: string): number => Math.max(1, Math.ceil(content.length / 4))
const nonNegative = (value: number | undefined): number => Math.max(0, Math.floor(Number.isFinite(value) ? value ?? 0 : 0))
const uniqueStrings = (values: readonly string[]): string[] => [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))]

const parseJson = (value: string): unknown => {
  try { return JSON.parse(value) as unknown } catch { return null }
}

const parseJsonArray = (value: string): string[] => {
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
}

const parseStringArray = (value: string | null | undefined): string[] => {
  if (!value) return []
  const parsed = parseJson(value)
  return Array.isArray(parsed) ? uniqueStrings(parsed.filter((item): item is string => typeof item === "string")) : []
}

const parseV2TaskWait = (value: unknown): { terminalNames: string[]; wakeOn: TerminalWaitWakeOn[]; reason: string } | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const terminalNames = Array.isArray(record.terminalNames)
    ? uniqueStrings(record.terminalNames.filter((item): item is string => typeof item === "string"))
    : []
  const wakeOn: TerminalWaitWakeOn[] = Array.isArray(record.wakeOn)
    ? [...new Set(record.wakeOn.filter((item): item is TerminalWaitWakeOn => item === "completed" || item === "failed" || item === "input_required"))]
    : []
  if (terminalNames.length === 0 || wakeOn.length === 0 || typeof record.reason !== "string" || !record.reason.trim()) return undefined
  return { terminalNames, wakeOn, reason: record.reason }
}

const parseV2TaskReady = (value: unknown): { terminalId: string; wakeEvent: TerminalWaitWakeOn; reason: string } | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.terminalId !== "string" || typeof record.reason !== "string") return undefined
  if (record.wakeEvent !== "completed" && record.wakeEvent !== "failed" && record.wakeEvent !== "input_required") return undefined
  return { terminalId: record.terminalId, wakeEvent: record.wakeEvent, reason: record.reason }
}

const parseJsonObject = (value: string | null | undefined): Record<string, unknown> => {
  if (!value) return {}
  const parsed = parseJson(value)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

const nonNegativeNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0

const insertV2RuntimeConfig = (
  handle: DatabaseHandle,
  id: string,
  turnId: string,
  flowId: string,
  runtimeConfig: V2RuntimeConfig,
  createdAt: string,
): void => {
  handle.db.insert(v2TurnRuntimeConfigs).values({
    id,
    turnId,
    flowId,
    providerId: runtimeConfig.providerId,
    authMode: runtimeConfig.authMode ?? "api_key",
    modelId: runtimeConfig.modelId,
    thinkingEnabled: runtimeConfig.thinkingEnabled,
    thinkingEffort: runtimeConfig.thinkingEffort,
    approvalMode: runtimeConfig.approvalMode,
    sandboxMode: runtimeConfig.sandboxMode,
    contextWindowTokens: runtimeConfig.contextWindowTokens,
    createdAt,
  }).run()
}

const latestDispositionRows = (rows: Array<typeof v2ContextDispositions.$inferSelect>): Map<string, typeof v2ContextDispositions.$inferSelect> => {
  const latest = new Map<string, typeof v2ContextDispositions.$inferSelect>()
  for (const row of rows) if (!latest.has(row.contextItemId)) latest.set(row.contextItemId, row)
  return latest
}

const normalizeUnknownError = (error: unknown): {
  code: string
  message: string
  details?: unknown
  recoverable: boolean
  stack?: string
} => {
  if (error instanceof SocratesError) return {
    code: error.code,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
    recoverable: error.recoverable,
    ...(error.stack ? { stack: error.stack } : {}),
  }
  if (error instanceof Error) return { code: "v2_turn_failed", message: error.message, recoverable: true, ...(error.stack ? { stack: error.stack } : {}) }
  return { code: "v2_turn_failed", message: String(error), recoverable: true }
}
