import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  Notification,
  ConversationToolRun,
  EditFilesToolInput,
  EditFilesToolOutput,
  MemoryAgentGlobalSettings,
  MemoryAgentGlobalState,
  MemoryAgentFileContentQuery,
  MemoryAgentFileSummary,
  MemoryAgentRunDetail,
  MemoryAgentSignalSnapshot,
  MemoryAgentTimelineItem,
  MemoryNoteToolInput,
  MemoryNoteToolOutput,
  MemoryNotesToolInput,
  MemoryNotesToolOutput,
  MemoryDocIndex,
  MemoryDocSection,
  ProjectDocsArea,
  ProjectDocsToolInput,
  ProjectDocsToolOutput,
  ProjectsToolInput,
  ProjectsToolOutput,
  RepoDocsToolInput,
  RepoDocsToolOutput,
  SkillScope,
  SkillSummary,
  SkillWriteToolInput,
  SkillWriteToolOutput,
  SkillsToolInput,
  SkillsToolOutput,
  SoulToolInput,
  SoulToolOutput,
  ToolDocsToolInput,
  ToolDocsToolOutput,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
  TriggerMemoryAgentRunResponse,
  TruncationMetadata,
  UserProfileToolInput,
  UserProfileToolOutput,
  WorkerModelRole,
  WorkerModelSettings,
} from "@socrates/contracts"
import { memoryDocRequiredSections } from "@socrates/contracts"
import type { ModelProvider, ProviderCredentialResolver } from "@socrates/providers"
import { estimateTextTokens } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, desc, eq, or } from "drizzle-orm"
import {
  conversations,
  errors,
  memoryAgentChecks,
  events,
  memoryAgentActions,
  memoryAgentConfirmations,
  memoryDocIndexes,
  memoryDocSections,
  memoryAgentJobs,
  memoryNotes,
  messages,
  projectResources,
  projects,
  projectWorkspaces,
  skillWriterJobs,
  turns,
} from "../../db/schema"
import { hashText, simpleDiff, validateMemoryPatch, type MemoryPatchProposal } from "./memoryAgentOutput"
import { runMemoryAgentTurn, type MemoryAgentModelSettings } from "./memoryAgentRunner"
import { runSkillWriterTurn, type SkillWriterModelSettings } from "./skillWriterAgentRunner"
import { emptyMemoryAgentSignal, scoreMemoryAgentSignal } from "./memoryAgentSignals"
import { emptyMemoryAgentSummary, parseMemoryAgentSummarySections } from "./memoryAgentSummary"
import {
  discoverSkills,
  fallbackSkillMarkdown,
  parseSkillMarkdown,
  readSkillInfo,
  skillSummary,
  slugSkillName,
  isValidSkillName,
  uniqueSkillName,
  type SkillInfo,
} from "./memorySkills"
import {
  ensureStructuredMemoryDoc,
  memoryDocTypeForEditFilesTarget,
  memoryDocTypeForRepoDoc,
  parseMemoryDoc,
  patchMemoryDocSection,
  stampMemoryDocFrontmatter,
  type MemoryDocProfile,
} from "./memoryDocParser"
import { StoreBase } from "./shared"
import { firstMarkdownLine, ToolDocsStore } from "./toolDocsStore"
import type { FailedToolEventForLedger } from "./eventStore"
import { inspectWorkspaceEnvironment } from "@socrates/workspace"
import { currentRuntimeTime } from "./runtimeContext"

const DEFAULT_CHAR_LIMIT = 20_000
const PRIMARY_MEMORY_FULL_READ_CHAR_LIMIT = 8_000
const PRIMARY_MEMORY_INDEX_CHAR_LIMIT = 10_000
const PRIMARY_MEMORY_SECTION_CHAR_LIMIT = 10_000
const DEFAULT_SEARCH_LIMIT = 20
const MEMORY_AGENT_TOKEN_CAP = 60_000
const GLOBAL_MEMORY_AGENT_PROJECT_ID = "global"
const GLOBAL_MEMORY_AGENT_MAX_TURNS = 80
const SKILL_CHAR_LIMIT = 20_000
const STATE_LEDGER_START = "<!-- socrates-state-ledger:start -->"
const STATE_LEDGER_END = "<!-- socrates-state-ledger:end -->"
const INTERNAL_BUILTIN_SKILL_NAMES = new Set(["socrates-skill-writer"])
const SOUL_CONFIRMATION_PROMPT = "You are about to make changes to the soul. Are you sure?\nReply exactly yes or no."
const REPO_DOC_NAMES = ["CORE_IDEA.md", "REPO_NAVIGATION.md", "REPO_RULES.md", "CONTRACTS.md"] as const
const LEGACY_REPO_DOC_NAMES = ["APP_FLOW.md", "DB_STRUCTURE.md", "FRONTEND_BACKEND_CONTRACT.md", "PROVIDER_USAGE.md", "REPO_STRCUTURE.md"] as const
const PROJECT_NOTES_RUNTIME_CONTEXT_SECTION = "runtime_context"

type MemoryStoreOptions = {
  socratesHome?: string
  provider?: ModelProvider
  credentials?: ProviderCredentialResolver
  traceRetrieve?: (projectId: string, conversationId: string, input: TraceRetrieveToolInput) => Promise<TraceRetrieveToolOutput> | TraceRetrieveToolOutput
  traceRetrieveGlobal?: (input: TraceRetrieveToolInput) => Promise<TraceRetrieveToolOutput> | TraceRetrieveToolOutput
  getMemoryAgentGlobalSettings?: () => MemoryAgentGlobalSettings
  getWorkerModelSettings?: (workerId: WorkerModelRole) => WorkerModelSettings
  createNotification?: (input: {
    projectId?: string
    conversationId?: string
    turnId?: string
    type: string
    title: string
    body?: string
    severity?: Notification["severity"]
    payload?: unknown
  }) => Notification
}

type MemoryAgentStatePatch = Partial<Omit<MemoryAgentGlobalState, "id" | "updatedAt" | "lastCheckedAt" | "lastRealRunAt" | "activeJobId" | "lastJobId" | "error">> & {
  lastCheckedAt?: string | null
  lastRealRunAt?: string | null
  activeJobId?: string | null
  lastJobId?: string | null
  error?: string | null
}

type GlobalMemoryAgentRunInput = {
  trigger: "scheduled" | "manual"
  settings: MemoryAgentGlobalSettings
  state: MemoryAgentGlobalState
  updateState: (input: MemoryAgentStatePatch) => MemoryAgentGlobalState
}

type GlobalTurnManifestRow = {
  sequence: number
  projectId: string
  projectName: string
  conversationId: string
  conversationTitle: string | null
  sessionId: string
  turnId: string
  createdAt: string
  workspacePath: string | null
}

type GlobalTurnManifestEntry = GlobalTurnManifestRow & {
  counts: {
    messages: number
    toolCalls: number
    failedToolCalls: number
    fileOperations: number
    patches: number
    shellCommands: number
    errors: number
  }
}

type WritableSkillScope = Extract<SkillScope, "global" | "project">

type ResolvedEditFilesTarget = {
  path: string
  targetKind: "skills" | "soul" | "user_profile"
  document?: "identity"
  scope?: WritableSkillScope
  projectId?: string
  projectName?: string
  workspacePath?: string
}

type ApprovedSkillWriterTask = {
  scope: WritableSkillScope
  operation: "create" | "update"
  name: string
  request: string
  projectId: string
  workspacePath?: string
  conversationId?: string
  sessionId?: string
  turnId?: string
  sourceKind: "dashboard" | "memory_agent_action"
  sourceId?: string
}

const scopedIds = (input: { conversationId?: string; sessionId?: string; turnId?: string }) => ({
  ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  ...(input.turnId ? { turnId: input.turnId } : {}),
})

export class MemoryStore extends StoreBase {
  private readonly socratesHome: string
  private globalMemoryRunActive = false

  constructor(context: ConstructorParameters<typeof StoreBase>[0], private readonly options: MemoryStoreOptions = {}) {
    super(context)
    this.socratesHome = options.socratesHome ?? path.join(os.homedir(), ".Socrates")
  }

  ensureProjectMemory(projectId: string, workspacePath?: string): void {
    this.ensureGlobalKnowledge()
    if (workspacePath) {
      this.migrateLegacyProjectMemory(projectId, workspacePath)
      ensureStructuredMemoryDoc(projectDocPath(workspacePath, "memory"), projectDocProfile(projectId, "memory"))
      ensureStructuredMemoryDoc(projectDocPath(workspacePath, "notes"), projectDocProfile(projectId, "notes"))
      fs.mkdirSync(path.join(workspacePath, ".socrates", "skills"), { recursive: true })
      ensureBundledRepoDocs(path.join(workspacePath, ".socrates", "repo_docs"))
      removeLegacyRepoDocs(path.join(workspacePath, ".socrates", "repo_docs"))
      for (const name of REPO_DOC_NAMES) {
        const profile = repoDocProfile(projectId, name)
        ensureStructuredMemoryDoc(repoDocPath(repoDocsRoot(workspacePath), name), profile)
        this.indexMemoryDocFile(repoDocPath(repoDocsRoot(workspacePath), name), profile)
      }
      this.indexMemoryDocFile(projectDocPath(workspacePath, "memory"), projectDocProfile(projectId, "memory"))
      this.indexMemoryDocFile(projectDocPath(workspacePath, "notes"), projectDocProfile(projectId, "notes"))
    }
  }

  private ensureGlobalKnowledge(): void {
    migrateGlobalPrimaryFiles(this.socratesHome)
    migrateIdentityUserSectionsToProfile(this.socratesHome)
    removeRetiredOperatingPrinciplesFiles(this.socratesHome)
    ensureBundledToolUsageDocs(path.join(this.socratesHome, "tool_usage"))
    removeLegacyToolUsageDocs(path.join(this.socratesHome, "tool_usage"))
    this.ensureAndIndexGlobalDocs()
    fs.mkdirSync(path.join(this.socratesHome, "skills"), { recursive: true })
    migrateUsefulPatternsToSkills(this.socratesHome)
  }

  private migrateLegacyProjectMemory(projectId: string, workspacePath: string): void {
    const targetPath = path.join(workspacePath, ".socrates", "MEMORY.md")
    if (fs.existsSync(targetPath)) {
      removeLegacyProjectRoot(this.projectRoot(projectId))
      return
    }
    const legacyRoot = this.projectRoot(projectId)
    const sections: string[] = []
    const projectBrief = readIfExists(path.join(legacyRoot, "project_brief.md"))
    const projectMemory = readIfExists(path.join(legacyRoot, "MEMORY.md"))
    const diaryEntries = listMarkdownFiles(path.join(legacyRoot, "diary"))
      .sort()
      .map((filePath) => [`Diary ${path.basename(filePath, ".md")}`, readIfExists(filePath)] as const)
      .filter(([, content]) => Boolean(content?.trim()))
    if (projectMemory?.trim()) {
      sections.push(`## Migrated Project Memory\n\n${projectMemory.trim()}`)
    }
    if (projectBrief?.trim()) {
      sections.push(`## Migrated Project Brief\n\n${projectBrief.trim()}`)
    }
    for (const [label, content] of diaryEntries) {
      sections.push(`## Migrated ${label}\n\n${content?.trim()}`)
    }
    if (sections.length > 0) {
      ensureFile(targetPath, `# Project Memory\n\n${sections.join("\n\n")}\n`)
    }
    removeLegacyProjectRoot(legacyRoot)
  }

  private ensureAndIndexGlobalDocs(): void {
    const globalDocs = [
      globalMemoryDocProfile(this.socratesHome, "identity"),
      globalMemoryDocProfile(this.socratesHome, "user_profile"),
    ]
    for (const profile of globalDocs) {
      ensureStructuredMemoryDoc(path.join(this.socratesHome, profile.path), profile)
      this.indexMemoryDocFile(path.join(this.socratesHome, profile.path), profile)
    }
    for (const filePath of listMarkdownFiles(path.join(this.socratesHome, "tool_usage"))) {
      const relativePath = path.relative(this.socratesHome, filePath).replaceAll(path.sep, "/")
      this.indexMemoryDocFile(filePath, globalToolDocProfile(relativePath))
    }
  }

  runToolDocsTool(projectId: string, workspacePath: string | undefined, input: ToolDocsToolInput, audience: "main" | "memory_agent" = "main"): ToolDocsToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    return new ToolDocsStore(this.socratesHome, audience).run(input)
  }

  runSkillsTool(projectId: string, workspacePath: string | undefined, input: SkillsToolInput): SkillsToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    if (input.operation === "read" || input.operation === "describe") {
      return this.readSkill(input, workspacePath)
    }
    if (input.operation === "search") {
      return this.searchSkills(input, workspacePath)
    }
    return this.listSkillsOutput(input, workspacePath)
  }

  createMemoryNote(input: MemoryNoteToolInput, source: { projectId: string; conversationId: string; sessionId: string; turnId: string }): MemoryNoteToolOutput {
    this.ensureGlobalKnowledge()
    const note = input.note.trim()
    const normalizedNoteKey = normalizedMemoryNoteKey(note)
    const defaultSkillScope: SkillScope = "project"
    const result = this.handle.sqlite.transaction(() => {
      const duplicate = this.handle.db
        .select()
        .from(memoryNotes)
        .where(and(eq(memoryNotes.createdByAgent, "socrates"), eq(memoryNotes.normalizedNoteKey, normalizedNoteKey)))
        .orderBy(memoryNotes.noteNumber)
        .limit(1)
        .get()
      if (duplicate) {
        return {
          output: {
            noteNumber: duplicate.noteNumber,
            status: duplicate.status === "done" ? ("done" as const) : duplicate.status === "processing" ? ("processing" as const) : ("open" as const),
            attachedSource: "current_user_message" as const,
            result: "already_recorded" as const,
          },
          deduplicatedEvent: {
            projectId: source.projectId,
            conversationId: source.conversationId,
            sessionId: source.sessionId,
            turnId: source.turnId,
            type: "memory.note.deduplicated",
            source: "server",
            payload: { noteNumber: duplicate.noteNumber, normalizedNoteKey, defaultSkillScope },
          } as const,
        }
      }

      const turnCount = this.memoryNoteCountForTurn(source.turnId)
      if (turnCount >= MEMORY_NOTES_PER_TURN_LIMIT) {
        throw new SocratesError("memory_note_turn_limit_reached", "This turn already created two distinct memory notes. Merge new memory candidates into an existing note or skip the weaker candidate.", {
          recoverable: true,
          details: { turnId: source.turnId, limit: MEMORY_NOTES_PER_TURN_LIMIT },
        })
      }

      const turn = this.handle.db.select().from(turns).where(eq(turns.id, source.turnId)).get()
      const userMessageId = turn?.userMessageId
      const userMessage = userMessageId ? this.handle.db.select().from(messages).where(eq(messages.id, userMessageId)).get() : undefined
      const sourceProject = this.handle.db.select().from(projects).where(eq(projects.id, source.projectId)).limit(1).get()
      const sourceWorkspace = this.handle.db
        .select()
        .from(projectWorkspaces)
        .where(and(eq(projectWorkspaces.projectId, source.projectId), eq(projectWorkspaces.isPrimary, true)))
        .limit(1)
        .get()
      const now = nowIso()
      const nextNumberRow = this.handle.sqlite.prepare("SELECT COALESCE(MAX(note_number), 0) + 1 AS nextNumber FROM memory_notes").get() as { nextNumber: number }
      const noteNumber = nextNumberRow.nextNumber
      const importance = input.importance ?? "normal"
      this.handle.db
        .insert(memoryNotes)
        .values({
          id: createId("memnote"),
          noteNumber,
          status: "open",
          priority: importance,
          intent: "review_current_turn",
          note,
          normalizedNoteKey,
          projectId: source.projectId,
          conversationId: source.conversationId,
          sessionId: source.sessionId,
          turnId: source.turnId,
          messageId: userMessageId,
          messageExcerpt: userMessage?.content ? truncateInline(userMessage.content, 600) : undefined,
          createdByAgent: "socrates",
          createdAt: now,
          metadataJson: JSON.stringify({
            attachedSource: "current_user_message",
            defaultSkillScope,
            ...(sourceProject?.name ? { projectName: sourceProject.name } : {}),
            ...(sourceWorkspace?.path ? { workspacePath: sourceWorkspace.path } : {}),
          }),
        })
        .run()
      return {
        output: { noteNumber, status: "open" as const, attachedSource: "current_user_message" as const, result: "created" as const },
        createdEvent: {
          projectId: source.projectId,
          conversationId: source.conversationId,
          sessionId: source.sessionId,
          turnId: source.turnId,
          type: "memory.note.created",
          source: "server",
          payload: { noteNumber, importance, defaultSkillScope, normalizedNoteKey },
        } as const,
      }
    })()
    if ("createdEvent" in result) {
      this.appendEvent(result.createdEvent)
    } else if ("deduplicatedEvent" in result) {
      this.appendEvent(result.deduplicatedEvent)
    }
    return result.output
  }

  runMemoryNotesTool(input: MemoryNotesToolInput): MemoryNotesToolOutput {
    this.ensureGlobalKnowledge()
    if (input.operation === "list") {
      const limit = Math.min(input.limit ?? 10, 10)
      const rows = this.openMemoryNoteRows(limit)
      const total = this.openMemoryNoteCount()
      const notes = rows.map((row) => this.memoryNoteToolRow(row, false))
      return { operation: "list", notes, totalMatches: total, truncation: truncationFor(JSON.stringify(notes), DEFAULT_CHAR_LIMIT) }
    }
    const row = this.mustGetMemoryNote(input.noteNumber as number)
    if (input.operation === "read") {
      if (row.status === "open") {
        this.handle.db.update(memoryNotes).set({ status: "processing", claimedAt: nowIso() }).where(eq(memoryNotes.id, row.id)).run()
      }
      const updated = this.mustGetMemoryNote(input.noteNumber as number)
      const notes = [this.memoryNoteToolRow(updated, true)]
      return { operation: "read", notes, totalMatches: 1, truncation: truncationFor(JSON.stringify(notes), DEFAULT_CHAR_LIMIT) }
    }
    const outcome = input.outcome
    if (!outcome) {
      throw new SocratesError("memory_note_outcome_required", "memory_notes.mark_done requires outcome.", {
        recoverable: true,
        details: { noteNumber: row.noteNumber, allowedOutcomes: MEMORY_NOTE_OUTCOMES },
      })
    }
    const resolution = input.resolution?.trim()
    if (!resolution) {
      throw new SocratesError("memory_note_resolution_required", "memory_notes.mark_done requires a one-line resolution.", {
        recoverable: true,
        details: { noteNumber: row.noteNumber },
      })
    }
    const completedAt = nowIso()
    this.handle.db.update(memoryNotes).set({ status: "done", completedAt, outcome, resolution }).where(eq(memoryNotes.id, row.id)).run()
    const updated = this.mustGetMemoryNote(input.noteNumber as number)
    this.appendEvent({
      ...(updated.projectId ? { projectId: updated.projectId } : {}),
      ...(updated.conversationId ? { conversationId: updated.conversationId } : {}),
      ...(updated.sessionId ? { sessionId: updated.sessionId } : {}),
      ...(updated.turnId ? { turnId: updated.turnId } : {}),
      type: "memory.note.completed",
      source: "server",
      payload: { noteNumber: updated.noteNumber, outcome: updated.outcome, resolution: updated.resolution },
    })
    const notes = [this.memoryNoteToolRow(updated, true)]
    return { operation: "mark_done", notes, totalMatches: 1, truncation: truncationFor(JSON.stringify(notes), DEFAULT_CHAR_LIMIT) }
  }

  async approveMemorySkillProposal(actionId: string): Promise<{ actionId: string; skill: SkillSummary }> {
    this.ensureGlobalKnowledge()
    const action = this.handle.db.select().from(memoryAgentActions).where(eq(memoryAgentActions.id, actionId)).limit(1).get()
    if (!action) {
      throw new SocratesError("memory_skill_proposal_not_found", "Memory skill proposal was not found.", { recoverable: true, details: { actionId } })
    }
    if (action.targetKind !== "skill_request") {
      throw new SocratesError("memory_skill_proposal_invalid", "Memory action is not a skill proposal.", { recoverable: true, details: { actionId, targetKind: action.targetKind } })
    }
    if (action.status !== "proposed") {
      throw new SocratesError("memory_skill_proposal_not_pending", "Memory skill proposal is not pending approval.", { recoverable: true, details: { actionId, status: action.status } })
    }

    const metadata = parseJsonObject(action.metadataJson)
    const patch = parseJsonObject(action.patchJson)
    const scope = metadata.scope === "project" ? "project" : "global"
    const operation = metadata.operation === "update" ? "update" : "create"
    const name = typeof metadata.skillName === "string" ? metadata.skillName : path.basename(path.dirname(action.targetPath))
    const request = typeof patch.newText === "string" ? patch.newText : action.rationale ?? ""
    const sourceTurn = action.turnId ? this.handle.db.select().from(turns).where(eq(turns.id, action.turnId)).limit(1).get() : undefined
    const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined
    const skill = await this.runApprovedSkillWriterTask({
      scope,
      operation,
      name,
      request,
      projectId: scope === "project" && action.projectId !== GLOBAL_MEMORY_AGENT_PROJECT_ID ? action.projectId : GLOBAL_MEMORY_AGENT_PROJECT_ID,
      ...(workspacePath ? { workspacePath } : {}),
      ...(sourceTurn?.conversationId ? { conversationId: sourceTurn.conversationId } : {}),
      ...(sourceTurn?.sessionId ? { sessionId: sourceTurn.sessionId } : {}),
      ...(action.turnId ? { turnId: action.turnId } : {}),
      sourceKind: "memory_agent_action",
      sourceId: actionId,
    })
    const finalContent = readIfExists(action.targetPath) ?? ""
    this.handle.db
      .update(memoryAgentActions)
      .set({ status: "applied", afterHash: hashText(finalContent), appliedAt: nowIso() })
      .where(eq(memoryAgentActions.id, actionId))
      .run()
    this.appendEvent({
      ...(action.projectId && action.projectId !== GLOBAL_MEMORY_AGENT_PROJECT_ID ? { projectId: action.projectId } : {}),
      ...(sourceTurn?.conversationId ? { conversationId: sourceTurn.conversationId } : {}),
      ...(sourceTurn?.sessionId ? { sessionId: sourceTurn.sessionId } : {}),
      ...(action.turnId ? { turnId: action.turnId } : {}),
      type: "memory.skill.approved",
      source: "server",
      payload: { actionId, scope, operation, skillName: name, path: skill.path },
    })
    return { actionId, skill }
  }

  rejectMemorySkillProposal(actionId: string): { actionId: string; status: "rejected" } {
    this.ensureGlobalKnowledge()
    const action = this.handle.db.select().from(memoryAgentActions).where(eq(memoryAgentActions.id, actionId)).limit(1).get()
    if (!action) {
      throw new SocratesError("memory_skill_proposal_not_found", "Memory skill proposal was not found.", { recoverable: true, details: { actionId } })
    }
    if (action.targetKind !== "skill_request") {
      throw new SocratesError("memory_skill_proposal_invalid", "Memory action is not a skill proposal.", { recoverable: true, details: { actionId, targetKind: action.targetKind } })
    }
    if (action.status !== "proposed") {
      throw new SocratesError("memory_skill_proposal_not_pending", "Memory skill proposal is not pending approval.", { recoverable: true, details: { actionId, status: action.status } })
    }

    this.handle.db
      .update(memoryAgentActions)
      .set({ status: "rejected", error: "Rejected by user." })
      .where(eq(memoryAgentActions.id, actionId))
      .run()

    const metadata = parseJsonObject(action.metadataJson)
    const scope = metadata.scope === "project" ? "project" : "global"
    const operation = metadata.operation === "update" ? "update" : "create"
    const skillName = typeof metadata.skillName === "string" ? metadata.skillName : path.basename(path.dirname(action.targetPath))
    this.appendEvent({
      ...(action.projectId && action.projectId !== GLOBAL_MEMORY_AGENT_PROJECT_ID ? { projectId: action.projectId } : {}),
      ...(action.turnId ? { turnId: action.turnId } : {}),
      type: "memory.skill.rejected",
      source: "server",
      payload: { actionId, scope, operation, skillName, path: action.targetPath },
    })
    return { actionId, status: "rejected" }
  }

  listProjectSkills(projectId: string, workspacePath: string | undefined): SkillSummary[] {
    this.ensureProjectMemory(projectId, workspacePath)
    return this.skillInfos(workspacePath, "project").map(skillSummary)
  }

  async buildProjectSkill(projectId: string, workspacePath: string, request: string, explicitName?: string): Promise<SkillSummary> {
    this.ensureProjectMemory(projectId, workspacePath)
    const skillRoot = path.join(workspacePath, ".socrates", "skills")
    fs.mkdirSync(skillRoot, { recursive: true })
    const name = explicitName ? this.availableExplicitSkillName(skillRoot, explicitName) : uniqueSkillName(skillRoot, slugSkillName(request))
    return this.runApprovedSkillWriterTask({
      scope: "project",
      operation: "create",
      name,
      request,
      projectId,
      workspacePath,
      sourceKind: "dashboard",
    })
  }

  deleteProjectSkill(projectId: string, workspacePath: string, name: string): SkillSummary {
    this.ensureProjectMemory(projectId, workspacePath)
    return this.deleteSkillFromRoot("project", path.join(workspacePath, ".socrates", "skills"), name)
  }

  runProjectDocsTool(projectId: string, workspacePath: string, input: ProjectDocsToolInput): ProjectDocsToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    const runtime = currentRuntimeTime()
    if (input.area === "notes") {
      this.ensureProjectNotesRuntimeContext(projectId, workspacePath, runtime.currentDateTime)
    }
    const documentPath = projectDocPath(workspacePath, input.area)
    const profile = projectDocProfile(projectId, input.area)
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const content = fs.readFileSync(documentPath, "utf8")
    const index = this.indexMemoryDocFile(documentPath, profile)
    if (input.operation === "read_index") {
      const serialized = renderMemoryDocIndex(index)
      return {
        operation: "read_index",
        area: input.area,
        path: projectDocRelativePath(input.area),
        content: truncate(serialized, charLimit).text,
        index,
        runtime,
        truncation: truncationFor(serialized, charLimit),
      }
    }
    if (input.operation === "read_section") {
      const section = findMemoryDocSection(index, input.sectionId as string)
      const clipped = truncate(section.content, charLimit)
      return {
        operation: "read_section",
        area: input.area,
        path: projectDocRelativePath(input.area),
        content: clipped.text,
        section,
        runtime,
        truncation: truncationFor(section.content, charLimit),
        ...(clipped.truncated ? { warnings: [`Section ${section.sectionId} was truncated. Re-read with a larger charLimit if needed.`] } : {}),
      }
    }
    if (input.operation === "patch_section") {
      const sectionId = input.sectionId as string
      this.assertProjectDocsSectionMutable(input.area, sectionId)
      const patched = patchMemoryDocSection(content, profile, sectionId, input.oldText ?? "", input.newText ?? "", input.replaceAll)
      const next = patched === content ? patched : stampMemoryDocFrontmatter(patched, { updatedAt: runtime.currentDateTime, updatedBy: "project_docs", lastEditedSection: sectionId })
      fs.writeFileSync(documentPath, next)
      const nextIndex = this.indexMemoryDocFile(documentPath, profile)
      const section = findMemoryDocSection(nextIndex, sectionId)
      return {
        operation: "patch_section",
        area: input.area,
        path: projectDocRelativePath(input.area),
        changed: next !== content,
        content: truncate(section.content, charLimit).text,
        section,
        index: nextIndex,
        runtime,
        truncation: truncationFor(section.content, charLimit),
      }
    }
    if (input.operation === "read") {
      const truncated = truncate(content, charLimit)
      return {
        operation: "read",
        area: input.area,
        path: projectDocRelativePath(input.area),
        content: truncated.text,
        runtime,
        truncation: truncationFor(content, charLimit),
        ...(truncated.truncated ? { warnings: [`${projectDocRelativePath(input.area)} was truncated. Re-read with a larger charLimit if needed.`] } : {}),
      }
    }
    if (input.operation === "search") {
      const matches = lineMatches(content, input.query as string, DEFAULT_SEARCH_LIMIT)
      return {
        operation: "search",
        area: input.area,
        path: projectDocRelativePath(input.area),
        matches: matches.map((match) => ({ line: match.line, text: match.text })),
        runtime,
        truncation: truncationFor(JSON.stringify(matches), charLimit),
        ...(matches.length === DEFAULT_SEARCH_LIMIT ? { warnings: [`${projectDocRelativePath(input.area)} search hit the match limit; narrow the query.`] } : {}),
      }
    }
    let next = content
    if (input.editMode === "append") {
      const text = input.text ?? ""
      next = `${content.trimEnd()}\n\n${text.trim()}\n`
    } else {
      const oldText = input.oldText ?? ""
      const newText = input.newText ?? ""
      const occurrences = oldText.length === 0 ? 0 : countOccurrences(content, oldText)
      if (oldText.length === 0 || occurrences === 0) {
        throw new SocratesError("project_docs_edit_failed", `oldText was not found in ${projectDocRelativePath(input.area)}.`, { recoverable: true })
      }
      if (occurrences > 1) {
        throw new SocratesError("project_docs_edit_ambiguous", "oldText matched more than once. Retry with a longer oldText.", {
          recoverable: true,
          details: { occurrences, area: input.area },
        })
      }
      next = content.replace(oldText, newText)
    }
    this.assertProjectDocsProtectedSectionsUnchanged(input.area, content, next, profile)
    next = next === content ? next : stampMemoryDocFrontmatter(next, { updatedAt: runtime.currentDateTime, updatedBy: "project_docs", lastEditedSection: "document" })
    fs.writeFileSync(documentPath, next)
    const nextIndex = this.indexMemoryDocFile(documentPath, profile)
    return {
      operation: "edit",
      area: input.area,
      path: projectDocRelativePath(input.area),
      changed: next !== content,
      content: truncate(next, charLimit).text,
      index: nextIndex,
      runtime,
      truncation: truncationFor(next, charLimit),
    }
  }

  private ensureProjectNotesRuntimeContext(projectId: string, workspacePath: string, generatedAt: string): void {
    const notesPath = projectDocPath(workspacePath, "notes")
    const profile = projectDocProfile(projectId, "notes")
    const content = fs.readFileSync(notesPath, "utf8")
    const context = buildProjectNotesRuntimeContext(workspacePath, generatedAt)
    const next = upsertRuntimeContextSection(removeAssistantStatusPreviewLines(content), context.section, context.signature)
    if (next === content) {
      return
    }
    fs.writeFileSync(
      notesPath,
      stampMemoryDocFrontmatter(next, {
        updatedAt: generatedAt,
        updatedBy: "system",
        lastEditedSection: PROJECT_NOTES_RUNTIME_CONTEXT_SECTION,
      }),
    )
    this.indexMemoryDocFile(notesPath, profile)
  }

  private assertProjectDocsSectionMutable(area: ProjectDocsArea, sectionId: string): void {
    if (area === "notes" && sectionId === PROJECT_NOTES_RUNTIME_CONTEXT_SECTION) {
      throw new SocratesError("project_docs_runtime_context_protected", "runtime_context is system-owned and cannot be edited by project_docs.", {
        recoverable: true,
        details: { area, sectionId },
      })
    }
  }

  private assertProjectDocsProtectedSectionsUnchanged(area: ProjectDocsArea, before: string, after: string, profile: MemoryDocProfile): void {
    if (area !== "notes" || before === after) {
      return
    }
    const beforeSection = sectionContentOrUndefined(before, profile, PROJECT_NOTES_RUNTIME_CONTEXT_SECTION)
    const afterSection = sectionContentOrUndefined(after, profile, PROJECT_NOTES_RUNTIME_CONTEXT_SECTION)
    if (beforeSection !== afterSection) {
      throw new SocratesError("project_docs_runtime_context_protected", "runtime_context is system-owned and cannot be changed by project_docs.", {
        recoverable: true,
        details: { area, sectionId: PROJECT_NOTES_RUNTIME_CONTEXT_SECTION },
      })
    }
  }

  recordProjectStateLedger(
    projectId: string,
    workspacePath: string | undefined,
    input: {
      conversationTitle?: string
      turnId: string
      status: "completed" | "cancelled" | "failed"
      userRequest?: string
      toolRuns: ConversationToolRun[]
      failedToolEvents: FailedToolEventForLedger[]
    },
  ): void {
    if (!workspacePath) {
      return
    }
    this.ensureProjectMemory(projectId, workspacePath)
    const notesPath = projectDocPath(workspacePath, "notes")
    const content = fs.readFileSync(notesPath, "utf8")
    const section = formatProjectStateLedgerSection(input)
    const runtime = currentRuntimeTime()
    const next = replaceStateLedgerSection(removeAssistantStatusPreviewLines(content), section)
    fs.writeFileSync(
      notesPath,
      stampMemoryDocFrontmatter(next, {
        updatedAt: runtime.currentDateTime,
        updatedBy: "system",
        lastEditedSection: "state_ledger",
      }),
    )
    this.indexMemoryDocFile(notesPath, projectDocProfile(projectId, "notes"))
  }

  runRepoDocsTool(projectId: string, workspacePath: string, input: RepoDocsToolInput): RepoDocsToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    const runtime = currentRuntimeTime()
    const docsRoot = repoDocsRoot(workspacePath)
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    if (input.operation === "read_index") {
      const names = input.path ? [input.path] : [...REPO_DOC_NAMES]
      const indexes = names.map((name) => this.indexMemoryDocFile(repoDocPath(docsRoot, name), repoDocProfile(projectId, name)))
      const serialized = indexes.map(renderMemoryDocIndex).join("\n\n")
      return {
        operation: "read_index",
        ...(input.path ? { path: `.socrates/repo_docs/${input.path}` } : { paths: names.map((name) => `.socrates/repo_docs/${name}`) }),
        ...(input.path ? { index: indexes[0] } : { indexes }),
        content: truncate(serialized, charLimit).text,
        runtime,
        truncation: truncationFor(serialized, charLimit),
      }
    }
    if (input.operation === "read_section") {
      const name = input.path as (typeof REPO_DOC_NAMES)[number]
      const profile = repoDocProfile(projectId, name)
      const index = this.indexMemoryDocFile(repoDocPath(docsRoot, name), profile)
      const section = findMemoryDocSection(index, input.sectionId as string)
      const clipped = truncate(section.content, charLimit)
      return {
        operation: "read_section",
        path: `.socrates/repo_docs/${name}`,
        content: clipped.text,
        section,
        index,
        runtime,
        truncation: truncationFor(section.content, charLimit),
        ...(clipped.truncated ? { warnings: [`Section ${section.sectionId} was truncated. Re-read with a larger charLimit if needed.`] } : {}),
      }
    }
    if (input.operation === "patch_section") {
      const name = input.path as (typeof REPO_DOC_NAMES)[number]
      const absolutePath = repoDocPath(docsRoot, name)
      const content = fs.readFileSync(absolutePath, "utf8")
      const profile = repoDocProfile(projectId, name)
      const sectionId = input.sectionId as string
      const patched = patchMemoryDocSection(content, profile, sectionId, input.oldText ?? "", input.newText ?? "", input.replaceAll)
      const next = patched === content ? patched : stampMemoryDocFrontmatter(patched, { updatedAt: runtime.currentDateTime, updatedBy: "repo_docs", lastEditedSection: sectionId })
      fs.writeFileSync(absolutePath, next)
      const index = this.indexMemoryDocFile(absolutePath, profile)
      const section = findMemoryDocSection(index, sectionId)
      return {
        operation: "patch_section",
        path: `.socrates/repo_docs/${name}`,
        changed: next !== content,
        content: truncate(section.content, charLimit).text,
        section,
        index,
        runtime,
        truncation: truncationFor(section.content, charLimit),
      }
    }
    if (input.operation === "read") {
      if (!input.path) {
        const paths = [...REPO_DOC_NAMES].map((name) => `.socrates/repo_docs/${name}`)
        const content = paths.map((docPath) => `- ${docPath}`).join("\n")
        return {
          operation: "read",
          paths,
          content,
          runtime,
          truncation: truncationFor(content, charLimit),
        }
      }
      const absolutePath = repoDocPath(docsRoot, input.path)
      const content = fs.readFileSync(absolutePath, "utf8")
      const truncated = truncate(content, charLimit)
      return {
        operation: "read",
        path: `.socrates/repo_docs/${input.path}`,
        content: truncated.text,
        runtime,
        truncation: truncationFor(content, charLimit),
        ...(truncated.truncated ? { warnings: [`${input.path} was truncated. Re-read with a larger charLimit if needed.`] } : {}),
      }
    }

    if (input.operation === "search") {
      const query = input.query ?? ""
      const docNames = input.path ? [input.path] : [...REPO_DOC_NAMES]
      const matches = docNames.flatMap((name) => {
        const content = fs.readFileSync(repoDocPath(docsRoot, name), "utf8")
        return lineMatches(content, query, DEFAULT_SEARCH_LIMIT).map((match) => ({
          path: `.socrates/repo_docs/${name}`,
          line: match.line,
          text: match.text,
        }))
      }).slice(0, DEFAULT_SEARCH_LIMIT)
      const serialized = JSON.stringify(matches)
      return {
        operation: "search",
        ...(input.path ? { path: `.socrates/repo_docs/${input.path}` } : { paths: docNames.map((name) => `.socrates/repo_docs/${name}`) }),
        matches,
        runtime,
        truncation: truncationFor(serialized, charLimit),
        ...(matches.length === DEFAULT_SEARCH_LIMIT ? { warnings: ["repo_docs search hit the match limit; narrow the query or path."] } : {}),
      }
    }

    const name = input.path as (typeof REPO_DOC_NAMES)[number]
    const absolutePath = repoDocPath(docsRoot, name)
    const content = fs.readFileSync(absolutePath, "utf8")
    const oldText = input.oldText ?? ""
    const newText = input.newText ?? ""
    const occurrences = oldText.length === 0 ? 0 : countOccurrences(content, oldText)
    if (oldText.length === 0 || occurrences === 0) {
      throw new SocratesError("repo_docs_patch_failed", "oldText was not found in the selected repo doc.", { recoverable: true })
    }
    if (!input.replaceAll && occurrences > 1) {
      throw new SocratesError("repo_docs_patch_ambiguous", "oldText matched more than once. Retry with a longer oldText or replaceAll=true.", {
        recoverable: true,
        details: { path: `.socrates/repo_docs/${name}`, occurrences },
      })
    }
    const patched = input.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText)
    const next = patched === content ? patched : stampMemoryDocFrontmatter(patched, { updatedAt: runtime.currentDateTime, updatedBy: "repo_docs", lastEditedSection: "document" })
    fs.writeFileSync(absolutePath, next)
    const index = this.indexMemoryDocFile(absolutePath, repoDocProfile(projectId, name))
    return {
      operation: "edit",
      path: `.socrates/repo_docs/${name}`,
      changed: next !== content,
      content: truncate(next, charLimit).text,
      index,
      runtime,
      truncation: truncationFor(next, charLimit),
    }
  }

  runSoulTool(projectId: string, workspacePath: string | undefined, input: SoulToolInput): SoulToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    const charLimit = primaryMemoryCharLimit(input.operation, input.charLimit)
    const absolutePath = this.soulPath()
    const profile = globalMemoryDocProfile(this.socratesHome, "identity")
    const content = fs.readFileSync(absolutePath, "utf8")
    const index = this.indexMemoryDocFile(absolutePath, profile)
    if (input.operation === "read_index") {
      const serialized = renderMemoryDocIndex(index)
      return {
        operation: "read_index",
        path: "identity.md",
        content: truncate(serialized, charLimit).text,
        index,
        truncation: truncationFor(serialized, charLimit),
      }
    }
    if (input.operation === "read_section") {
      const section = findMemoryDocSection(index, input.sectionId as string)
      const clipped = truncate(section.content, charLimit)
      return {
        operation: "read_section",
        path: "identity.md",
        content: clipped.text,
        section,
        index,
        truncation: truncationFor(section.content, charLimit),
        ...(clipped.truncated ? { warnings: [`Section ${section.sectionId} was truncated. Re-read with a larger charLimit if needed.`] } : {}),
      }
    }
    const clipped = truncate(content, charLimit)
    return {
      operation: "read",
      path: "identity.md",
      content: clipped.text,
      index,
      truncation: truncationFor(content, charLimit),
      ...(clipped.truncated ? { warnings: ["identity.md was truncated. Re-read with a larger charLimit or use read_index/read_section if needed."] } : {}),
    }
  }

  runUserProfileTool(projectId: string, workspacePath: string | undefined, input: UserProfileToolInput): UserProfileToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    const charLimit = primaryMemoryCharLimit(input.operation, input.charLimit)
    const absolutePath = this.userProfilePath()
    const profile = globalMemoryDocProfile(this.socratesHome, "user_profile")
    const content = fs.readFileSync(absolutePath, "utf8")
    const index = this.indexMemoryDocFile(absolutePath, profile)
    if (input.operation === "read_index") {
      const serialized = renderMemoryDocIndex(index)
      return {
        operation: "read_index",
        path: "user_profile.md",
        content: truncate(serialized, charLimit).text,
        index,
        truncation: truncationFor(serialized, charLimit),
      }
    }
    if (input.operation === "read_section") {
      const section = findMemoryDocSection(index, input.sectionId as string)
      const clipped = truncate(section.content, charLimit)
      return {
        operation: "read_section",
        path: "user_profile.md",
        content: clipped.text,
        section,
        index,
        truncation: truncationFor(section.content, charLimit),
        ...(clipped.truncated ? { warnings: [`Section ${section.sectionId} was truncated. Re-read with a larger charLimit if needed.`] } : {}),
      }
    }
    const clipped = truncate(content, charLimit)
    return {
      operation: "read",
      path: "user_profile.md",
      content: clipped.text,
      index,
      truncation: truncationFor(content, charLimit),
      ...(clipped.truncated ? { warnings: ["user_profile.md was truncated. Re-read with a larger charLimit or use read_index/read_section if needed."] } : {}),
    }
  }

  async runGlobalMemoryAgent(input: GlobalMemoryAgentRunInput): Promise<TriggerMemoryAgentRunResponse> {
    this.ensureGlobalKnowledge()
    if (this.globalMemoryRunActive) {
      return { state: input.state, pending: this.getMemoryAgentPending(input.state), skippedReason: "Memory agent is already running." }
    }
    this.globalMemoryRunActive = true
    try {
      return await this.runGlobalMemoryAgentOnce(input)
    } finally {
      this.globalMemoryRunActive = false
    }
  }

  getMemoryAgentPending(state: MemoryAgentGlobalState): MemoryAgentSignalSnapshot {
    this.ensureGlobalKnowledge()
    const manifest = this.buildGlobalManifest(state.lastProcessedEventSequence)
    return this.signalForManifest(manifest)
  }

  listMemoryAgentTimeline(limit = 25, offset = 0): { items: MemoryAgentTimelineItem[]; totalMatches: number; nextOffset?: number } {
    const jobRows = this.handle.db
      .select()
      .from(memoryAgentJobs)
      .where(eq(memoryAgentJobs.projectId, GLOBAL_MEMORY_AGENT_PROJECT_ID))
      .orderBy(desc(memoryAgentJobs.startedAt))
      .limit(limit + offset + 25)
      .all()
    const checkRows = this.handle.db
      .select()
      .from(memoryAgentChecks)
      .orderBy(desc(memoryAgentChecks.checkedAt))
      .limit(limit + offset + 25)
      .all()
    const items = [
      ...jobRows.map((row) => this.memoryAgentTimelineItem(row)),
      ...checkRows.map((row) => this.memoryAgentCheckTimelineItem(row)),
    ].sort((left, right) => Date.parse(right.startedAt ?? right.checkedAt ?? right.completedAt ?? "") - Date.parse(left.startedAt ?? left.checkedAt ?? left.completedAt ?? ""))
    const totalMatches = this.countMemoryAgentTimelineItems()
    const sliced = items.slice(offset, offset + limit)
    return {
      items: sliced,
      totalMatches,
      ...(offset + limit < totalMatches ? { nextOffset: offset + limit } : {}),
    }
  }

  getMemoryAgentRunDetail(runId: string): MemoryAgentRunDetail {
    return this.memoryAgentRunDetail(this.mustGetMemoryAgentJob(runId))
  }

  listMemoryAgentFiles(): MemoryAgentFileSummary[] {
    this.ensureGlobalKnowledge()
    const coreMemoryFiles: MemoryAgentFileSummary[] = ([
      {
        kind: "identity" as const,
        name: "Identity",
        description: "Socrates identity, voice, principles, boundaries, and tool discipline.",
        absolutePath: this.soulPath(),
      },
      {
        kind: "user_profile" as const,
        name: "User Profile",
        description: "Stable user facts, preferences, and collaboration style.",
        absolutePath: this.userProfilePath(),
      },
    ]).flatMap((file) => {
      const absolutePath = file.absolutePath
      if (!fs.existsSync(absolutePath)) {
        return []
      }
      const stats = fs.statSync(absolutePath)
      return [
        {
          id: `${file.kind}:${path.basename(absolutePath)}`,
          kind: file.kind,
          name: file.name,
          description: file.description,
          path: path.basename(absolutePath),
          absolutePath,
          updatedAt: stats.mtime.toISOString(),
        },
      ]
    })
    const toolDocs = new ToolDocsStore(this.socratesHome, "all").listFiles().map((file) => ({
      id: `tool_doc:${file.path}`,
      kind: "tool_doc" as const,
      name: path.basename(file.path),
      description: firstMarkdownLine(readIfExists(file.absolutePath) ?? ""),
      path: file.path,
      absolutePath: file.absolutePath,
      updatedAt: file.modifiedAt,
    }))
    const skills = this.skillInfos(undefined, undefined)
      .filter((skill) => skill.scope === "builtin" || skill.scope === "global")
      .map((skill) => ({
        id: `skill:${skill.scope}:${skill.name}`,
        kind: "skill" as const,
        scope: skill.scope,
        name: skill.name,
        description: skill.description,
        path: skill.path,
        absolutePath: skill.skillFile,
        updatedAt: skill.updatedAt,
      }))
    return [...coreMemoryFiles, ...toolDocs, ...skills].sort((left, right) => `${left.kind}:${memoryFileScope(left)}:${left.name}`.localeCompare(`${right.kind}:${memoryFileScope(right)}:${right.name}`))
  }

  readMemoryAgentFileContent(input: MemoryAgentFileContentQuery): { file: MemoryAgentFileSummary; content: string } {
    const file = this.listMemoryAgentFiles().find((candidate) => candidate.kind === input.kind && candidate.path === input.path && (input.scope === undefined || memoryFileScope(candidate) === input.scope))
    if (!file) {
      throw new SocratesError("memory_agent_file_not_found", "Memory agent file was not found.", { recoverable: true, details: input })
    }
    const content = readIfExists(file.absolutePath)
    if (content === undefined) {
      throw new SocratesError("memory_agent_file_not_found", "Memory agent file was not found.", { recoverable: true, details: input })
    }
    return { file, content }
  }

  async buildGlobalSkill(request: string, explicitName?: string): Promise<SkillSummary> {
    this.ensureGlobalKnowledge()
    const root = path.join(this.socratesHome, "skills")
    fs.mkdirSync(root, { recursive: true })
    const name = explicitName ? this.availableExplicitSkillName(root, explicitName) : uniqueSkillName(root, slugSkillName(request))
    return this.runApprovedSkillWriterTask({
      scope: "global",
      operation: "create",
      name,
      request,
      projectId: GLOBAL_MEMORY_AGENT_PROJECT_ID,
      sourceKind: "dashboard",
    })
  }

  deleteGlobalSkill(name: string): SkillSummary {
    this.ensureGlobalKnowledge()
    return this.deleteSkillFromRoot("global", path.join(this.socratesHome, "skills"), name)
  }

  runProjectsTool(input: ProjectsToolInput): ProjectsToolOutput {
    const limit = input.limit ?? 50
    const offset = input.offset ?? 0
    if (input.operation === "list_projects") {
      const rows = this.handle.sqlite
        .prepare(
          `SELECT p.id, p.name, p.description, p.status, p.updated_at AS updatedAt,
                  pw.path AS workspacePath,
                  COUNT(DISTINCT c.id) AS conversationCount,
                  COUNT(DISTINCT pr.id) AS resourceCount,
                  MAX(c.updated_at) AS lastActivityAt
             FROM projects p
             LEFT JOIN project_workspaces pw ON pw.project_id = p.id AND pw.is_primary = 1
             LEFT JOIN conversations c ON c.project_id = p.id AND c.status IN ('active', 'archived')
             LEFT JOIN project_resources pr ON pr.project_id = p.id AND pr.status != 'deleted'
            WHERE p.status != 'deleted'
            GROUP BY p.id
            ORDER BY COALESCE(lastActivityAt, p.updated_at) DESC
            LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as Array<{
        id: string
        name: string
        description: string | null
        status: "active" | "archived" | "deleted"
        updatedAt: string
        workspacePath: string | null
        conversationCount: number
        resourceCount: number
        lastActivityAt: string | null
      }>
      const total = this.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM projects WHERE status != 'deleted'").get() as { count: number }
      const projectsOutput = rows.map((row) => ({
        id: row.id,
        name: row.name,
        ...(row.description ? { description: row.description } : {}),
        status: row.status,
        updatedAt: row.updatedAt,
        ...(row.lastActivityAt ? { lastActivityAt: row.lastActivityAt } : {}),
        conversationCount: row.conversationCount,
        resourceCount: row.resourceCount,
        ...(row.workspacePath ? { workspacePath: row.workspacePath } : {}),
      }))
      const serialized = JSON.stringify(projectsOutput)
      return {
        operation: "list_projects",
        projects: projectsOutput,
        totalMatches: total.count,
        truncation: truncationFor(serialized, DEFAULT_CHAR_LIMIT),
      }
    }

    const rows = this.handle.sqlite
      .prepare(
        `SELECT c.id, c.project_id AS projectId, c.title, c.status, c.updated_at AS updatedAt,
                COUNT(t.id) AS turnCount
           FROM conversations c
           LEFT JOIN turns t ON t.conversation_id = c.id
          WHERE c.project_id = ? AND c.status IN ('active', 'archived')
          GROUP BY c.id
          ORDER BY c.updated_at DESC
          LIMIT ? OFFSET ?`,
      )
      .all(input.projectId, limit, offset) as Array<{
      id: string
      projectId: string
      title: string | null
      status: "active" | "archived" | "deleted"
      updatedAt: string
      turnCount: number
    }>
    const total = this.handle.sqlite
      .prepare("SELECT COUNT(*) AS count FROM conversations WHERE project_id = ? AND status IN ('active', 'archived')")
      .get(input.projectId) as { count: number }
    const conversationsOutput = rows.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      ...(row.title ? { title: row.title } : {}),
      status: row.status,
      updatedAt: row.updatedAt,
      turnCount: row.turnCount,
    }))
    const serialized = JSON.stringify(conversationsOutput)
    return {
      operation: "list_conversations",
      conversations: conversationsOutput,
      totalMatches: total.count,
      truncation: truncationFor(serialized, DEFAULT_CHAR_LIMIT),
    }
  }

  private async runGlobalMemoryAgentOnce(input: GlobalMemoryAgentRunInput): Promise<TriggerMemoryAgentRunResponse> {
    const now = nowIso()
    const entries = this.buildGlobalManifest(input.state.lastProcessedEventSequence)
    const signal = this.signalForManifest(entries)
    if (!input.settings.enabled) {
      const reason = "Memory agent is disabled."
      const item = this.recordMemoryAgentCheck(input.trigger, "skipped", signal, reason, now)
      const state = input.updateState({ status: "skipped", lastCheckedAt: now, activeJobId: null, error: reason })
      return { state, pending: signal, item, skippedReason: reason }
    }
    if (entries.entries.length === 0 && !signal.shouldRun) {
      const reason = "No new completed turns since the memory watermark."
      const item = this.recordMemoryAgentCheck(input.trigger, "skipped", signal, reason, now)
      const state = input.updateState({ status: "idle", lastCheckedAt: now, activeJobId: null, error: null })
      return { state, pending: signal, item, skippedReason: reason }
    }
    if (!signal.shouldRun) {
      const item = this.recordMemoryAgentCheck(input.trigger, "skipped", signal, signal.displayReason, now)
      const state = input.updateState({ status: "idle", lastCheckedAt: now, activeJobId: null, error: null })
      return { state, pending: signal, item, skippedReason: signal.displayReason }
    }
    if (!this.options.provider) {
      const reason = "Memory agent provider is not configured."
      const item = this.recordMemoryAgentCheck(input.trigger, "skipped", signal, reason, now)
      const state = input.updateState({ status: "skipped", lastCheckedAt: now, activeJobId: null, error: reason })
      return { state, pending: signal, item, skippedReason: reason }
    }
    if (
      input.settings.providerId !== "ollama" &&
      this.options.credentials &&
      !this.options.credentials.resolveAuth?.(input.settings.providerId, input.settings.authMode ?? "api_key") &&
      !this.options.credentials.getApiKey(input.settings.providerId)
    ) {
      const reason = `${input.settings.providerId} credential is not configured.`
      const item = this.recordMemoryAgentCheck(input.trigger, "skipped", signal, reason, now)
      const state = input.updateState({ status: "skipped", lastCheckedAt: now, activeJobId: null, error: reason })
      return { state, pending: signal, item, skippedReason: reason }
    }

    const modelSettings: MemoryAgentModelSettings = {
      providerId: input.settings.providerId,
      authMode: input.settings.authMode ?? "api_key",
      modelId: input.settings.modelId,
      thinkingEnabled: input.settings.thinkingEnabled,
      ...(input.settings.thinkingEffort ? { thinkingEffort: input.settings.thinkingEffort } : {}),
    }
    const latest = entries.entries[entries.entries.length - 1]
    const jobId = createId("memjob")
    const evidence = entries.manifest
    const evidenceTokensEstimate = estimateTextTokens(evidence).inputTokens
    const startedAt = nowIso()
    const metadataBase = {
      sequenceFrom: entries.sequenceFrom,
      sequenceTo: entries.sequenceTo,
      thinkingEnabled: modelSettings.thinkingEnabled,
      thinkingEffort: modelSettings.thinkingEffort,
      turnCount: entries.entries.length,
    }
    const memoryNoteSignalStats = this.memoryNoteSignalStats(entries.sequenceFrom, entries.sequenceTo)
    const memoryNoteRunStats: MemoryNoteRunStats = emptyMemoryNoteRunStats()
    this.handle.db
      .insert(memoryAgentJobs)
      .values({
        id: jobId,
        projectId: GLOBAL_MEMORY_AGENT_PROJECT_ID,
        conversationId: latest?.conversationId,
        sessionId: latest?.sessionId,
        turnId: latest?.turnId,
        status: "running",
        trigger: input.trigger,
        providerId: modelSettings.providerId,
        modelId: modelSettings.modelId,
        fallbackModelIdsJson: JSON.stringify([]),
      evidenceTurnIdsJson: JSON.stringify(entries.entries.map((entry) => entry.turnId)),
      evidenceTokensEstimate,
      startedAt,
      metadataJson: JSON.stringify({ ...metadataBase, signal }),
    })
      .run()
    input.updateState({ status: "running", lastCheckedAt: startedAt, activeJobId: jobId, error: null })
    this.appendEvent({
      type: "memory.agent.started",
      source: "server",
      payload: { jobId, trigger: input.trigger, sequenceFrom: entries.sequenceFrom, sequenceTo: entries.sequenceTo, evidenceTokensEstimate },
    })

    const toolEvents: unknown[] = []
    let latestUsage: unknown
    try {
      const contextCompressorSettings = this.options.getWorkerModelSettings?.("context_compactor")
      const output = await runMemoryAgentTurn({
        provider: this.options.provider,
        modelSettings,
        evidence,
        projectId: GLOBAL_MEMORY_AGENT_PROJECT_ID,
        conversationId: latest?.conversationId ?? "",
        sessionId: latest?.sessionId ?? "",
        turnId: latest?.turnId ?? "",
        socratesHome: this.socratesHome,
        ...(contextCompressorSettings ? { contextCompressorSettings } : {}),
        tools: {
          traceRetrieve: async (toolInput) => {
            if (!this.options.traceRetrieveGlobal) {
              throw new SocratesError("memory_agent_trace_unavailable", "Global trace_retrieve is not available to this memory-agent run.", { recoverable: true })
            }
            return this.options.traceRetrieveGlobal(toolInput)
          },
          projects: async (toolInput) => this.runProjectsTool(toolInput),
          toolDocs: async (toolInput) => this.runToolDocsTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput, "memory_agent"),
          skills: async (toolInput) => this.runSkillsTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput),
          memoryNotes: async (toolInput) => this.runMemoryNotesTool(toolInput),
          soul: async (toolInput) => this.runSoulTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput),
          userProfile: async (toolInput) => this.runUserProfileTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput),
          editFiles: async (toolInput) =>
            this.runEditFilesTool(toolInput, {
              jobId,
              modelSettings,
              allowSkillWrites: false,
              ...(latest?.turnId ? { turnId: latest.turnId } : {}),
            }),
        },
        onEvent: (event) => {
          if ((event.type === "model.usage" || event.type === "model.completed") && "usage" in event && event.usage) {
            latestUsage = event.usage
          }
          if (event.type.startsWith("tool.call") || event.type.startsWith("approval.")) {
            toolEvents.push(slimMemoryToolEvent(event))
          }
          if (event.type === "tool.call.completed" && event.toolName === "memory_notes") {
            recordMemoryNotesToolOutput(memoryNoteRunStats, event.output)
          }
          if (event.type === "tool.call.failed") {
            const details = mergeToolErrorDetails(event.error.details, event.toolName)
            this.appendEvent({
              ...(latest?.projectId ? { projectId: latest.projectId } : {}),
              ...(latest?.conversationId ? { conversationId: latest.conversationId } : {}),
              ...(latest?.sessionId ? { sessionId: latest.sessionId } : {}),
              ...(latest?.turnId ? { turnId: latest.turnId } : {}),
              type: "tool.call.failed",
              source: "tool",
              payload: {
                toolCallId: event.toolCallId,
                ...(event.providerToolCallId ? { providerToolCallId: event.providerToolCallId } : {}),
                error: {
                  code: event.error.code,
                  message: event.error.message,
                  ...(Object.keys(details).length > 0 ? { details } : {}),
                  ...(typeof event.error.recoverable === "boolean" ? { recoverable: event.error.recoverable } : {}),
                },
                ...(event.modelCallId ? { modelCallId: event.modelCallId } : {}),
                ...(typeof event.stepIndex === "number" ? { stepIndex: event.stepIndex } : {}),
              },
            })
          }
        },
      })
      const completedAt = nowIso()
      this.handle.db
        .update(memoryAgentJobs)
        .set({
          status: "completed",
          outputJson: JSON.stringify({ summary: parseMemoryAgentSummarySections(output.trim()) }),
          completedAt,
          metadataJson: JSON.stringify({ ...metadataBase, signal, toolEvents, usage: latestUsage }),
        })
        .where(eq(memoryAgentJobs.id, jobId))
        .run()
      const state = input.updateState({
        lastProcessedEventSequence: entries.sequenceTo,
        lastCheckedAt: completedAt,
        lastRealRunAt: completedAt,
        status: "idle",
        activeJobId: null,
        lastJobId: jobId,
        error: null,
      })
      const memoryActivityStats = { ...memoryNoteSignalStats, ...memoryNoteRunStats }
      const notification = shouldNotifyMemoryAgentActivity(memoryActivityStats)
        ? this.options.createNotification?.({
            type: "memory.agent.completed",
            title: "Memory run completed",
            body: memoryAgentActivityBody(memoryActivityStats),
            severity: "info",
            payload: {
              jobId,
              providerId: modelSettings.providerId,
              modelId: modelSettings.modelId,
              sequenceFrom: entries.sequenceFrom,
              sequenceTo: entries.sequenceTo,
              ...memoryActivityStats,
            },
          })
        : undefined
      this.appendEvent({
        type: "memory.agent.completed",
        source: "server",
        payload: {
          jobId,
          status: "completed",
          providerId: modelSettings.providerId,
          modelId: modelSettings.modelId,
          sequenceFrom: entries.sequenceFrom,
          sequenceTo: entries.sequenceTo,
          ...(notification?.id ? { notificationId: notification.id } : {}),
          ...memoryActivityStats,
        },
      })
      return { state, pending: this.getMemoryAgentPending(state), item: this.memoryAgentTimelineItem(this.mustGetMemoryAgentJob(jobId)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const completedAt = nowIso()
      this.handle.db
        .update(memoryAgentJobs)
        .set({
          status: "failed",
          completedAt,
          metadataJson: JSON.stringify({ ...metadataBase, signal, toolEvents, usage: latestUsage, error: message }),
        })
        .where(eq(memoryAgentJobs.id, jobId))
        .run()
      const state = input.updateState({
        lastCheckedAt: completedAt,
        status: "failed",
        activeJobId: null,
        lastJobId: jobId,
        error: message,
      })
      this.appendEvent({
        type: "memory.agent.failed",
        source: "server",
        payload: { jobId, error: { code: "memory_agent_failed", message } },
      })
      return { state, pending: signal, item: this.memoryAgentTimelineItem(this.mustGetMemoryAgentJob(jobId)), skippedReason: message }
    }
  }

  private buildGlobalManifest(lastProcessedEventSequence: number): { entries: GlobalTurnManifestEntry[]; manifest: string; sequenceFrom: number; sequenceTo: number } {
    const rows = this.handle.sqlite
      .prepare(
        `SELECT e.sequence, e.project_id AS projectId, p.name AS projectName,
                e.conversation_id AS conversationId, c.title AS conversationTitle,
                e.session_id AS sessionId, e.turn_id AS turnId, e.created_at AS createdAt,
                s.workspace_path AS workspacePath
           FROM events e
           JOIN projects p ON p.id = e.project_id
           JOIN conversations c ON c.id = e.conversation_id
           LEFT JOIN sessions s ON s.id = e.session_id
          WHERE e.type = 'turn.completed'
            AND e.sequence > ?
            AND e.project_id IS NOT NULL
            AND e.conversation_id IS NOT NULL
            AND e.session_id IS NOT NULL
            AND e.turn_id IS NOT NULL
          ORDER BY e.sequence ASC
          LIMIT ?`,
      )
      .all(lastProcessedEventSequence, GLOBAL_MEMORY_AGENT_MAX_TURNS) as GlobalTurnManifestRow[]
    const entries: GlobalTurnManifestEntry[] = []
    const renderedEntries: string[] = []
    let packedTokensEstimate = estimateTextTokens(this.renderGlobalManifest(lastProcessedEventSequence, [], [])).inputTokens
    for (const row of rows) {
      if (entries.length >= GLOBAL_MEMORY_AGENT_MAX_TURNS) {
        break
      }
      const entry: GlobalTurnManifestEntry = {
        ...row,
        counts: this.countTurnArtifacts(row.turnId),
      }
      const renderedEntry = this.renderGlobalManifestEntry(entry, entries.length + 1)
      const entryTokensEstimate = estimateTextTokens(`\n${renderedEntry}`).inputTokens
      if (packedTokensEstimate + entryTokensEstimate > MEMORY_AGENT_TOKEN_CAP) {
        break
      }
      entries.push(entry)
      renderedEntries.push(renderedEntry)
      packedTokensEstimate += entryTokensEstimate
    }
    const sequenceFrom = entries[0]?.sequence ?? lastProcessedEventSequence + 1
    const sequenceTo = entries[entries.length - 1]?.sequence ?? lastProcessedEventSequence
    const manifest = this.renderGlobalManifest(lastProcessedEventSequence, entries, renderedEntries)
    return { entries, manifest, sequenceFrom, sequenceTo }
  }

  private renderGlobalManifest(lastProcessedEventSequence: number, entries: GlobalTurnManifestEntry[], renderedEntries: string[]): string {
    const sequenceFrom = entries[0]?.sequence ?? lastProcessedEventSequence + 1
    const sequenceTo = entries[entries.length - 1]?.sequence ?? lastProcessedEventSequence
    return [
      "# Global Memory Agent Manifest",
      `Previous watermark: ${lastProcessedEventSequence}`,
      `Included turn count: ${entries.length}`,
      `Packing limits: maxTurns=${GLOBAL_MEMORY_AGENT_MAX_TURNS}, maxEstimatedTokens=${MEMORY_AGENT_TOKEN_CAP}`,
      `Sequence range: ${sequenceFrom}-${sequenceTo}`,
      "",
      "Use trace_retrieve for message/tool evidence. This manifest intentionally omits message bodies.",
      "",
      this.renderMemoryNotesManifest(),
      "",
      ...renderedEntries,
    ].join("\n")
  }

  private renderMemoryNotesManifest(): string {
    const rows = this.openMemoryNoteRows(10)
    if (rows.length === 0) {
      return "Memory notes inbox: no open notes."
    }
    return [
      `Memory notes inbox: ${rows.length} open/processing note${rows.length === 1 ? "" : "s"} shown, capped at 10.`,
      "Use memory_notes.list/read for full note details and attached trace lookup ids.",
      ...rows.map((row) => `- #${row.noteNumber} [${row.priority}] ${truncateInline(row.note, 250)}`),
    ].join("\n")
  }

  private memoryNoteSignalStats(sequenceFrom: number, sequenceTo: number): MemoryNoteSignalStats {
    const created = this.handle.sqlite
      .prepare("SELECT COUNT(*) AS count FROM events WHERE sequence BETWEEN ? AND ? AND type = 'memory.note.created'")
      .get(sequenceFrom, sequenceTo) as { count: number }
    const deduplicated = this.handle.sqlite
      .prepare("SELECT COUNT(*) AS count FROM events WHERE sequence BETWEEN ? AND ? AND type = 'memory.note.deduplicated'")
      .get(sequenceFrom, sequenceTo) as { count: number }
    return {
      memoryNotesSent: created.count,
      memoryNotesAlreadyRecorded: deduplicated.count,
    }
  }

  private renderGlobalManifestEntry(entry: GlobalTurnManifestEntry, index: number): string {
    return [
      `## ${index}. event sequence ${entry.sequence}`,
      `project: ${entry.projectName} (${entry.projectId})`,
      `conversation: ${entry.conversationTitle ?? "Untitled"} (${entry.conversationId})`,
      `turnId: ${entry.turnId}`,
      `sessionId: ${entry.sessionId}`,
      `completedEventAt: ${entry.createdAt}`,
      entry.workspacePath ? `workspace: ${entry.workspacePath}` : undefined,
      `counts: messages=${entry.counts.messages}, toolCalls=${entry.counts.toolCalls}, failedToolCalls=${entry.counts.failedToolCalls}, fileOps=${entry.counts.fileOperations}, patches=${entry.counts.patches}, shell=${entry.counts.shellCommands}, errors=${entry.counts.errors}`,
      `trace_retrieve: inspect with turnId="${entry.turnId}" or search with projectId="${entry.projectId}" and conversationId="${entry.conversationId}"`,
    ]
      .filter(Boolean)
      .join("\n")
  }

  private countTurnArtifacts(turnId: string): GlobalTurnManifestEntry["counts"] {
    const count = (tableName: string, extraWhere = ""): number => {
      const row = this.handle.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE turn_id = ? ${extraWhere}`).get(turnId) as { count: number }
      return row.count
    }
    return {
      messages: count("messages"),
      toolCalls: count("tool_calls"),
      failedToolCalls: count("tool_calls", "AND status = 'failed'"),
      fileOperations: count("file_operations"),
      patches: count("patches"),
      shellCommands: count("shell_commands"),
      errors: count("errors"),
    }
  }

  private signalForManifest(manifest: { entries: GlobalTurnManifestEntry[]; sequenceFrom: number; sequenceTo: number }): MemoryAgentSignalSnapshot {
    const openNotes = this.openMemoryNoteCount()
    if (manifest.entries.length === 0) {
      if (openNotes === 0) {
        return emptyMemoryAgentSignal(manifest.sequenceTo)
      }
      return {
        sequenceTo: manifest.sequenceTo,
        turnCount: 0,
        toolCalls: 0,
        fileChangeEvents: 0,
        distinctChangedFiles: 0,
        totalTokens: 0,
        shouldRun: true,
        reasons: [`${openNotes} open memory ${openNotes === 1 ? "note" : "notes"}`],
        displayReason: `Memory note inbox has ${openNotes} open/processing ${openNotes === 1 ? "note" : "notes"}.`,
      }
    }
    const turnIds = manifest.entries.map((entry) => entry.turnId)
    const fileStats = this.changedFileStats(turnIds)
    const signal = scoreMemoryAgentSignal({
      sequenceFrom: manifest.sequenceFrom,
      sequenceTo: manifest.sequenceTo,
      turnCount: manifest.entries.length,
      toolCalls: manifest.entries.reduce((total, entry) => total + entry.counts.toolCalls, 0),
      fileChangeEvents: fileStats.fileChangeEvents,
      distinctChangedFiles: fileStats.distinctChangedFiles,
      totalTokens: this.totalTokensForTurns(turnIds),
    })
    if (openNotes === 0) {
      return signal
    }
    const reasons = [...signal.reasons, `${openNotes} open memory ${openNotes === 1 ? "note" : "notes"}`]
    return {
      ...signal,
      shouldRun: true,
      reasons,
      displayReason: signal.shouldRun
        ? `${signal.displayReason} Memory note inbox also has ${openNotes} open/processing ${openNotes === 1 ? "note" : "notes"}.`
        : `Memory note inbox has ${openNotes} open/processing ${openNotes === 1 ? "note" : "notes"}.`,
    }
  }

  private changedFileStats(turnIds: string[]): { fileChangeEvents: number; distinctChangedFiles: number } {
    if (turnIds.length === 0) {
      return { fileChangeEvents: 0, distinctChangedFiles: 0 }
    }
    const placeholders = turnIds.map(() => "?").join(",")
    const changedFiles = new Set<string>()
    const fileRows = this.handle.sqlite
      .prepare(
        `SELECT path, operation, status
           FROM file_operations
          WHERE turn_id IN (${placeholders})
            AND status != 'failed'
            AND lower(operation) NOT IN ('read', 'search', 'list', 'glob')`,
      )
      .all(...turnIds) as Array<{ path: string; operation: string; status: string }>
    for (const row of fileRows) {
      if (row.path.trim()) {
        changedFiles.add(row.path)
      }
    }

    let patchFileEvents = 0
    const patchRows = this.handle.sqlite
      .prepare(`SELECT files_json AS filesJson FROM patches WHERE turn_id IN (${placeholders}) AND status = 'applied'`)
      .all(...turnIds) as Array<{ filesJson: string | null }>
    for (const row of patchRows) {
      const files = parseJsonArray(row.filesJson).filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      patchFileEvents += files.length
      for (const file of files) {
        changedFiles.add(file)
      }
    }

    return {
      fileChangeEvents: fileRows.length + patchFileEvents,
      distinctChangedFiles: changedFiles.size,
    }
  }

  private totalTokensForTurns(turnIds: string[]): number {
    if (turnIds.length === 0) {
      return 0
    }
    const placeholders = turnIds.map(() => "?").join(",")
    const row = this.handle.sqlite
      .prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS totalTokens FROM turn_usage_reports WHERE turn_id IN (${placeholders})`)
      .get(...turnIds) as { totalTokens: number | null }
    return Math.max(0, Math.floor(row.totalTokens ?? 0))
  }

  private recordMemoryAgentCheck(
    trigger: "scheduled" | "manual",
    status: "completed" | "skipped" | "failed",
    signal: MemoryAgentSignalSnapshot,
    reason: string,
    checkedAt: string,
  ): MemoryAgentTimelineItem {
    const id = createId("memchk")
    this.handle.db
      .insert(memoryAgentChecks)
      .values({
        id,
        trigger,
        status,
        reason,
        sequenceFrom: signal.sequenceFrom ?? null,
        sequenceTo: signal.sequenceTo,
        turnCount: signal.turnCount,
        toolCalls: signal.toolCalls,
        fileChangeEvents: signal.fileChangeEvents,
        distinctChangedFiles: signal.distinctChangedFiles,
        totalTokens: signal.totalTokens,
        checkedAt,
        metadataJson: JSON.stringify({ reasons: signal.reasons }),
      })
      .run()
    this.appendEvent({
      type: "memory.agent.checked",
      source: "server",
      payload: {
        checkId: id,
        trigger,
        status,
        reason,
        pending: signal,
        checkedAt,
      },
    })
    return this.memoryAgentCheckTimelineItem(this.mustGetMemoryAgentCheck(id))
  }

  private async runEditFilesTool(
    input: EditFilesToolInput,
    context: { jobId: string; turnId?: string; modelSettings: MemoryAgentModelSettings; allowSkillWrites?: boolean },
  ): Promise<EditFilesToolOutput> {
    this.ensureGlobalKnowledge()
    const resolved = this.resolveEditFilesTarget(input, context)
    if (resolved.targetKind === "skills") {
      return this.proposeSkillWrite(input, resolved, context)
    }
    if (input.editMode === "create") {
      return this.createMemoryTarget(input, resolved, context)
    }
    const patch = this.editFilesPatchForInput(input, resolved)
    if (resolved.targetKind === "soul") {
      const result = await this.applySoulPatch(GLOBAL_MEMORY_AGENT_PROJECT_ID, context.jobId, context.turnId ? {
        turnId: context.turnId,
      } : undefined, patch, context.modelSettings, input.sectionId)
      const index = result.applied ? this.indexMemoryDocFile(resolved.path, editFilesMemoryDocProfile(resolved, this.socratesHome)) : undefined
      const section = index && input.sectionId ? findMemoryDocSection(index, input.sectionId) : undefined
      return {
        target: input.target,
        ...(input.name ? { name: input.name } : {}),
        path: path.relative(this.socratesHome, resolved.path).replaceAll(path.sep, "/"),
        changed: result.applied,
        actionId: result.actionId,
        status: result.applied ? "applied" : "rejected",
        ...(section ? { section } : {}),
        ...(result.error ? { warnings: [result.error] } : {}),
        truncation: truncationFor(result.error ?? "", DEFAULT_CHAR_LIMIT),
      }
    }
    const result = this.applyPrimaryPatch(GLOBAL_MEMORY_AGENT_PROJECT_ID, context.jobId, context.turnId, resolved.targetKind, resolved.path, patch, input.sectionId)
    const index = result.applied ? this.indexMemoryDocFile(resolved.path, editFilesMemoryDocProfile(resolved, this.socratesHome)) : undefined
    const section = index && input.sectionId ? findMemoryDocSection(index, input.sectionId) : undefined
    return {
      target: input.target,
      ...(input.name ? { name: input.name } : {}),
      path: path.relative(this.socratesHome, resolved.path).replaceAll(path.sep, "/"),
      changed: result.applied,
      actionId: result.actionId,
      status: result.applied ? "applied" : "rejected",
      diff: simpleDiff(input.oldText ?? "", input.newText),
      ...(section ? { section } : {}),
      ...(result.error ? { warnings: [result.error] } : {}),
      truncation: truncationFor(result.error ?? "", DEFAULT_CHAR_LIMIT),
    }
  }

  private proposeSkillWrite(
    input: EditFilesToolInput,
    resolved: ResolvedEditFilesTarget,
    context: { jobId: string; turnId?: string },
  ): EditFilesToolOutput {
    const targetPath = resolved.path
    const name = path.basename(path.dirname(targetPath))
    const scope = resolved.scope ?? "global"
    const operation = input.editMode === "create" ? "create" : "update"
    const patch: MemoryPatchProposal = {
      oldText: input.editMode === "create" ? "" : input.oldText ?? "",
      newText: input.newText,
      ...(input.rationale ? { rationale: input.rationale } : {}),
      ...(input.sourceTurnIds ? { sourceTurnIds: input.sourceTurnIds } : {}),
    }
    const action = this.createMemoryAction(scope === "project" ? resolved.projectId ?? GLOBAL_MEMORY_AGENT_PROJECT_ID : GLOBAL_MEMORY_AGENT_PROJECT_ID, context.jobId, context.turnId, "skill_request", targetPath, patch, false, {
      scope,
      operation,
      skillName: name,
      ...(resolved.projectName ? { projectName: resolved.projectName } : {}),
      ...(resolved.workspacePath ? { workspacePath: resolved.workspacePath } : {}),
    })
    const body = input.rationale?.trim() || truncateInline(input.newText, 180)
    const scopeLabel = scope === "project" ? "project" : "global"
    const readableSkillName = humanizeSkillName(name)
    const notification = this.options.createNotification?.({
      ...(scope === "project" && resolved.projectId ? { projectId: resolved.projectId } : {}),
      ...(context.turnId ? { turnId: context.turnId } : {}),
      type: "memory.skill.proposed",
      title: `Memory Agent proposed ${operation === "create" ? "a new" : "an updated"} ${scopeLabel} skill`,
      body: `${readableSkillName}${resolved.projectName ? ` (${resolved.projectName})` : ""}: ${body}`,
      severity: "info",
      payload: {
        actionId: action.actionId,
        scope,
        operation,
        skillName: name,
        skillTitle: readableSkillName,
        ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
        ...(resolved.projectName ? { projectName: resolved.projectName } : {}),
        request: input.newText,
        ...(input.rationale ? { rationale: input.rationale } : {}),
      },
    })
    this.appendEvent({
      ...(context.turnId ? { turnId: context.turnId } : {}),
      type: "memory.skill.proposed",
      source: "server",
      payload: {
        jobId: context.jobId,
        actionId: action.actionId,
        notificationId: notification?.id,
        scope,
        operation,
        skillName: name,
        skillTitle: readableSkillName,
        ...(resolved.projectId ? { projectId: resolved.projectId } : {}),
        path: skillDisplayPath(scope, this.socratesHome, resolved.workspacePath, targetPath),
      },
    })
    return {
      target: input.target,
      name,
      path: skillDisplayPath(scope, this.socratesHome, resolved.workspacePath, targetPath),
      changed: false,
      actionId: action.actionId,
      status: "proposed",
      warnings: ["Skill proposal created. Approve it from notifications to run the Skill Writer Agent."],
      truncation: truncationFor(input.newText, DEFAULT_CHAR_LIMIT),
    }
  }

  private editFilesPatchForInput(
    input: EditFilesToolInput,
    resolved: ResolvedEditFilesTarget,
  ): MemoryPatchProposal {
    if (!input.sectionId) {
      return {
        oldText: input.oldText ?? "",
        newText: input.newText,
        ...(input.rationale ? { rationale: input.rationale } : {}),
        ...(input.sourceTurnIds ? { sourceTurnIds: input.sourceTurnIds } : {}),
        ...(resolved.document ? { document: resolved.document } : {}),
      }
    }
    if (resolved.targetKind === "skills") {
      throw new SocratesError("edit_files_section_not_supported", "sectionId is not supported for skill targets.", {
        recoverable: true,
        details: { target: input.target, name: input.name },
      })
    }
    const profile = editFilesMemoryDocProfile(resolved, this.socratesHome)
    const sectionId = canonicalMemoryDocSectionId(profile.docType, input.sectionId)
    ensureStructuredMemoryDoc(resolved.path, profile)
    const current = readIfExists(resolved.path) ?? ""
    const currentIndex = this.indexMemoryDocFile(resolved.path, profile)
    const currentSection = findMemoryDocSection(currentIndex, sectionId)
    const next = patchMemoryDocSection(current, profile, sectionId, input.oldText ?? "", input.newText, input.replaceAll)
    const nextSection = findMemoryDocSection(parseMemoryDoc(next, profile), sectionId)
    return {
      oldText: currentSection.content,
      newText: nextSection.content,
      ...(input.rationale ? { rationale: input.rationale } : {}),
      ...(input.sourceTurnIds ? { sourceTurnIds: input.sourceTurnIds } : {}),
      ...(resolved.document ? { document: resolved.document } : {}),
    }
  }

  private createMemoryTarget(
    input: EditFilesToolInput,
    resolved: ResolvedEditFilesTarget,
    context: { jobId: string; turnId?: string },
  ): EditFilesToolOutput {
    const patch: MemoryPatchProposal = {
      oldText: "",
      newText: input.newText,
      ...(input.rationale ? { rationale: input.rationale } : {}),
      ...(input.sourceTurnIds ? { sourceTurnIds: input.sourceTurnIds } : {}),
      ...(resolved.document ? { document: resolved.document } : {}),
    }
    const action = this.createMemoryAction(GLOBAL_MEMORY_AGENT_PROJECT_ID, context.jobId, context.turnId, resolved.targetKind, resolved.path, patch, false)
    const current = readIfExists(resolved.path) ?? ""
    if (resolved.targetKind === "soul" || resolved.targetKind === "user_profile") {
      const error = `${resolved.targetKind === "soul" ? "Soul documents" : "user_profile.md"} already exists and must be edited with editMode="replace".`
      this.rejectMemoryAction(action.actionId, error)
      return this.rejectedEditFilesOutput(input, resolved.path, action.actionId, error)
    }
    if (current.trim()) {
      const error = "Target already exists. Read it and use editMode=\"replace\"."
      this.rejectMemoryAction(action.actionId, error)
      return this.rejectedEditFilesOutput(input, resolved.path, action.actionId, error)
    }
    if (resolved.targetKind === "skills") {
      const parsed = parseSkillMarkdown(input.newText, resolved.path)
      const expectedName = path.basename(path.dirname(resolved.path))
      if (!parsed || parsed.name !== expectedName) {
        const error = "Skill creation must produce valid SKILL.md frontmatter whose name matches the skill folder."
        this.rejectMemoryAction(action.actionId, error)
        return this.rejectedEditFilesOutput(input, resolved.path, action.actionId, error)
      }
    }
    fs.mkdirSync(path.dirname(resolved.path), { recursive: true })
    fs.writeFileSync(resolved.path, input.newText)
    let finalContent = readIfExists(resolved.path) ?? input.newText
    this.handle.db
      .update(memoryAgentActions)
      .set({ status: "applied", afterHash: hashText(finalContent), appliedAt: nowIso() })
      .where(eq(memoryAgentActions.id, action.actionId))
      .run()
    return {
      target: input.target,
      ...(input.name ? { name: input.name } : {}),
      path: path.relative(this.socratesHome, resolved.path).replaceAll(path.sep, "/"),
      changed: true,
      actionId: action.actionId,
      status: "applied",
      diff: simpleDiff("", finalContent),
      truncation: truncationFor(finalContent, DEFAULT_CHAR_LIMIT),
    }
  }

  private rejectedEditFilesOutput(input: EditFilesToolInput, targetPath: string, actionId: string, error: string): EditFilesToolOutput {
    return {
      target: input.target,
      ...(input.name ? { name: input.name } : {}),
      path: path.relative(this.socratesHome, targetPath).replaceAll(path.sep, "/"),
      changed: false,
      actionId,
      status: "rejected",
      warnings: [error],
      truncation: truncationFor(error, DEFAULT_CHAR_LIMIT),
    }
  }

  private resolveEditFilesTarget(input: EditFilesToolInput, context?: { turnId?: string }): ResolvedEditFilesTarget {
    if (input.target === "identity") {
      return { path: this.soulPath(), targetKind: "soul", document: "identity" }
    }
    if (input.target === "user_profile") {
      return { path: this.userProfilePath(), targetKind: "user_profile" }
    }
    const skillName = slugSkillName(input.name ?? "general")
    const source = this.skillProposalSource(input.sourceTurnIds?.[0] ?? context?.turnId)
    const scope = input.scope ?? (source?.workspacePath ? "project" : "global")
    if (scope === "project") {
      if (!source?.workspacePath || !source.projectId) {
        throw new SocratesError("memory_skill_project_source_missing", "Project skill proposals require a source project workspace. Choose scope=\"global\" only if the skill is truly cross-project.", {
          recoverable: true,
          details: { name: input.name, sourceTurnIds: input.sourceTurnIds },
        })
      }
      return {
        path: safeJoin(path.join(source.workspacePath, ".socrates", "skills"), `${skillName}/SKILL.md`),
        targetKind: "skills",
        scope: "project",
        projectId: source.projectId,
        ...(source.projectName ? { projectName: source.projectName } : {}),
        workspacePath: source.workspacePath,
      }
    }
    return { path: safeJoin(path.join(this.socratesHome, "skills"), `${skillName}/SKILL.md`), targetKind: "skills", scope: "global" }
  }

  private skillProposalSource(turnId: string | undefined): { projectId?: string; projectName?: string; workspacePath?: string } | undefined {
    if (!turnId) {
      return undefined
    }
    const turn = this.handle.db.select().from(turns).where(eq(turns.id, turnId)).limit(1).get()
    if (!turn?.sessionId) {
      return undefined
    }
    const sessionRow = this.handle.sqlite
      .prepare(
        `SELECT s.project_id AS projectId, s.workspace_path AS sessionWorkspacePath, p.name AS projectName
           FROM sessions s
           LEFT JOIN projects p ON p.id = s.project_id
          WHERE s.id = ?
          LIMIT 1`,
      )
      .get(turn.sessionId) as { projectId?: string; sessionWorkspacePath?: string | null; projectName?: string | null } | undefined
    if (!sessionRow?.projectId) {
      return undefined
    }
    const workspace = this.handle.db
      .select()
      .from(projectWorkspaces)
      .where(and(eq(projectWorkspaces.projectId, sessionRow.projectId), eq(projectWorkspaces.isPrimary, true)))
      .limit(1)
      .get()
    const workspacePath = sessionRow.sessionWorkspacePath ?? workspace?.path ?? undefined
    return {
      projectId: sessionRow.projectId,
      ...(sessionRow.projectName ? { projectName: sessionRow.projectName } : {}),
      ...(workspacePath ? { workspacePath } : {}),
    }
  }

  private mustGetMemoryAgentJob(jobId: string): typeof memoryAgentJobs.$inferSelect {
    const row = this.handle.db.select().from(memoryAgentJobs).where(eq(memoryAgentJobs.id, jobId)).limit(1).get()
    if (!row) {
      throw new SocratesError("memory_agent_job_not_found", "Memory agent job was not found.", { details: { jobId } })
    }
    return row
  }

  private mustGetMemoryNote(noteNumber: number): typeof memoryNotes.$inferSelect {
    const row = this.handle.db.select().from(memoryNotes).where(eq(memoryNotes.noteNumber, noteNumber)).limit(1).get()
    if (!row) {
      throw new SocratesError("memory_note_not_found", "Memory note was not found.", { recoverable: true, details: { noteNumber } })
    }
    return row
  }

  private openMemoryNoteCount(): number {
    const row = this.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_notes WHERE status IN ('open', 'processing')").get() as { count: number }
    return row.count
  }

  private memoryNoteCountForTurn(turnId: string): number {
    const row = this.handle.sqlite
      .prepare("SELECT COUNT(*) AS count FROM memory_notes WHERE turn_id = ? AND created_by_agent = 'socrates'")
      .get(turnId) as { count: number }
    return row.count
  }

  private openMemoryNoteRows(limit: number): Array<typeof memoryNotes.$inferSelect> {
    return this.handle.db
      .select()
      .from(memoryNotes)
      .where(or(eq(memoryNotes.status, "open"), eq(memoryNotes.status, "processing")))
      .orderBy(memoryNotes.noteNumber)
      .limit(limit)
      .all()
  }

  private memoryNoteToolRow(row: typeof memoryNotes.$inferSelect, includeFull: boolean): MemoryNotesToolOutput["notes"][number] {
    const metadata = parseJsonObject(row.metadataJson)
    const defaultSkillScope = metadata.defaultSkillScope === "global" || metadata.defaultSkillScope === "project" ? metadata.defaultSkillScope : undefined
    const projectName = typeof metadata.projectName === "string" ? metadata.projectName : undefined
    const workspacePath = typeof metadata.workspacePath === "string" ? metadata.workspacePath : undefined
    return {
      noteNumber: row.noteNumber,
      status: row.status as MemoryNotesToolOutput["notes"][number]["status"],
      importance: row.priority === "high" ? "high" : "normal",
      ...(includeFull ? { note: row.note } : { notePreview: truncateInline(row.note, 250) }),
      ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(projectName ? { projectName } : {}),
      ...(defaultSkillScope ? { defaultSkillScope } : {}),
      ...(workspacePath ? { workspacePath } : {}),
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      ...(row.turnId ? { turnId: row.turnId } : {}),
      ...(row.messageId ? { messageId: row.messageId } : {}),
      ...(row.messageExcerpt ? { messageExcerpt: row.messageExcerpt } : {}),
      ...(isMemoryNoteOutcome(row.outcome) ? { outcome: row.outcome } : {}),
      ...(row.resolution ? { resolution: row.resolution } : {}),
      createdAt: row.createdAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    }
  }

  private mustGetMemoryAgentCheck(checkId: string): typeof memoryAgentChecks.$inferSelect {
    const row = this.handle.db.select().from(memoryAgentChecks).where(eq(memoryAgentChecks.id, checkId)).limit(1).get()
    if (!row) {
      throw new SocratesError("memory_agent_check_not_found", "Memory agent check was not found.", { details: { checkId } })
    }
    return row
  }

  private countMemoryAgentTimelineItems(): number {
    const jobs = this.handle.sqlite
      .prepare("SELECT COUNT(*) AS count FROM memory_agent_jobs WHERE project_id = ?")
      .get(GLOBAL_MEMORY_AGENT_PROJECT_ID) as { count: number }
    const checks = this.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM memory_agent_checks").get() as { count: number }
    return jobs.count + checks.count
  }

  private memoryAgentTimelineItem(row: typeof memoryAgentJobs.$inferSelect): MemoryAgentTimelineItem {
    const metadata = parseJsonObject(row.metadataJson)
    const evidenceTurnIds = parseJsonArray(row.evidenceTurnIdsJson)
    const usage = usageFromMetadata(metadata)
    const actionRows = this.handle.db
      .select()
      .from(memoryAgentActions)
      .where(eq(memoryAgentActions.jobId, row.id))
      .orderBy(memoryAgentActions.createdAt)
      .all()
    const actionText = actionRows.length === 0 ? "" : `${actionRows.length} memory ${actionRows.length === 1 ? "action" : "actions"}`
    const title = row.status === "running" ? "Memory run in progress" : actionText || "Memory run"
    const displayReason =
      typeof metadata.signal === "object" && metadata.signal && "displayReason" in metadata.signal
        ? String((metadata.signal as { displayReason?: unknown }).displayReason ?? "")
        : ""
    return {
      id: row.id,
      itemType: "run",
      runId: row.id,
      status: row.status as MemoryAgentTimelineItem["status"],
      trigger: row.trigger as MemoryAgentTimelineItem["trigger"],
      title,
      ...(displayReason ? { displayReason } : {}),
      providerId: row.providerId as MemoryAgentTimelineItem["providerId"],
      modelId: row.modelId,
      evidenceTurnCount: evidenceTurnIds.length,
      evidenceTokensEstimate: row.evidenceTokensEstimate,
      startedAt: row.startedAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      ...(typeof metadata.sequenceFrom === "number" ? { sequenceFrom: metadata.sequenceFrom } : {}),
      ...(typeof metadata.sequenceTo === "number" ? { sequenceTo: metadata.sequenceTo } : {}),
      ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
    }
  }

  private memoryAgentCheckTimelineItem(row: typeof memoryAgentChecks.$inferSelect): MemoryAgentTimelineItem {
    return {
      id: row.id,
      itemType: "check",
      checkId: row.id,
      status: row.status as MemoryAgentTimelineItem["status"],
      trigger: row.trigger as MemoryAgentTimelineItem["trigger"],
      title: row.turnCount > 0 ? "Memory check" : "Heartbeat check",
      displayReason: row.reason,
      checkedAt: row.checkedAt,
      ...(row.sequenceFrom ? { sequenceFrom: row.sequenceFrom } : {}),
      sequenceTo: row.sequenceTo,
      evidenceTurnCount: row.turnCount,
      evidenceTokensEstimate: row.totalTokens,
      totalTokens: row.totalTokens,
    }
  }

  private memoryAgentRunDetail(row: typeof memoryAgentJobs.$inferSelect): MemoryAgentRunDetail {
    const metadata = parseJsonObject(row.metadataJson)
    const output = parseJsonObject(row.outputJson)
    const timelineItem = this.memoryAgentTimelineItem(row)
    const actionRows = this.handle.db
      .select()
      .from(memoryAgentActions)
      .where(eq(memoryAgentActions.jobId, row.id))
      .orderBy(memoryAgentActions.createdAt)
      .all()
    const summary = isMemoryAgentSummary(output.summary) ? output.summary : emptyMemoryAgentSummary()
    return {
      ...timelineItem,
      itemType: "run",
      providerId: row.providerId as MemoryAgentRunDetail["providerId"],
      modelId: row.modelId,
      summary,
      toolEvents: Array.isArray(metadata.toolEvents) ? metadata.toolEvents : [],
      ...(typeof metadata.error === "string" ? { error: metadata.error } : {}),
      actions: actionRows.map((action) => ({
        id: action.id,
        jobId: action.jobId,
        targetKind: action.targetKind,
        targetPath: action.targetPath,
        status: action.status,
        requiresConfirmation: action.requiresConfirmation,
        ...(action.rationale ? { rationale: action.rationale } : {}),
        ...(action.error ? { error: action.error } : {}),
        createdAt: action.createdAt,
        ...(action.appliedAt ? { appliedAt: action.appliedAt } : {}),
      })),
    }
  }

  private listSkillsOutput(input: SkillsToolInput, workspacePath: string | undefined): SkillsToolOutput {
    const skills = this.skillInfos(workspacePath, input.scope).map(skillSummary)
    const offset = input.offset ?? 0
    const limit = input.n ?? input.limit ?? DEFAULT_SEARCH_LIMIT
    const sliced = skills.slice(offset, offset + limit)
    return {
      operation: "list",
      skills: sliced,
      totalMatches: skills.length,
      truncation: {
        truncated: offset + limit < skills.length,
        charLimit: input.charLimit ?? SKILL_CHAR_LIMIT,
        originalLength: JSON.stringify(skills).length,
        returnedLength: JSON.stringify(sliced).length,
        ...(offset + limit < skills.length ? { nextOffset: offset + limit } : {}),
      },
      usageHint: 'Prefer skills({ operation: "describe", id: "<exact-listed-id>" }). Use name only if matching an exact listed name, and do not put a display name in id.',
    }
  }

  private searchSkills(input: SkillsToolInput, workspacePath: string | undefined): SkillsToolOutput {
    const query = input.query?.trim() ?? ""
    const compiled = compileSearch(query, "keyword_any")
    const matches = this.skillInfos(workspacePath, input.scope).filter((skill) => compiled.score(`${skill.name}\n${skill.description}\n${skill.content}`) > 0)
    const offset = input.offset ?? 0
    const limit = input.n ?? input.limit ?? DEFAULT_SEARCH_LIMIT
    const sliced = matches.slice(offset, offset + limit).map(skillSummary)
    return {
      operation: "search",
      skills: sliced,
      totalMatches: matches.length,
      truncation: {
        truncated: offset + limit < matches.length,
        charLimit: input.charLimit ?? SKILL_CHAR_LIMIT,
        originalLength: JSON.stringify(matches.map(skillSummary)).length,
        returnedLength: JSON.stringify(sliced).length,
        ...(offset + limit < matches.length ? { nextOffset: offset + limit } : {}),
      },
      usageHint: 'Prefer skills({ operation: "describe", id: "<exact-listed-id>" }). Use name only if matching an exact listed name, and do not put a display name in id.',
    }
  }

  private readSkill(input: SkillsToolInput, workspacePath: string | undefined): SkillsToolOutput {
    const skill = this.findSkillByHandle(workspacePath, input, input.scope)
    if (!skill) {
      const available = this.skillInfos(workspacePath, input.scope)
        .slice(0, 15)
        .map((item) => ({ id: item.name, name: item.name, scope: item.scope, description: item.description }))
      throw new SocratesError("skill_not_found", "Skill was not found. Call skills({ operation: \"list\" }) to see exact skill ids and names, then retry describe with one of those exact handles.", {
        recoverable: true,
        details: { id: input.id, name: input.name, scope: input.scope, available },
      })
    }
    const relativePath = input.path?.replaceAll("\\", "/").replace(/^\/+/, "") || "SKILL.md"
    const targetPath = relativePath === "SKILL.md" ? skill.skillFile : safeJoin(skill.skillDir, relativePath)
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
      throw new SocratesError("skill_file_not_found", "Skill file was not found.", { recoverable: true, details: { name: skill.name, path: input.path } })
    }
    const content = fs.readFileSync(targetPath, "utf8")
    const charLimit = input.charLimit ?? SKILL_CHAR_LIMIT
    const truncated = truncate(content, charLimit)
    return {
      operation: input.operation === "describe" ? "describe" : "read",
      skills: [skillSummary(skill)],
      content: truncated.text,
      path: path.relative(skill.root, targetPath).replaceAll(path.sep, "/"),
      totalMatches: 1,
      truncation: truncationFor(content, charLimit),
      usageHint: "Follow this skill's instructions for the current task. If the skill references relative files, use normal workspace/resource tools only when those files are needed.",
    }
  }

  private skillInfos(workspacePath: string | undefined, scope?: SkillScope): SkillInfo[] {
    const groups: Array<{ scope: SkillScope; root: string }> = [
      { scope: "builtin", root: bundledSkillsDir() },
      { scope: "global", root: path.join(this.socratesHome, "skills") },
      ...(workspacePath ? [{ scope: "project" as const, root: path.join(workspacePath, ".socrates", "skills") }] : []),
    ]
    return groups
      .filter((group) => (scope ? group.scope === scope : true))
      .flatMap((group) => discoverSkills(group.scope, group.root))
      .filter((skill) => !(skill.scope === "builtin" && INTERNAL_BUILTIN_SKILL_NAMES.has(skill.name)))
      .sort((left, right) => `${left.scope}:${left.name}`.localeCompare(`${right.scope}:${right.name}`))
  }

  private findSkillByHandle(workspacePath: string | undefined, input: Pick<SkillsToolInput, "id" | "name">, scope?: SkillScope): SkillInfo | undefined {
    const skills = this.skillInfos(workspacePath, scope)
    const id = input.id?.trim()
    if (id) {
      const byId = skills.find((skill) => skill.name === id)
      if (byId) return byId
    }
    const name = input.name?.trim()
    if (name) {
      return skills.find((skill) => skill.name === name)
    }
    return undefined
  }

  private availableExplicitSkillName(root: string, name: string): string {
    if (!isValidSkillName(name)) {
      throw new SocratesError("skill_name_invalid", "Skill name must use lowercase letters, numbers, and hyphens.", {
        details: { name },
        recoverable: true,
      })
    }
    if (fs.existsSync(path.join(root, name))) {
      throw new SocratesError("skill_already_exists", "A skill with that name already exists.", {
        details: { name },
        recoverable: true,
      })
    }
    return name
  }

  private deleteSkillFromRoot(scope: Exclude<SkillScope, "builtin">, root: string, name: string): SkillSummary {
    if (!isValidSkillName(name)) {
      throw new SocratesError("skill_name_invalid", "Skill name must use lowercase letters, numbers, and hyphens.", {
        details: { name, scope },
        recoverable: true,
      })
    }
    const expectedDir = path.join(root, name)
    const expectedFile = path.join(expectedDir, "SKILL.md")
    const skill = readSkillInfo(scope, root, expectedFile)
    if (!skill) {
      throw new SocratesError("skill_not_found", "Skill was not found.", { details: { name, scope }, recoverable: true })
    }
    if (skill.skillDir !== expectedDir) {
      throw new SocratesError("skill_path_invalid", "Skill path did not resolve to the expected skill directory.", {
        details: { name, scope },
        recoverable: true,
      })
    }
    fs.rmSync(skill.skillDir, { recursive: true, force: false })
    return skillSummary(skill)
  }

  private projectRoot(projectId: string): string {
    return path.join(this.socratesHome, "projects", projectId)
  }

  private soulPath(): string {
    return path.join(this.socratesHome, "identity.md")
  }

  private userProfilePath(): string {
    return path.join(this.socratesHome, "user_profile.md")
  }

  private indexMemoryDocFile(filePath: string, profile: MemoryDocProfile): MemoryDocIndex {
    const index = parseMemoryDoc(fs.readFileSync(filePath, "utf8"), profile)
    return this.replaceMemoryDocIndex(index)
  }

  private replaceMemoryDocIndex(index: MemoryDocIndex): MemoryDocIndex {
    const indexedAt = nowIso()
    const projectKey = index.projectId ?? GLOBAL_MEMORY_AGENT_PROJECT_ID
    const existingRows = this.handle.db
      .select()
      .from(memoryDocIndexes)
      .where(and(eq(memoryDocIndexes.scope, index.scope), eq(memoryDocIndexes.projectId, projectKey), eq(memoryDocIndexes.path, index.path)))
      .all()
    for (const row of existingRows) {
      this.handle.db.delete(memoryDocSections).where(eq(memoryDocSections.docIndexId, row.id)).run()
      this.handle.db.delete(memoryDocIndexes).where(eq(memoryDocIndexes.id, row.id)).run()
    }
    const docIndexId = createId("mdoc")
    this.handle.db
      .insert(memoryDocIndexes)
      .values({
        id: docIndexId,
        scope: index.scope,
        projectId: projectKey,
        path: index.path,
        docType: index.docType,
        ownerTool: index.ownerTool,
        schemaVersion: index.schemaVersion,
        contentHash: index.contentHash,
        sectionCount: index.sections.length,
        indexedAt,
        metadataJson: JSON.stringify({ warnings: index.warnings ?? [] }),
      })
      .run()
    for (const section of index.sections) {
      this.handle.db
        .insert(memoryDocSections)
        .values({
          id: createId("mdsec"),
          docIndexId,
          scope: index.scope,
          projectId: projectKey,
          path: index.path,
          docType: index.docType,
          sectionId: section.sectionId,
          kind: section.kind,
          tagsJson: JSON.stringify(section.tags),
          heading: section.heading,
          lineStart: section.lineStart,
          lineEnd: section.lineEnd,
          contentHash: section.contentHash,
          summary: section.summary,
          tokenEstimate: section.tokenEstimate,
          updatedAt: indexedAt,
          metadataJson: JSON.stringify({}),
        })
        .run()
    }
    return index
  }

  private skillWriterModelSettingsFor(): SkillWriterModelSettings {
    const settings = this.options.getWorkerModelSettings?.("skill_writer")
    if (settings) {
      return {
        providerId: settings.providerId,
        authMode: settings.authMode ?? "api_key",
        modelId: settings.modelId,
        thinkingEnabled: settings.thinkingEnabled,
        ...(settings.thinkingEffort ? { thinkingEffort: settings.thinkingEffort } : {}),
      }
    }
    return {
      providerId: "openrouter",
      modelId: "xiaomi/mimo-v2.5-pro",
      thinkingEnabled: false,
    }
  }

  private async runApprovedSkillWriterTask(input: ApprovedSkillWriterTask): Promise<SkillSummary> {
    if (!this.options.provider) {
      throw new SocratesError("skill_writer_provider_unavailable", "Skill Writer Agent requires a configured model provider.", { recoverable: true })
    }
    if (!isValidSkillName(input.name)) {
      throw new SocratesError("skill_name_invalid", "Skill name must use lowercase letters, numbers, and hyphens.", {
        recoverable: true,
        details: { name: input.name },
      })
    }
    if (input.scope === "project" && !input.workspacePath) {
      throw new SocratesError("skill_writer_project_workspace_missing", "Project skill writing requires a workspace path.", { recoverable: true, details: { projectId: input.projectId } })
    }

    const modelSettings: SkillWriterModelSettings = this.skillWriterModelSettingsFor()
    const jobId = createId("skjob")
    const startedAt = nowIso()
    const metadataBase = {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      thinkingEnabled: modelSettings.thinkingEnabled,
      thinkingEffort: modelSettings.thinkingEffort,
    }
    this.handle.db
      .insert(skillWriterJobs)
      .values({
        id: jobId,
        scope: input.scope,
        operation: input.operation,
        skillName: input.name,
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        status: "running",
        providerId: modelSettings.providerId,
        modelId: modelSettings.modelId,
        startedAt,
        metadataJson: JSON.stringify(metadataBase),
      })
      .run()
    this.appendEvent({
      ...(input.projectId !== GLOBAL_MEMORY_AGENT_PROJECT_ID ? { projectId: input.projectId } : {}),
      ...scopedIds(input),
      type: "memory.skill_writer.started",
      source: "server",
      payload: { jobId, scope: input.scope, operation: input.operation, skillName: input.name, sourceKind: input.sourceKind, sourceId: input.sourceId },
    })

    const toolEvents: unknown[] = []
    let latestUsage: unknown
    let written: SkillWriteToolOutput | undefined
    try {
      const contextCompressorSettings = this.options.getWorkerModelSettings?.("context_compactor")
      const answer = await runSkillWriterTurn({
        provider: this.options.provider,
        modelSettings,
        scope: input.scope,
        operation: input.operation,
        name: input.name,
        request: input.request,
        projectId: input.projectId,
        conversationId: input.conversationId ?? "",
        sessionId: input.sessionId ?? "",
        turnId: input.turnId ?? "",
        ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
        socratesHome: this.socratesHome,
        ...(contextCompressorSettings ? { contextCompressorSettings } : {}),
        tools: {
          traceRetrieve: async (toolInput) => {
            if (input.scope === "project" && input.conversationId && this.options.traceRetrieve) {
              return this.options.traceRetrieve(input.projectId, input.conversationId, toolInput)
            }
            if (this.options.traceRetrieveGlobal) {
              return this.options.traceRetrieveGlobal(toolInput)
            }
            throw new SocratesError("skill_writer_trace_unavailable", "trace_retrieve is not available to this Skill Writer run.", { recoverable: true })
          },
          skills: async (toolInput) => this.runSkillsTool(input.projectId, input.workspacePath, toolInput),
          soul: async (toolInput) => this.runSoulTool(input.projectId, input.workspacePath, toolInput),
          userProfile: async (toolInput) => this.runUserProfileTool(input.projectId, input.workspacePath, toolInput),
          projectDocs: async (toolInput) => {
            if (!input.workspacePath) {
              throw new SocratesError("skill_writer_project_docs_unavailable", "project_docs is only available for project skill runs.", { recoverable: true })
            }
            this.assertSkillWriterProjectDocsReadOnly(toolInput)
            return this.runProjectDocsTool(input.projectId, input.workspacePath, toolInput)
          },
          repoDocs: async (toolInput) => {
            if (!input.workspacePath) {
              throw new SocratesError("skill_writer_repo_docs_unavailable", "repo_docs is only available for project skill runs.", { recoverable: true })
            }
            this.assertSkillWriterRepoDocsReadOnly(toolInput)
            return this.runRepoDocsTool(input.projectId, input.workspacePath, toolInput)
          },
          skillWrite: async (toolInput) => {
            if (written) {
              throw new SocratesError("skill_write_already_completed", "Skill Writer already wrote the skill for this run.", { recoverable: true })
            }
            written = this.runSkillWriteTool(toolInput, {
              expectedScope: input.scope,
              expectedOperation: input.operation,
              expectedName: input.name,
              ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
            })
            return written
          },
        },
        onEvent: (event) => {
          if ((event.type === "model.usage" || event.type === "model.completed") && "usage" in event && event.usage) {
            latestUsage = event.usage
          }
          if (event.type.startsWith("tool.call") || event.type.startsWith("approval.")) {
            toolEvents.push(slimMemoryToolEvent(event))
          }
        },
      })
      if (!written) {
        throw new SocratesError("skill_writer_no_write", "Skill Writer finished without calling skill_write.", { recoverable: true })
      }
      const completedAt = nowIso()
      this.handle.db
        .update(skillWriterJobs)
        .set({
          status: "completed",
          outputJson: JSON.stringify({ skill: written.summary, answer: answer.trim() }),
          completedAt,
          metadataJson: JSON.stringify({ ...metadataBase, toolEvents, usage: latestUsage }),
        })
        .where(eq(skillWriterJobs.id, jobId))
        .run()
      this.appendEvent({
        ...(input.projectId !== GLOBAL_MEMORY_AGENT_PROJECT_ID ? { projectId: input.projectId } : {}),
        ...scopedIds(input),
        type: "memory.skill.updated",
        source: "server",
        payload: {
          jobId,
          scope: input.scope,
          operation: input.operation,
          skillName: input.name,
          path: written.path,
          sourceKind: input.sourceKind,
          sourceId: input.sourceId,
        },
      })
      return written.summary
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const completedAt = nowIso()
      this.handle.db
        .update(skillWriterJobs)
        .set({
          status: "failed",
          error: message,
          completedAt,
          metadataJson: JSON.stringify({ ...metadataBase, toolEvents, usage: latestUsage, error: message }),
        })
        .where(eq(skillWriterJobs.id, jobId))
        .run()
      this.appendEvent({
        ...(input.projectId !== GLOBAL_MEMORY_AGENT_PROJECT_ID ? { projectId: input.projectId } : {}),
        ...scopedIds(input),
        type: "memory.skill_writer.failed",
        source: "server",
        payload: { jobId, scope: input.scope, operation: input.operation, skillName: input.name, error: { code: "skill_writer_failed", message } },
      })
      throw error
    }
  }

  private runSkillWriteTool(
    input: SkillWriteToolInput,
    constraints: { expectedScope: WritableSkillScope; expectedOperation: "create" | "update"; expectedName: string; workspacePath?: string },
  ): SkillWriteToolOutput {
    if (input.scope !== constraints.expectedScope || input.operation !== constraints.expectedOperation || input.name !== constraints.expectedName) {
      throw new SocratesError("skill_write_scope_mismatch", "skill_write must match the approved scope, operation, and skill name.", {
        recoverable: true,
        details: {
          approved: { scope: constraints.expectedScope, operation: constraints.expectedOperation, name: constraints.expectedName },
          received: { scope: input.scope, operation: input.operation, name: input.name },
        },
      })
    }
    if (!isValidSkillName(input.name)) {
      throw new SocratesError("skill_name_invalid", "Skill name must use lowercase letters, numbers, and hyphens.", { recoverable: true, details: { name: input.name } })
    }
    if (input.scope === "project" && !constraints.workspacePath) {
      throw new SocratesError("skill_write_project_workspace_missing", "Project skill writing requires a workspace path.", { recoverable: true })
    }
    const root = input.scope === "global" ? path.join(this.socratesHome, "skills") : path.join(constraints.workspacePath as string, ".socrates", "skills")
    const skillFile = safeJoin(root, `${input.name}/SKILL.md`)
    const existed = fs.existsSync(skillFile)
    if (input.operation === "create" && existed) {
      throw new SocratesError("skill_already_exists", "A skill with that name already exists.", { recoverable: true, details: { name: input.name, scope: input.scope } })
    }
    if (input.operation === "update" && !existed) {
      throw new SocratesError("skill_not_found", "Cannot update a skill that does not exist.", { recoverable: true, details: { name: input.name, scope: input.scope } })
    }
    const parsed = parseSkillMarkdown(input.content, skillFile)
    if (!parsed || parsed.name !== input.name) {
      throw new SocratesError("skill_write_invalid_markdown", "skill_write content must be a valid SKILL.md with matching frontmatter name.", {
        recoverable: true,
        details: { name: input.name, scope: input.scope },
      })
    }
    const before = readIfExists(skillFile)
    fs.mkdirSync(path.dirname(skillFile), { recursive: true })
    if (before !== input.content) {
      fs.writeFileSync(skillFile, input.content)
    }
    const info = readSkillInfo(input.scope, root, skillFile)
    if (!info) {
      throw new SocratesError("skill_write_validation_failed", "Written skill did not pass validation.", { recoverable: true, details: { name: input.name, scope: input.scope } })
    }
    const displayRoot = input.scope === "global" ? this.socratesHome : constraints.workspacePath as string
    return {
      scope: input.scope,
      operation: input.operation,
      name: input.name,
      path: path.relative(displayRoot, skillFile).replaceAll(path.sep, "/"),
      changed: before !== input.content,
      summary: skillSummary(info),
      truncation: truncationFor(input.content, DEFAULT_CHAR_LIMIT),
    }
  }

  private assertSkillWriterProjectDocsReadOnly(input: ProjectDocsToolInput): void {
    if (input.operation === "edit" || input.operation === "patch_section") {
      throw new SocratesError("skill_writer_project_docs_read_only", "Skill Writer may read project_docs but cannot write them.", { recoverable: true, details: { operation: input.operation } })
    }
  }

  private assertSkillWriterRepoDocsReadOnly(input: RepoDocsToolInput): void {
    if (input.operation === "edit" || input.operation === "patch_section") {
      throw new SocratesError("skill_writer_repo_docs_read_only", "Skill Writer may read repo_docs but cannot write them.", { recoverable: true, details: { operation: input.operation } })
    }
  }

  private applyPrimaryPatch(
    projectId: string,
    jobId: string,
    turnId: string | undefined,
    targetKind: "user_profile",
    targetPath: string,
    patch: MemoryPatchProposal,
    lastEditedSection?: string,
  ): { applied: boolean; actionId: string; error?: string } {
    const action = this.createMemoryAction(projectId, jobId, turnId, targetKind, targetPath, patch, false)
    const current = readIfExists(targetPath) ?? ""
    const validation = validateMemoryPatch(current, patch)
    if (!validation.ok) {
      this.rejectMemoryAction(action.actionId, validation.error)
      this.appendEvent({ projectId, ...(turnId ? { turnId } : {}), type: "memory.primary.update_rejected", source: "server", payload: { jobId, actionId: action.actionId, path: targetPath, reason: validation.error } })
      return { applied: false, actionId: action.actionId, error: validation.error }
    }
    const next = stampMemoryDocFrontmatter(validation.next, {
      updatedAt: currentRuntimeTime().currentDateTime,
      updatedBy: "edit_files",
      lastEditedSection: lastEditedSection ?? "document",
    })
    fs.writeFileSync(targetPath, next)
    const afterHash = hashText(next)
    this.handle.db.update(memoryAgentActions).set({ status: "applied", afterHash, appliedAt: nowIso() }).where(eq(memoryAgentActions.id, action.actionId)).run()
    const notification = this.options.createNotification?.({
      projectId,
      ...(turnId ? { turnId } : {}),
      type: "memory.user_profile.updated",
      title: "User profile updated",
      body: "user_profile was updated by the backend memory agent.",
      severity: "info",
      payload: {
        jobId,
        actionId: action.actionId,
        document: "user_profile",
        path: "primary/user_profile.md",
        rationale: patch.rationale,
        diff: simpleDiff(patch.oldText ?? "", patch.newText ?? ""),
      },
    })
    this.appendEvent({
      projectId,
      ...(turnId ? { turnId } : {}),
      type: "memory.primary.updated",
      source: "server",
      payload: { jobId, actionId: action.actionId, path: targetPath, targetKind, notificationId: notification?.id ?? createId("note"), rationale: patch.rationale },
    })
    return { applied: true, actionId: action.actionId }
  }

  private async applySoulPatch(
    projectId: string,
    jobId: string,
    latest: { conversationId?: string; sessionId?: string; turnId?: string } | undefined,
    patch: MemoryPatchProposal,
    modelSettings: MemoryAgentModelSettings,
    lastEditedSection?: string,
  ): Promise<{ applied: boolean; actionId: string; error?: string }> {
    const document = patch.document ?? "identity"
    const targetPath = this.soulPath()
    const action = this.createMemoryAction(projectId, jobId, latest?.turnId, "soul", targetPath, patch, true)
    if (document !== "identity") {
      const error = "Soul patch must target identity."
      this.rejectMemoryAction(action.actionId, error)
      return { applied: false, actionId: action.actionId, error }
    }
    const current = readIfExists(targetPath) ?? ""
    const preflight = validateMemoryPatch(current, patch)
    if (!preflight.ok) {
      this.rejectMemoryAction(action.actionId, preflight.error)
      return { applied: false, actionId: action.actionId, error: preflight.error }
    }

    const confirmationId = createId("memconf")
    this.handle.db
      .insert(memoryAgentConfirmations)
      .values({
        id: confirmationId,
        jobId,
        actionId: action.actionId,
        projectId,
        document,
        promptText: SOUL_CONFIRMATION_PROMPT,
        providerId: modelSettings.providerId,
        modelId: modelSettings.modelId,
        requestedAt: nowIso(),
        metadataJson: JSON.stringify({ targetPath, rationale: patch.rationale }),
      })
      .run()
    this.handle.db.update(memoryAgentActions).set({ status: "awaiting_confirmation", confirmationId }).where(eq(memoryAgentActions.id, action.actionId)).run()
    this.appendEvent({
      projectId,
      ...scopedIds(latest ?? {}),
      type: "memory.soul.confirmation.requested",
      source: "server",
      payload: { jobId, actionId: action.actionId, confirmationId, document, prompt: SOUL_CONFIRMATION_PROMPT },
    })

    const confirmationText = await this.runSoulConfirmationModel(modelSettings, targetPath, patch)
    const normalized = confirmationText.trim().toLowerCase()
    const decision = normalized === "yes" ? "yes" : normalized === "no" ? "no" : "invalid"
    this.handle.db.update(memoryAgentConfirmations).set({ responseText: confirmationText, decision, decidedAt: nowIso() }).where(eq(memoryAgentConfirmations.id, confirmationId)).run()
    this.appendEvent({
      projectId,
      ...scopedIds(latest ?? {}),
      type: "memory.soul.confirmation.resolved",
      source: "server",
      payload: { jobId, actionId: action.actionId, confirmationId, document, decision },
    })
    if (decision !== "yes") {
      const error = `Soul confirmation returned ${decision}.`
      this.rejectMemoryAction(action.actionId, error)
      return { applied: false, actionId: action.actionId, error }
    }

    const latestContent = readIfExists(targetPath) ?? ""
    const validation = validateMemoryPatch(latestContent, patch)
    if (!validation.ok) {
      this.rejectMemoryAction(action.actionId, validation.error)
      return { applied: false, actionId: action.actionId, error: validation.error }
    }
    const next = stampMemoryDocFrontmatter(validation.next, {
      updatedAt: currentRuntimeTime().currentDateTime,
      updatedBy: "edit_files",
      lastEditedSection: lastEditedSection ?? "document",
    })
    fs.writeFileSync(targetPath, next)
    const afterHash = hashText(next)
    this.handle.db.update(memoryAgentActions).set({ status: "applied", afterHash, appliedAt: nowIso() }).where(eq(memoryAgentActions.id, action.actionId)).run()
    const notification = this.options.createNotification?.({
      projectId,
      ...(latest?.conversationId ? { conversationId: latest.conversationId } : {}),
      ...(latest?.turnId ? { turnId: latest.turnId } : {}),
      type: "memory.soul.updated",
      title: "Socrates soul updated",
      body: `${document.replace("_", " ")} was updated by the backend memory agent.`,
      severity: "info",
      payload: {
        jobId,
        actionId: action.actionId,
        confirmationId,
        document,
        path: `primary/${document}.md`,
        rationale: patch.rationale,
        diff: simpleDiff(patch.oldText ?? "", patch.newText ?? ""),
      },
    })
    this.appendEvent({
      projectId,
      ...scopedIds(latest ?? {}),
      type: "memory.soul.updated",
      source: "server",
      payload: { jobId, actionId: action.actionId, confirmationId, document, path: targetPath, notificationId: notification?.id ?? createId("note"), rationale: patch.rationale },
    })
    return { applied: true, actionId: action.actionId }
  }

  private createMemoryAction(
    projectId: string,
    jobId: string,
    turnId: string | undefined,
    targetKind: "skill_request" | "skills" | "soul" | "user_profile",
    targetPath: string,
    patch: MemoryPatchProposal,
    requiresConfirmation: boolean,
    metadata?: Record<string, unknown>,
  ): { actionId: string; beforeHash: string } {
    const content = readIfExists(targetPath) ?? ""
    const beforeHash = hashText(content)
    const actionId = createId("memact")
    this.handle.db
      .insert(memoryAgentActions)
      .values({
        id: actionId,
        jobId,
        projectId,
        turnId,
        targetKind,
        targetPath,
        status: "proposed",
        requiresConfirmation,
        beforeHash,
        patchJson: JSON.stringify(patch),
        rationale: patch.rationale,
        createdAt: nowIso(),
        ...(metadata ? { metadataJson: JSON.stringify(metadata) } : {}),
      })
      .run()
    return { actionId, beforeHash }
  }

  private rejectMemoryAction(actionId: string, error: string): void {
    this.handle.db.update(memoryAgentActions).set({ status: "rejected", error }).where(eq(memoryAgentActions.id, actionId)).run()
  }

  private async runSoulConfirmationModel(modelSettings: MemoryAgentModelSettings, targetPath: string, patch: MemoryPatchProposal): Promise<string> {
    let text = ""
    for await (const event of this.options.provider!.stream({
      providerId: modelSettings.providerId,
      modelId: modelSettings.modelId,
      system: [
        "You are the Socrates backend memory agent confirming a proposed edit to a core soul document.",
        "Consider the target path, rationale, and exact patch. This is an internal self-confirmation test.",
        "If the edit is evidence-backed, narrow, durable, and appropriate for the identity document, answer yes.",
        "If it is speculative, unsafe, noisy, too broad, or not durable, answer no.",
        `Target path: ${targetPath}`,
        `Rationale: ${patch.rationale ?? ""}`,
        `Old text:\n${patch.oldText ?? ""}`,
        `New text:\n${patch.newText ?? ""}`,
      ].join("\n\n"),
      messages: [{ role: "user", content: SOUL_CONFIRMATION_PROMPT }],
      runtimeConfig: {
        providerId: modelSettings.providerId,
        modelId: modelSettings.modelId,
        thinkingEnabled: modelSettings.thinkingEnabled,
        ...(modelSettings.thinkingEffort ? { thinkingEffort: modelSettings.thinkingEffort } : {}),
        approvalMode: "read_only_auto",
        sandboxMode: "read_only",
      },
    })) {
      if (event.type === "model.answer.delta") {
        text += event.text
      }
      if (event.type === "model.failed") {
        throw event.error
      }
    }
    return text
  }

}

const projectDocPath = (workspacePath: string, area: ProjectDocsArea): string =>
  area === "memory" ? path.join(workspacePath, ".socrates", "MEMORY.md") : path.join(workspacePath, ".socrates", "PROJECT_NOTES.md")
const projectDocRelativePath = (area: ProjectDocsArea): string => (area === "memory" ? ".socrates/MEMORY.md" : ".socrates/PROJECT_NOTES.md")
const projectDocProfile = (projectId: string, area: ProjectDocsArea): MemoryDocProfile => ({
  docType: area === "memory" ? "project_memory" : "project_notes",
  ownerTool: "project_docs",
  scope: "workspace",
  path: projectDocRelativePath(area),
  projectId,
  indexTags: [area === "memory" ? "memory" : "notes", "project"],
})
const repoDocsRoot = (workspacePath: string): string => path.join(workspacePath, ".socrates", "repo_docs")

const repoDocPath = (docsRoot: string, name: (typeof REPO_DOC_NAMES)[number]): string => path.join(docsRoot, name)

const repoDocProfile = (projectId: string, name: string): MemoryDocProfile => ({
  docType: memoryDocTypeForRepoDoc(name),
  ownerTool: "repo_docs",
  scope: "workspace",
  path: `.socrates/repo_docs/${name}`,
  projectId,
  indexTags: ["repo_docs"],
})

const globalMemoryDocProfile = (_socratesHome: string, target: "identity" | "user_profile"): MemoryDocProfile => ({
  docType: target,
  ownerTool: target === "user_profile" ? "user_profile" : "soul",
  scope: "global",
  path: `${target}.md`,
  projectId: GLOBAL_MEMORY_AGENT_PROJECT_ID,
  indexTags: target === "user_profile" ? ["profile"] : ["soul"],
})

const editFilesMemoryDocProfile = (
  resolved: { path: string; targetKind: "skills" | "soul" | "user_profile"; document?: "identity" },
  socratesHome: string,
): MemoryDocProfile => {
  const relativePath = path.relative(socratesHome, resolved.path).replaceAll(path.sep, "/")
  const target = resolved.targetKind === "soul" ? resolved.document ?? "identity" : resolved.targetKind === "user_profile" ? "user_profile" : "skill"
  return {
    docType: memoryDocTypeForEditFilesTarget(target),
    ownerTool: resolved.targetKind,
    scope: "global",
    path: relativePath,
    projectId: GLOBAL_MEMORY_AGENT_PROJECT_ID,
    indexTags: [resolved.targetKind],
  }
}

const findMemoryDocSection = (index: MemoryDocIndex, sectionId: string): MemoryDocSection => {
  const canonicalSectionId = canonicalMemoryDocSectionId(index.docType, sectionId)
  const section = index.sections.find((candidate) => candidate.sectionId === canonicalSectionId)
  if (!section) {
    throw new SocratesError("memory_doc_section_not_found", `Section ${canonicalSectionId} was not found in ${index.path}.`, {
      recoverable: true,
      details: { path: index.path, sectionId: canonicalSectionId, requestedSectionId: sectionId },
    })
  }
  return section
}

const canonicalMemoryDocSectionId = (docType: MemoryDocIndex["docType"], sectionId: string): string => {
  if (docType === "user_profile" && sectionId === "recent_context") {
    return "active_context"
  }
  return sectionId
}

const renderMemoryDocIndex = (index: MemoryDocIndex): string =>
  [
    `# Memory Doc Index: ${index.path}`,
    "",
    `- scope: ${index.scope}`,
    `- docType: ${index.docType}`,
    `- ownerTool: ${index.ownerTool}`,
    `- schemaVersion: ${index.schemaVersion}`,
    `- contentHash: ${index.contentHash}`,
    index.warnings && index.warnings.length > 0 ? `- warnings: ${index.warnings.join("; ")}` : undefined,
    "",
    "## Sections",
    ...index.sections.map((section) => [
      "",
      `### ${section.sectionId}`,
      `- kind: ${section.kind}`,
      `- heading: ${section.heading}`,
      `- tags: ${section.tags.join(", ") || "none"}`,
      `- lines: ${section.lineStart}-${section.lineEnd}`,
      `- tokenEstimate: ${section.tokenEstimate}`,
      `- contentHash: ${section.contentHash}`,
      section.summary ? `- summary: ${section.summary}` : "- summary:",
    ].join("\n")),
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n")

const bundledToolUsageDocsDir = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(moduleDir, "../../memory/defaults/primary/tool_usage"),
    path.resolve(moduleDir, "memory/defaults/primary/tool_usage"),
    path.resolve(process.cwd(), "src/memory/defaults/primary/tool_usage"),
    path.resolve(process.cwd(), "dist/memory/defaults/primary/tool_usage"),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new SocratesError("tool_docs_assets_missing", "Bundled Socrates tool-usage docs were not found.", {
      recoverable: false,
      details: { candidates },
    })
  }
  return found
}

const bundledRepoDocsDir = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(moduleDir, "../../memory/defaults/workspace/repo_docs"),
    path.resolve(moduleDir, "memory/defaults/workspace/repo_docs"),
    path.resolve(process.cwd(), "src/memory/defaults/workspace/repo_docs"),
    path.resolve(process.cwd(), "dist/memory/defaults/workspace/repo_docs"),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new SocratesError("repo_docs_assets_missing", "Bundled Socrates workspace repo-doc templates were not found.", {
      recoverable: false,
      details: { candidates },
    })
  }
  return found
}

const bundledSkillsDir = (): string => {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    path.resolve(moduleDir, "../../memory/defaults/primary/skills"),
    path.resolve(moduleDir, "memory/defaults/primary/skills"),
    path.resolve(process.cwd(), "src/memory/defaults/primary/skills"),
    path.resolve(process.cwd(), "dist/memory/defaults/primary/skills"),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new SocratesError("skills_assets_missing", "Bundled Socrates skills were not found.", {
      recoverable: false,
      details: { candidates },
    })
  }
  return found
}

const ensureBundledToolUsageDocs = (targetDir: string): void => {
  const sourceDir = bundledToolUsageDocsDir()
  fs.mkdirSync(targetDir, { recursive: true })
  for (const sourcePath of listMarkdownFiles(sourceDir)) {
    const name = path.relative(sourceDir, sourcePath)
    const targetPath = path.join(targetDir, name)
    const content = fs.readFileSync(sourcePath, "utf8")
    fs.mkdirSync(path.dirname(targetPath), { recursive: true })
    if (!fs.existsSync(targetPath) || shouldRefreshBundledToolUsageDoc(name, fs.readFileSync(targetPath, "utf8"))) {
      fs.writeFileSync(targetPath, content)
    }
  }
}

const removeLegacyToolUsageDocs = (targetDir: string): void => {
  for (const relativePath of ["memory_docs.md", path.join("memory_agent", "trace_retrieve_global.md")]) {
    const filePath = path.join(targetDir, relativePath)
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath)
    }
  }
}

const ensureBundledRepoDocs = (targetDir: string): void => {
  const sourceDir = bundledRepoDocsDir()
  fs.mkdirSync(targetDir, { recursive: true })
  for (const name of REPO_DOC_NAMES) {
    ensureFile(path.join(targetDir, name), fs.readFileSync(path.join(sourceDir, name), "utf8"))
  }
}

const migrateGlobalPrimaryFiles = (socratesHome: string): void => {
  const primaryRoot = path.join(socratesHome, "primary")
  if (!fs.existsSync(primaryRoot)) {
    return
  }
  copyIfMissing(path.join(primaryRoot, "identity.md"), path.join(socratesHome, "identity.md"))
  const oldLearned = readIfExists(path.join(primaryRoot, "learned_patterns.md"))
  if (oldLearned?.trim()) {
    ensureFile(path.join(socratesHome, "skills", "general", "SKILL.md"), fallbackSkillMarkdown("general", oldLearned.trim()))
  }
}

const removeRetiredOperatingPrinciplesFiles = (socratesHome: string): void => {
  for (const filePath of [path.join(socratesHome, "operating_principles.md"), path.join(socratesHome, "primary", "operating_principles.md")]) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath)
    }
  }
}

const migrateIdentityUserSectionsToProfile = (socratesHome: string): void => {
  const identityPath = path.join(socratesHome, "identity.md")
  const profilePath = path.join(socratesHome, "user_profile.md")
  const identity = readIfExists(identityPath)
  const profile = readIfExists(profilePath)
  if (!identity || !profile) {
    return
  }
  const sections = extractMarkdownSections(identity, ["User Profile", "Stable Preferences", "Collaboration Style"])
  if (sections.length === 0) {
    return
  }
  if (!profile.includes("## Migrated From identity.md")) {
    fs.writeFileSync(profilePath, `${profile.trimEnd()}\n\n## Migrated From identity.md\n\n${sections.join("\n\n")}\n`)
  }
  let nextIdentity = removeMarkdownSections(identity, ["User Profile", "Stable Preferences", "Collaboration Style"]).trimEnd()
  if (!nextIdentity.includes("## User Context")) {
    nextIdentity = `${nextIdentity}\n\n## User Context\n\n- Durable user profile and stable cross-project preferences live in \`user_profile.md\` and are accessed through the \`user_profile\` tool.`
  }
  if (nextIdentity.trim() !== identity.trim()) {
    fs.writeFileSync(identityPath, `${nextIdentity}\n`)
  }
}

const extractMarkdownSections = (content: string, headings: string[]): string[] => {
  const wanted = new Set(headings.map((heading) => heading.toLowerCase()))
  const lines = content.split(/\r?\n/)
  const sections: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? "")
    const heading = match?.[1]
    if (!heading || !wanted.has(heading.toLowerCase())) {
      continue
    }
    const start = index
    index += 1
    while (index < lines.length && !/^##\s+/.test(lines[index] ?? "")) {
      index += 1
    }
    sections.push(lines.slice(start, index).join("\n").trim())
    index -= 1
  }
  return sections.filter(Boolean)
}

const removeMarkdownSections = (content: string, headings: string[]): string => {
  const wanted = new Set(headings.map((heading) => heading.toLowerCase()))
  const lines = content.split(/\r?\n/)
  const kept: string[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^##\s+(.+?)\s*$/.exec(lines[index] ?? "")
    const heading = match?.[1]
    if (!heading || !wanted.has(heading.toLowerCase())) {
      kept.push(lines[index] ?? "")
      continue
    }
    index += 1
    while (index < lines.length && !/^##\s+/.test(lines[index] ?? "")) {
      index += 1
    }
    index -= 1
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n")
}

const formatProjectStateLedgerSection = (input: {
  conversationTitle?: string
  turnId: string
  status: "completed" | "cancelled" | "failed"
  userRequest?: string
  toolRuns: ConversationToolRun[]
  failedToolEvents: FailedToolEventForLedger[]
}): string => {
  const tools = input.toolRuns.slice(-12).map(formatToolRunLedgerLine)
  const files = Array.from(new Set(input.toolRuns.flatMap((run) => run.fileOperations?.map((file) => `${file.operation} ${file.path}`) ?? []))).slice(0, 12)
  const commands = input.toolRuns.flatMap((run) => run.shell?.command ? [truncateInline(run.shell.command, 180)] : []).slice(-6)
  const failedTools = input.failedToolEvents.slice(-8).map(formatFailedToolEventLedgerLine)
  const docs = summarizeLedgerDocs(input.toolRuns)
  const outcome = summarizeLedgerOutcome(input.status, input.toolRuns, input.failedToolEvents)
  const userRequest = input.userRequest?.trim()
  return [
    STATE_LEDGER_START,
    "## Socrates State Ledger",
    "",
    "Machine-managed compact state for startup context. Preserve this bounded section; human notes can live outside it.",
    "",
    `- Updated: ${nowIso()}`,
    `- Last turn: ${input.status}${input.conversationTitle ? ` in "${input.conversationTitle}"` : ""} (${input.turnId})`,
    userRequest ? `- Last user request: ${truncateInline(userRequest, 220)}` : undefined,
    `- Outcome: ${outcome}`,
    `- Docs touched: ${docs}`,
    tools.length > 0 ? `- Recent tools: ${tools.join("; ")}` : "- Recent tools: none",
    failedTools.length > 0 ? `- Recent failed tool attempts: ${failedTools.join("; ")}` : "- Recent failed tool attempts: none",
    files.length > 0 ? `- Files touched: ${files.join("; ")}` : "- Files touched: none",
    commands.length > 0 ? `- Commands: ${commands.join("; ")}` : "- Commands: none",
    "- Startup hint: read full project notes with project_docs({operation:\"read\", area:\"notes\"}) when more detail is needed.",
    STATE_LEDGER_END,
  ]
    .filter((line): line is string => typeof line === "string")
    .join("\n")
}

const replaceStateLedgerSection = (content: string, section: string): string => {
  const start = content.indexOf(STATE_LEDGER_START)
  const end = content.indexOf(STATE_LEDGER_END)
  if (start >= 0 && end > start) {
    const afterEnd = end + STATE_LEDGER_END.length
    return `${content.slice(0, start).trimEnd()}\n\n${section}\n\n${content.slice(afterEnd).trimStart()}`.trimEnd() + "\n"
  }
  return `${content.trimEnd()}\n\n${section}\n`
}

const removeAssistantStatusPreviewLines = (content: string): string =>
  content
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("- Assistant/status preview:"))
    .join("\n")

const extractStateLedgerSection = (content: string): string | undefined => {
  const start = content.indexOf(STATE_LEDGER_START)
  const end = content.indexOf(STATE_LEDGER_END)
  if (start < 0 || end <= start) {
    return undefined
  }
  return content.slice(start, end + STATE_LEDGER_END.length)
}

const buildProjectNotesRuntimeContext = (workspacePath: string, generatedAt: string): { section: string; signature: string } => {
  const environment = inspectWorkspaceEnvironment(workspacePath)
  const packageManager = environment.javascript.packageManager ?? environment.javascript.packageManagers[0] ?? "none"
  const suggestedVirtualEnvironment = environment.python.suggestedVirtualEnvironment ?? environment.python.virtualEnvironments[0] ?? "none"
  const signaturePayload = {
    workspaceRoot: environment.workspacePath,
    detectedStack: environment.detectedStack,
    node: {
      packageManager,
      packageManagers: environment.javascript.packageManagers,
    },
    python: {
      virtualEnvironments: environment.python.virtualEnvironments,
      suggestedVirtualEnvironment,
    },
  }
  const signature = hashText(JSON.stringify(signaturePayload))
  return {
    signature,
    section: [
      `<!-- socrates:section id="${PROJECT_NOTES_RUNTIME_CONTEXT_SECTION}" kind="system" tags="runtime,generated,system" -->`,
      "## Runtime Context",
      "",
      "system_owned: true",
      `generated_at: ${generatedAt}`,
      `signature: ${signature}`,
      "workspace:",
      `  root: ${environment.workspacePath}`,
      "detected_stack:",
      ...yamlList(environment.detectedStack, "  "),
      "node:",
      `  package_manager: ${packageManager}`,
      "  package_managers:",
      ...yamlList(environment.javascript.packageManagers, "    "),
      "python:",
      "  virtual_environments:",
      ...yamlList(environment.python.virtualEnvironments, "    "),
      `  suggested_virtual_environment: ${suggestedVirtualEnvironment}`,
      "terminal_state: omitted",
      "notes:",
      "  - Runtime workspace scan facts are generated by the backend.",
      "  - Terminal output, live terminal state, dependency dumps, package lists, and root scripts are intentionally not persisted here.",
      "<!-- /socrates:section -->",
    ].join("\n"),
  }
}

const upsertRuntimeContextSection = (content: string, section: string, signature: string): string => {
  const currentSignature = runtimeContextSignature(content)
  if (currentSignature === signature) {
    return content
  }
  const sectionPattern = new RegExp(
    `<!--\\s*socrates:section\\s+[^>]*id="${PROJECT_NOTES_RUNTIME_CONTEXT_SECTION}"[^>]*-->[\\s\\S]*?<!--\\s*/socrates:section\\s*-->\\n*`,
    "m",
  )
  if (sectionPattern.test(content)) {
    return content.replace(sectionPattern, `${section}\n\n`)
  }
  const titlePattern = /^(---\n[\s\S]*?\n---\n\n# .+?\n\n|# .+?\n\n)/
  if (titlePattern.test(content)) {
    return content.replace(titlePattern, (prefix) => `${prefix}${section}\n\n`)
  }
  return `${content.trimEnd()}\n\n${section}\n`
}

const runtimeContextSignature = (content: string): string | undefined => {
  const sectionPattern = new RegExp(
    `<!--\\s*socrates:section\\s+[^>]*id="${PROJECT_NOTES_RUNTIME_CONTEXT_SECTION}"[^>]*-->[\\s\\S]*?<!--\\s*/socrates:section\\s*-->`,
    "m",
  )
  const section = sectionPattern.exec(content)?.[0]
  return /^signature:\s*(.+?)\s*$/m.exec(section ?? "")?.[1]
}

const sectionContentOrUndefined = (content: string, profile: MemoryDocProfile, sectionId: string): string | undefined => {
  try {
    return parseMemoryDoc(content, profile).sections.find((section) => section.sectionId === sectionId)?.content
  } catch {
    return undefined
  }
}

const yamlList = (items: string[], indent: string): string[] =>
  items.length > 0 ? items.map((item) => `${indent}- ${item}`) : [`${indent}- none`]

const formatToolRunLedgerLine = (run: ConversationToolRun): string => {
  const target = toolRunTarget(run)
  return `${run.toolName} ${run.status}${target ? ` ${target}` : ""}`
}

const toolRunTarget = (run: ConversationToolRun): string => {
  const args = run.arguments && typeof run.arguments === "object" && !Array.isArray(run.arguments) ? run.arguments as Record<string, unknown> : {}
  if (typeof args.path === "string") {
    return args.path
  }
  if (typeof args.query === "string") {
    return `"${truncateInline(args.query, 80)}"`
  }
  if (typeof args.command === "string") {
    return truncateInline(args.command, 100)
  }
  if (run.shell?.command) {
    return truncateInline(run.shell.command, 100)
  }
  return ""
}

const formatFailedToolEventLedgerLine = (event: FailedToolEventForLedger): string => {
  const toolName = event.toolName ?? "unknown_tool"
  return `${toolName} ${event.code}: ${truncateInline(event.message, 120)}`
}

const summarizeLedgerOutcome = (
  status: "completed" | "cancelled" | "failed",
  toolRuns: ConversationToolRun[],
  failedToolEvents: FailedToolEventForLedger[],
): string => {
  const completedTools = toolRuns.filter((run) => run.status === "completed").length
  const failedRuns = toolRuns.filter((run) => run.status === "failed" || run.status === "rejected" || run.status === "cancelled").length
  const failedAttempts = failedRuns + failedToolEvents.length
  const parts = [`turn ${status}`]
  if (completedTools > 0) {
    parts.push(`${completedTools} completed tool run${completedTools === 1 ? "" : "s"}`)
  }
  if (failedAttempts > 0) {
    parts.push(`${failedAttempts} failed/rejected attempt${failedAttempts === 1 ? "" : "s"} recorded`)
  }
  return parts.join("; ")
}

const summarizeLedgerDocs = (toolRuns: ConversationToolRun[]): string => {
  const docsRuns = toolRuns
    .filter((run) => run.toolName === "project_docs" || run.toolName === "repo_docs")
    .filter((run) => run.status === "completed")
    .flatMap((run) => {
      const args = run.arguments && typeof run.arguments === "object" && !Array.isArray(run.arguments) ? run.arguments as Record<string, unknown> : {}
      const operation = typeof args.operation === "string" ? args.operation : undefined
      if (operation !== "edit" && operation !== "patch_section") {
        return []
      }
      const target = run.toolName === "project_docs" ? (typeof args.area === "string" ? args.area : "project") : (typeof args.path === "string" ? args.path : "repo_docs")
      return [`${run.toolName} ${target} ${operation}`]
    })
  return docsRuns.length > 0 ? Array.from(new Set(docsRuns)).slice(0, 6).join("; ") : "none"
}

const truncateInline = (text: string, limit: number): string => {
  const compact = text.replace(/\s+/g, " ").trim()
  return compact.length > limit ? `${compact.slice(0, Math.max(0, limit - 3))}...` : compact
}

const primaryMemoryCharLimit = (operation: "read" | "read_index" | "read_section", requested?: number): number => {
  const cap = operation === "read" ? PRIMARY_MEMORY_FULL_READ_CHAR_LIMIT : operation === "read_index" ? PRIMARY_MEMORY_INDEX_CHAR_LIMIT : PRIMARY_MEMORY_SECTION_CHAR_LIMIT
  return Math.min(requested ?? cap, cap)
}

const migrateUsefulPatternsToSkills = (socratesHome: string): void => {
  const oldRoot = path.join(socratesHome, "useful_patterns")
  const newRoot = path.join(socratesHome, "skills")
  if (!fs.existsSync(oldRoot)) {
    return
  }
  for (const skillFile of listMarkdownFiles(oldRoot).filter((filePath) => path.basename(filePath) === "SKILL.md")) {
    const relativeDir = path.relative(oldRoot, path.dirname(skillFile)).replaceAll(path.sep, "/")
    const safeName = slugSkillName(relativeDir || "general")
    const targetDir = path.join(newRoot, uniqueSkillName(newRoot, safeName))
    const content = readIfExists(skillFile) ?? ""
    const parsed = parseSkillMarkdown(content, skillFile)
    ensureFile(path.join(targetDir, "SKILL.md"), parsed ? content : fallbackSkillMarkdown(safeName, content.trim() || "Reusable migrated Socrates pattern."))
  }
  fs.rmSync(oldRoot, { recursive: true, force: true })
}

const copyIfMissing = (sourcePath: string, targetPath: string): void => {
  const content = readIfExists(sourcePath)
  if (content !== undefined && !fs.existsSync(targetPath)) {
    ensureFile(targetPath, content)
  }
}

const removeLegacyRepoDocs = (docsRoot: string): void => {
  for (const name of LEGACY_REPO_DOC_NAMES) {
    const filePath = path.join(docsRoot, name)
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      fs.unlinkSync(filePath)
    }
  }
}

const removeLegacyProjectRoot = (legacyRoot: string): void => {
  if (fs.existsSync(legacyRoot)) {
    fs.rmSync(legacyRoot, { recursive: true, force: true })
  }
}

const globalToolDocProfile = (relativePath: string): MemoryDocProfile => ({
  docType: "tool_doc",
  ownerTool: "tool_docs",
  scope: "global",
  path: relativePath,
  projectId: GLOBAL_MEMORY_AGENT_PROJECT_ID,
  indexTags: ["tool_usage"],
})

const shouldRefreshBundledToolUsageDoc = (name: string, content: string): boolean =>
  isLegacyToolUsageSeed(name, content) || isOutdatedBundledToolUsageDoc(name, content) || !isStructuredToolUsageDoc(name, content)

const isOutdatedBundledToolUsageDoc = (name: string, content: string): boolean =>
  ["user_profile.md", path.join("memory_agent", "user_profile.md")].includes(name) && !content.includes("turnId/messageId/event")

const isStructuredToolUsageDoc = (name: string, content: string): boolean => {
  try {
    const index = parseMemoryDoc(content, globalToolDocProfile(`tool_usage/${name}`))
    if (index.warnings?.some((warning) => warning.startsWith("Missing required section") || warning.toLowerCase().includes("frontmatter"))) {
      return false
    }
    const expected = memoryDocRequiredSections.tool_doc
    const actual = index.sections.map((section) => section.sectionId)
    return actual.length === expected.length && expected.every((sectionId, index) => actual[index] === sectionId) && !actual.includes("legacy_content")
  } catch {
    return false
  }
}

const isLegacyToolUsageSeed = (name: string, content: string): boolean => {
  const trimmed = content.trim()
  if (
    trimmed.includes("socrates_doc: tool_doc") &&
    trimmed.includes("- What this tool guidance is for.") &&
    trimmed.includes('id="legacy_content"')
  ) {
    return true
  }
  if (
    name === "project_docs.md" &&
    trimmed.includes("# project docs Usage Guide") &&
    trimmed.includes("- What this tool guidance is for.") &&
    !trimmed.includes('"operation": "patch_section"')
  ) {
    return true
  }
  if (trimmed.length > 500) {
    return false
  }
  return (
    (name === "trace_retrieve.md" && trimmed.includes("Use as an investigation tool: browse recent/project conversations without query")) ||
    (name === "edit_apply_patch.md" && trimmed.includes("Use patch/edit for file writes and Terminal for execution")) ||
    (name === "read_search.md" && trimmed.includes("Use bounded reads and targeted searches"))
  )
}

const ensureFile = (filePath: string, content: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content)
  }
}

const readIfExists = (filePath: string): string | undefined => {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined
  }
  return fs.readFileSync(filePath, "utf8")
}

const listMarkdownFiles = (root: string): string[] => {
  if (!fs.existsSync(root)) {
    return []
  }
  const entries = fs.readdirSync(root, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const absolutePath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      return listMarkdownFiles(absolutePath)
    }
    return entry.isFile() && entry.name.endsWith(".md") ? [absolutePath] : []
  })
}

const compileSearch = (query: string, _mode: "keyword_any"): { score: (text: string) => number } => {
  const terms = searchTerms(query)
  return { score: (text) => terms.filter((term) => text.toLowerCase().includes(term)).length * 50 }
}

const searchTerms = (query: string): string[] => query.toLowerCase().match(/[a-z0-9_./:-]+/g)?.filter((term) => term.length > 0) ?? []

const parseJsonObject = (text: string | null | undefined): Record<string, unknown> => {
  if (!text) {
    return {}
  }
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

const parseJsonArray = (text: string | null | undefined): unknown[] => {
  if (!text) {
    return []
  }
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const isMemoryAgentSummary = (value: unknown): value is MemoryAgentRunDetail["summary"] => {
  if (!value || typeof value !== "object") {
    return false
  }
  const record = value as Record<string, unknown>
  return ["investigated", "changed", "skipped", "blocked"].every((key) => typeof record[key] === "string")
}

const usageFromMetadata = (metadata: Record<string, unknown>): { totalTokens?: number; costUsd?: number } => {
  const usage = metadata.usage
  if (!usage || typeof usage !== "object") {
    return {}
  }
  const record = usage as Record<string, unknown>
  return {
    ...(typeof record.totalTokens === "number" ? { totalTokens: Math.max(0, Math.floor(record.totalTokens)) } : {}),
    ...(typeof record.costUsd === "number" ? { costUsd: Math.max(0, record.costUsd) } : {}),
  }
}

const slimMemoryToolEvent = (event: { type: string; toolName?: unknown; summary?: unknown; error?: unknown; argsPreview?: unknown; resultPreview?: unknown }): Record<string, unknown> => ({
  type: event.type,
  ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
  ...(typeof event.argsPreview === "string" ? { argsPreview: event.argsPreview.slice(0, 500) } : {}),
  ...(typeof event.summary === "string" ? { summary: event.summary.slice(0, 500) } : {}),
  ...(typeof event.resultPreview === "string" ? { resultPreview: event.resultPreview.slice(0, 500) } : {}),
  ...(event.error && typeof event.error === "object" && "message" in event.error ? { error: String((event.error as { message?: unknown }).message ?? "") } : {}),
})

const mergeToolErrorDetails = (details: unknown, toolName?: string): Record<string, unknown> => {
  const merged: Record<string, unknown> = details && typeof details === "object" && !Array.isArray(details) ? { ...(details as Record<string, unknown>) } : details === undefined ? {} : { originalDetails: details }
  if (toolName) {
    merged.toolName = toolName
  }
  return merged
}

const memoryFileScope = (file: MemoryAgentFileSummary): SkillScope | "" => ("scope" in file && file.scope ? file.scope : "")

const MEMORY_NOTES_PER_TURN_LIMIT = 2
const MEMORY_NOTE_OUTCOMES = ["applied", "already_represented", "skipped", "proposed_skill"] as const
const isMemoryNoteOutcome = (value: unknown): value is (typeof MEMORY_NOTE_OUTCOMES)[number] =>
  typeof value === "string" && (MEMORY_NOTE_OUTCOMES as readonly string[]).includes(value)

type MemoryNoteSignalStats = {
  memoryNotesSent: number
  memoryNotesAlreadyRecorded: number
}

type MemoryNoteRunStats = {
  memoryNotesProcessed: number
  applied: number
  alreadyRepresented: number
  skipped: number
  proposedSkill: number
}

type MemoryAgentActivityStats = MemoryNoteSignalStats & MemoryNoteRunStats

const emptyMemoryNoteRunStats = (): MemoryNoteRunStats => ({
  memoryNotesProcessed: 0,
  applied: 0,
  alreadyRepresented: 0,
  skipped: 0,
  proposedSkill: 0,
})

const recordMemoryNotesToolOutput = (stats: MemoryNoteRunStats, output: unknown): void => {
  const parsed = output && typeof output === "object" && !Array.isArray(output) ? output as Partial<MemoryNotesToolOutput> : undefined
  if (parsed?.operation !== "mark_done" || !Array.isArray(parsed.notes)) {
    return
  }
  for (const note of parsed.notes) {
    stats.memoryNotesProcessed += 1
    if (note.outcome === "applied") {
      stats.applied += 1
    } else if (note.outcome === "already_represented") {
      stats.alreadyRepresented += 1
    } else if (note.outcome === "skipped") {
      stats.skipped += 1
    } else if (note.outcome === "proposed_skill") {
      stats.proposedSkill += 1
    }
  }
}

const shouldNotifyMemoryAgentActivity = (stats: MemoryAgentActivityStats): boolean =>
  stats.memoryNotesSent > 0 ||
  stats.memoryNotesAlreadyRecorded > 0 ||
  stats.memoryNotesProcessed > 0 ||
  stats.applied > 0 ||
  stats.alreadyRepresented > 0 ||
  stats.skipped > 0 ||
  stats.proposedSkill > 0

const memoryAgentActivityBody = (stats: MemoryAgentActivityStats): string => {
  const parts = [
    stats.memoryNotesSent > 0 ? `${stats.memoryNotesSent} note${stats.memoryNotesSent === 1 ? "" : "s"} sent` : undefined,
    stats.memoryNotesAlreadyRecorded > 0 ? `${stats.memoryNotesAlreadyRecorded} duplicate${stats.memoryNotesAlreadyRecorded === 1 ? "" : "s"} already recorded` : undefined,
    stats.memoryNotesProcessed > 0 ? `${stats.memoryNotesProcessed} note${stats.memoryNotesProcessed === 1 ? "" : "s"} processed` : undefined,
    stats.applied > 0 ? `${stats.applied} applied` : undefined,
    stats.alreadyRepresented > 0 ? `${stats.alreadyRepresented} already represented` : undefined,
    stats.skipped > 0 ? `${stats.skipped} skipped` : undefined,
    stats.proposedSkill > 0 ? `${stats.proposedSkill} skill proposal${stats.proposedSkill === 1 ? "" : "s"}` : undefined,
  ].filter((part): part is string => typeof part === "string")
  return parts.length > 0 ? parts.join(" · ") : "Memory check completed."
}

const normalizedMemoryNoteKey = (note: string): string => {
  const normalized = note
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  return hashText(`memory_note:v1:${normalized || note.trim().toLowerCase()}`)
}

const humanizeSkillName = (name: string): string =>
  name
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")

const skillDisplayPath = (scope: WritableSkillScope, socratesHome: string, workspacePath: string | undefined, targetPath: string): string => {
  const root = scope === "project" && workspacePath ? workspacePath : socratesHome
  return path.relative(root, targetPath).replaceAll(path.sep, "/")
}

const safeJoin = (root: string, relativePath: string): string => {
  const resolved = path.resolve(root, relativePath)
  const resolvedRoot = path.resolve(root)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new SocratesError("safe_path_escape", "Path must stay inside the expected root.", { recoverable: true })
  }
  return resolved
}

const lineMatches = (content: string, query: string, limit: number): Array<{ line: number; text: string }> => {
  const needle = query.toLowerCase()
  if (!needle.trim() || limit <= 0) {
    return []
  }
  const matches: Array<{ line: number; text: string }> = []
  content.split(/\r?\n/).forEach((line, index) => {
    if (matches.length < limit && line.toLowerCase().includes(needle)) {
      matches.push({ line: index + 1, text: line.slice(0, 1_000) })
    }
  })
  return matches
}

const truncate = (text: string, charLimit: number): { text: string; truncated: boolean } =>
  text.length <= charLimit ? { text, truncated: false } : { text: text.slice(0, charLimit), truncated: true }

const truncationFor = (text: string, charLimit: number): TruncationMetadata => ({
  truncated: text.length > charLimit,
  charLimit,
  originalLength: text.length,
  returnedLength: Math.min(text.length, charLimit),
})

const countOccurrences = (text: string, needle: string): number => text.split(needle).length - 1
