import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type {
  Notification,
  DocsSearchMode,
  EditFilesToolInput,
  EditFilesToolOutput,
  MemoryAgentGlobalSettings,
  MemoryAgentGlobalState,
  MemoryAgentRunSummary,
  ProjectDocsArea,
  ProjectDocsToolInput,
  ProjectDocsToolOutput,
  ProjectsToolInput,
  ProjectsToolOutput,
  RepoDocsToolInput,
  RepoDocsToolOutput,
  SkillScope,
  SkillSummary,
  SkillsToolInput,
  SkillsToolOutput,
  SoulToolInput,
  SoulToolOutput,
  ToolDocsArea,
  ToolDocsToolInput,
  ToolDocsToolOutput,
  TraceRetrieveToolInput,
  TraceRetrieveToolOutput,
  TriggerMemoryAgentRunResponse,
  TruncationMetadata,
} from "@socrates/contracts"
import type { ModelProvider, ProviderCredentialResolver } from "@socrates/providers"
import { estimateTextTokens } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, desc, eq } from "drizzle-orm"
import {
  conversations,
  errors,
  events,
  memoryAgentActions,
  memoryAgentConfirmations,
  memoryAgentJobs,
  projectInstructions,
  projectResources,
  projects,
  projectWorkspaces,
} from "../../db/schema"
import { hashText, simpleDiff, validateMemoryPatch, type MemoryPatchProposal } from "./memoryAgentOutput"
import { runMemoryAgentTurn, type MemoryAgentModelSettings } from "./memoryAgentRunner"
import {
  DEFAULT_MEMORY_AGENT_MODEL_ID,
  DEFAULT_MEMORY_AGENT_PROVIDER_ID,
  DEFAULT_MEMORY_AGENT_THINKING_EFFORT,
  DEFAULT_MEMORY_AGENT_THINKING_ENABLED,
} from "./memoryAgentDefaults"
import {
  discoverSkills,
  fallbackSkillBody,
  fallbackSkillDescription,
  fallbackSkillMarkdown,
  parseSkillMarkdown,
  readSkillInfo,
  skillSummary,
  slugSkillName,
  stripFrontmatter,
  uniqueSkillName,
  type SkillInfo,
} from "./memorySkills"
import { ensureStructuredSoulFile } from "./memorySoulDefaults"
import { StoreBase } from "./shared"

const DEFAULT_CHAR_LIMIT = 20_000
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_CONTEXT_LINES = 8
const MAX_CONTEXT_CHARS = 28_000
const MEMORY_AGENT_TOKEN_CAP = 60_000
const GLOBAL_MEMORY_AGENT_PROJECT_ID = "global"
const GLOBAL_MEMORY_AGENT_MAX_TURNS = 80
const WAKE_CONTEXT_CHAR_LIMIT = 4_000
const SKILL_CHAR_LIMIT = 20_000
const INTERNAL_BUILTIN_SKILL_NAMES = new Set(["socrates-skill-writer"])
const SOUL_CONFIRMATION_PROMPT = "You are about to make changes to the soul. Are you sure?\nReply exactly yes or no."
const REPO_DOC_NAMES = ["CORE_IDEA.md", "REPO_NAVIGATION.md", "REPO_RULES.md", "CONTRACTS.md"] as const
const LEGACY_REPO_DOC_NAMES = ["APP_FLOW.md", "DB_STRUCTURE.md", "FRONTEND_BACKEND_CONTRACT.md", "PROVIDER_USAGE.md", "REPO_STRCUTURE.md"] as const

type MemoryFile = {
  path: string
  absolutePath: string
  area: ToolDocsArea
  sizeBytes: number
  modifiedAt: string
}

type DocsResult = ToolDocsToolOutput["results"][number]

type MemoryStoreOptions = {
  socratesHome?: string
  provider?: ModelProvider
  credentials?: ProviderCredentialResolver
  traceRetrieve?: (projectId: string, conversationId: string, input: TraceRetrieveToolInput) => Promise<TraceRetrieveToolOutput> | TraceRetrieveToolOutput
  traceRetrieveGlobal?: (input: TraceRetrieveToolInput) => Promise<TraceRetrieveToolOutput> | TraceRetrieveToolOutput
  getMemoryAgentGlobalSettings?: () => MemoryAgentGlobalSettings
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

type MemoryAgentStatePatch = Partial<Omit<MemoryAgentGlobalState, "id" | "updatedAt" | "lastRunAt" | "activeJobId" | "lastJobId" | "error">> & {
  lastRunAt?: string | null
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
      ensureFile(path.join(workspacePath, ".socrates", "MEMORY.md"), "# Project Memory\n\nDurable project-specific state, decisions, preferences, and current standing for this workspace.\n")
      ensureFile(path.join(workspacePath, ".socrates", "PROJECT_NOTES.md"), "# PROJECT_NOTES\n\nRepo-local notes for Socrates. Users may edit this file directly.\n")
      fs.mkdirSync(path.join(workspacePath, ".socrates", "skills"), { recursive: true })
      ensureBundledRepoDocs(path.join(workspacePath, ".socrates", "repo_docs"))
      removeLegacyRepoDocs(path.join(workspacePath, ".socrates", "repo_docs"))
    }
  }

  private ensureGlobalKnowledge(): void {
    migrateGlobalPrimaryFiles(this.socratesHome)
    ensureStructuredSoulFile(path.join(this.socratesHome, "identity.md"), "identity")
    ensureStructuredSoulFile(path.join(this.socratesHome, "operating_principles.md"), "operating_principles")
    ensureBundledToolUsageDocs(path.join(this.socratesHome, "tool_usage"))
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

  runToolDocsTool(projectId: string, workspacePath: string | undefined, input: ToolDocsToolInput): ToolDocsToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    if (input.operation === "read") {
      return this.readToolDocs(input)
    }
    return this.searchToolDocs(input)
  }

  runSkillsTool(projectId: string, workspacePath: string | undefined, input: SkillsToolInput): SkillsToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    if (input.operation === "read") {
      return this.readSkill(input, workspacePath)
    }
    if (input.operation === "search") {
      return this.searchSkills(input, workspacePath)
    }
    return this.listSkillsOutput(input, workspacePath)
  }

  listProjectSkills(projectId: string, workspacePath: string | undefined): SkillSummary[] {
    this.ensureProjectMemory(projectId, workspacePath)
    return this.skillInfos(workspacePath, "project").map(skillSummary)
  }

  async buildProjectSkill(projectId: string, workspacePath: string, request: string): Promise<SkillSummary> {
    this.ensureProjectMemory(projectId, workspacePath)
    const skillRoot = path.join(workspacePath, ".socrates", "skills")
    fs.mkdirSync(skillRoot, { recursive: true })
    const desiredName = slugSkillName(request)
    const name = uniqueSkillName(skillRoot, desiredName)
    const skillDir = path.join(skillRoot, name)
    const skillFile = path.join(skillDir, "SKILL.md")
    const content = await this.generateProjectSkill(projectId, workspacePath, request, name)
    const parsed = parseSkillMarkdown(content, skillFile)
    const finalContent =
      parsed?.name === name
        ? content
        : `---\nname: ${name}\ndescription: ${parsed?.description ?? fallbackSkillDescription(request)}\n---\n\n${stripFrontmatter(content).trim() || fallbackSkillBody(request)}\n`
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(skillFile, finalContent)
    const info = readSkillInfo("project", skillRoot, skillFile)
    if (!info) {
      throw new SocratesError("project_skill_invalid", "Generated project skill did not pass validation.", { recoverable: true, details: { path: skillFile } })
    }
    return skillSummary(info)
  }

  runProjectDocsTool(projectId: string, workspacePath: string, input: ProjectDocsToolInput): ProjectDocsToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    const documentPath = projectDocPath(workspacePath, input.area)
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const content = fs.readFileSync(documentPath, "utf8")
    if (input.operation === "read") {
      const truncated = truncate(content, charLimit)
      return {
        operation: "read",
        area: input.area,
        path: projectDocRelativePath(input.area),
        content: truncated.text,
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
    fs.writeFileSync(documentPath, next)
    return {
      operation: "edit",
      area: input.area,
      path: projectDocRelativePath(input.area),
      changed: next !== content,
      content: truncate(next, charLimit).text,
      truncation: truncationFor(next, charLimit),
    }
  }

  runRepoDocsTool(projectId: string, workspacePath: string, input: RepoDocsToolInput): RepoDocsToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    const docsRoot = repoDocsRoot(workspacePath)
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    if (input.operation === "read") {
      if (!input.path) {
        const paths = [...REPO_DOC_NAMES].map((name) => `.socrates/repo_docs/${name}`)
        const content = paths.map((docPath) => `- ${docPath}`).join("\n")
        return {
          operation: "read",
          paths,
          content,
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
    const next = input.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText)
    fs.writeFileSync(absolutePath, next)
    return {
      operation: "edit",
      path: `.socrates/repo_docs/${name}`,
      changed: next !== content,
      content: truncate(next, charLimit).text,
      truncation: truncationFor(next, charLimit),
    }
  }

  runSoulTool(projectId: string, workspacePath: string | undefined, input: SoulToolInput): SoulToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const requested = input.document === "both" ? (["identity", "operating_principles"] as const) : ([input.document] as const)
    const documents = requested.map((document) => {
      const absolutePath = this.soulPath(document)
      const content = fs.readFileSync(absolutePath, "utf8")
      const clipped = truncate(content, charLimit)
      return {
        document,
        path: `${document}.md`,
        content: clipped.text,
        truncation: truncationFor(content, charLimit),
      }
    })
    const serialized = JSON.stringify(documents)
    return {
      operation: "read",
      documents,
      truncation: truncationFor(serialized, charLimit),
      ...(serialized.length > charLimit ? { warnings: ["Soul output was truncated. Re-read one document with a larger charLimit if needed."] } : {}),
    }
  }

  buildWakeContext(projectId: string, workspacePath: string | undefined, userQuery: string): string | undefined {
    this.ensureProjectMemory(projectId, workspacePath)
    const sections: string[] = ["First user query in this conversation. Use this as quiet wake context, not as user-visible text."]
    const projectMemory = workspacePath ? readIfExists(projectDocPath(workspacePath, "memory")) : undefined
    const coreIdea = workspacePath ? readIfExists(repoDocPath(repoDocsRoot(workspacePath), "CORE_IDEA.md")) : undefined
    const query = userQuery.trim()
    for (const [label, content] of [
      ["Project memory", projectMemory],
      ["Core idea", coreIdea],
    ] as const) {
      if (!content?.trim()) {
        continue
      }
      const excerpt = query ? bestExcerpt(content, query, 900) : content.slice(0, 900)
      if (excerpt.trim()) {
        sections.push(`${label}:\n${excerpt.trim()}`)
      }
      if (sections.join("\n\n").length >= WAKE_CONTEXT_CHAR_LIMIT) {
        break
      }
    }
    const context = sections.join("\n\n")
    return context.length > WAKE_CONTEXT_CHAR_LIMIT ? `${context.slice(0, WAKE_CONTEXT_CHAR_LIMIT)}\n[Wake context truncated]` : context
  }

  async runGlobalMemoryAgent(input: GlobalMemoryAgentRunInput): Promise<TriggerMemoryAgentRunResponse> {
    this.ensureGlobalKnowledge()
    if (this.globalMemoryRunActive) {
      return { state: input.state, skippedReason: "Memory agent is already running." }
    }
    this.globalMemoryRunActive = true
    try {
      return await this.runGlobalMemoryAgentOnce(input)
    } finally {
      this.globalMemoryRunActive = false
    }
  }

  listGlobalMemoryAgentRuns(limit = 10): MemoryAgentRunSummary[] {
    const rows = this.handle.db
      .select()
      .from(memoryAgentJobs)
      .where(eq(memoryAgentJobs.projectId, GLOBAL_MEMORY_AGENT_PROJECT_ID))
      .orderBy(desc(memoryAgentJobs.startedAt))
      .limit(limit)
      .all()
    return rows.map((row) => this.memoryAgentRunSummary(row))
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
    if (!input.settings.enabled) {
      const state = input.updateState({ status: "skipped", lastRunAt: now, activeJobId: null, error: "Memory agent is disabled." })
      return { state, skippedReason: "Memory agent is disabled." }
    }
    if (!this.options.provider) {
      const state = input.updateState({ status: "skipped", lastRunAt: now, activeJobId: null, error: "Memory agent provider is not configured." })
      return { state, skippedReason: "Memory agent provider is not configured." }
    }
    if (this.options.credentials && !this.options.credentials.getApiKey(input.settings.providerId)) {
      const reason = `${input.settings.providerId} credential is not configured.`
      const state = input.updateState({ status: "skipped", lastRunAt: now, activeJobId: null, error: reason })
      this.appendEvent({ type: "memory.agent.skipped", source: "server", payload: { reason } })
      return { state, skippedReason: reason }
    }

    const entries = this.buildGlobalManifest(input.state.lastProcessedEventSequence)
    if (entries.entries.length === 0) {
      const state = input.updateState({ status: "idle", lastRunAt: now, activeJobId: null, error: null })
      return { state, skippedReason: "No completed turns after the current memory watermark." }
    }

    const modelSettings: MemoryAgentModelSettings = {
      providerId: input.settings.providerId,
      modelId: input.settings.modelId,
      thinkingEnabled: input.settings.thinkingEnabled,
      ...(input.settings.thinkingEffort ? { thinkingEffort: input.settings.thinkingEffort } : {}),
    }
    const latest = entries.entries[entries.entries.length - 1]
    const jobId = createId("memjob")
    const evidence = capByEstimatedTokens(entries.manifest, MEMORY_AGENT_TOKEN_CAP)
    const evidenceTokensEstimate = estimateTextTokens(evidence).inputTokens
    const startedAt = nowIso()
    const metadataBase = {
      sequenceFrom: entries.sequenceFrom,
      sequenceTo: entries.sequenceTo,
      thinkingEnabled: modelSettings.thinkingEnabled,
      thinkingEffort: modelSettings.thinkingEffort,
      turnCount: entries.entries.length,
    }
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
        metadataJson: JSON.stringify(metadataBase),
      })
      .run()
    input.updateState({ status: "running", activeJobId: jobId, error: null })
    this.appendEvent({
      type: "memory.agent.started",
      source: "server",
      payload: { jobId, trigger: input.trigger, sequenceFrom: entries.sequenceFrom, sequenceTo: entries.sequenceTo, evidenceTokensEstimate },
    })

    const toolEvents: unknown[] = []
    try {
      const output = await runMemoryAgentTurn({
        provider: this.options.provider,
        modelSettings,
        evidence,
        projectId: GLOBAL_MEMORY_AGENT_PROJECT_ID,
        conversationId: latest?.conversationId ?? "",
        sessionId: latest?.sessionId ?? "",
        turnId: latest?.turnId ?? "",
        socratesHome: this.socratesHome,
        tools: {
          traceRetrieve: async (toolInput) => {
            if (!this.options.traceRetrieveGlobal) {
              throw new SocratesError("memory_agent_trace_unavailable", "Global trace_retrieve is not available to this memory-agent run.", { recoverable: true })
            }
            return this.options.traceRetrieveGlobal(toolInput)
          },
          projects: async (toolInput) => this.runProjectsTool(toolInput),
          toolDocs: async (toolInput) => this.runToolDocsTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput),
          skills: async (toolInput) => this.runSkillsTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput),
          soul: async (toolInput) => this.runSoulTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput),
          editFiles: async (toolInput) =>
            this.runEditFilesTool(toolInput, {
              jobId,
              turnId: latest?.turnId,
              modelSettings,
            }),
        },
        onEvent: (event) => {
          if (event.type.startsWith("tool.call") || event.type.startsWith("approval.")) {
            toolEvents.push(slimMemoryToolEvent(event))
          }
        },
      })
      const completedAt = nowIso()
      this.handle.db
        .update(memoryAgentJobs)
        .set({
          status: "completed",
          outputJson: JSON.stringify({ summary: output.trim() }),
          completedAt,
          metadataJson: JSON.stringify({ ...metadataBase, toolEvents }),
        })
        .where(eq(memoryAgentJobs.id, jobId))
        .run()
      const state = input.updateState({
        lastProcessedEventSequence: entries.sequenceTo,
        lastRunAt: completedAt,
        status: "idle",
        activeJobId: null,
        lastJobId: jobId,
        error: null,
      })
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
        },
      })
      return { state, run: this.memoryAgentRunSummary(this.mustGetMemoryAgentJob(jobId)) }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const completedAt = nowIso()
      this.handle.db
        .update(memoryAgentJobs)
        .set({
          status: "failed",
          completedAt,
          metadataJson: JSON.stringify({ ...metadataBase, toolEvents, error: message }),
        })
        .where(eq(memoryAgentJobs.id, jobId))
        .run()
      const state = input.updateState({
        lastRunAt: completedAt,
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
      return { state, run: this.memoryAgentRunSummary(this.mustGetMemoryAgentJob(jobId)), skippedReason: message }
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
    const entries = rows.map((row) => ({
      ...row,
      counts: this.countTurnArtifacts(row.turnId),
    }))
    const sequenceFrom = entries[0]?.sequence ?? lastProcessedEventSequence + 1
    const sequenceTo = entries[entries.length - 1]?.sequence ?? lastProcessedEventSequence
    const manifest = [
      "# Global Memory Agent Manifest",
      `Previous watermark: ${lastProcessedEventSequence}`,
      `Candidate turn count: ${entries.length}`,
      `Sequence range: ${sequenceFrom}-${sequenceTo}`,
      "",
      "Use trace_retrieve for message/tool evidence. This manifest intentionally omits message bodies.",
      "",
      ...entries.map((entry, index) =>
        [
          `## ${index + 1}. event sequence ${entry.sequence}`,
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
          .join("\n"),
      ),
    ].join("\n")
    return { entries, manifest, sequenceFrom, sequenceTo }
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

  private async runEditFilesTool(input: EditFilesToolInput, context: { jobId: string; turnId?: string; modelSettings: MemoryAgentModelSettings }): Promise<EditFilesToolOutput> {
    this.ensureGlobalKnowledge()
    const resolved = this.resolveEditFilesTarget(input)
    if (input.editMode === "create") {
      return this.createMemoryTarget(input, resolved, context)
    }
    const patch: MemoryPatchProposal = {
      oldText: input.oldText ?? "",
      newText: input.newText,
      ...(input.rationale ? { rationale: input.rationale } : {}),
      ...(input.sourceTurnIds ? { sourceTurnIds: input.sourceTurnIds } : {}),
      ...(resolved.document ? { document: resolved.document } : {}),
    }
    if (resolved.targetKind === "soul") {
      const result = await this.applySoulPatch(GLOBAL_MEMORY_AGENT_PROJECT_ID, context.jobId, context.turnId ? {
        projectId: GLOBAL_MEMORY_AGENT_PROJECT_ID,
        conversationId: "",
        sessionId: "",
        turnId: context.turnId,
        text: "",
        tokens: 0,
      } : undefined, patch, context.modelSettings)
      return {
        target: input.target,
        ...(input.name ? { name: input.name } : {}),
        path: path.relative(this.socratesHome, resolved.path).replaceAll(path.sep, "/"),
        changed: result.applied,
        actionId: result.actionId,
        status: result.applied ? "applied" : "rejected",
        ...(result.error ? { warnings: [result.error] } : {}),
        truncation: truncationFor(result.error ?? "", DEFAULT_CHAR_LIMIT),
      }
    }
    const result = this.applyPrimaryPatch(GLOBAL_MEMORY_AGENT_PROJECT_ID, context.jobId, context.turnId, resolved.targetKind, resolved.path, patch)
    return {
      target: input.target,
      ...(input.name ? { name: input.name } : {}),
      path: path.relative(this.socratesHome, resolved.path).replaceAll(path.sep, "/"),
      changed: result.applied,
      actionId: result.actionId,
      status: result.applied ? "applied" : "rejected",
      diff: simpleDiff(input.oldText ?? "", input.newText),
      ...(result.error ? { warnings: [result.error] } : {}),
      truncation: truncationFor(result.error ?? "", DEFAULT_CHAR_LIMIT),
    }
  }

  private createMemoryTarget(
    input: EditFilesToolInput,
    resolved: { path: string; targetKind: "tool_usage" | "skills" | "soul"; document?: "identity" | "operating_principles" },
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
    if (resolved.targetKind === "soul") {
      const error = "Soul documents already exist and must be edited with editMode=\"replace\"."
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
    this.handle.db
      .update(memoryAgentActions)
      .set({ status: "applied", afterHash: hashText(input.newText), appliedAt: nowIso() })
      .where(eq(memoryAgentActions.id, action.actionId))
      .run()
    return {
      target: input.target,
      ...(input.name ? { name: input.name } : {}),
      path: path.relative(this.socratesHome, resolved.path).replaceAll(path.sep, "/"),
      changed: true,
      actionId: action.actionId,
      status: "applied",
      diff: simpleDiff("", input.newText),
      truncation: truncationFor(input.newText, DEFAULT_CHAR_LIMIT),
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

  private resolveEditFilesTarget(input: EditFilesToolInput): { path: string; targetKind: "tool_usage" | "skills" | "soul"; document?: "identity" | "operating_principles" } {
    if (input.target === "identity" || input.target === "operating_principles") {
      return { path: this.soulPath(input.target), targetKind: "soul", document: input.target }
    }
    if (input.target === "tool_doc") {
      const rawName = input.name ?? "trace_retrieve"
      const normalized = rawName.replaceAll("\\", "/").replace(/^tool_usage\//, "").replace(/\.md$/i, "")
      const safeName =
        path
          .basename(normalized)
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "_")
          .replace(/^_+|_+$/g, "")
          .slice(0, 80) || "trace_retrieve"
      const fileName = `${safeName}.md`
      return { path: safeJoin(path.join(this.socratesHome, "tool_usage"), fileName), targetKind: "tool_usage" }
    }
    const skillName = slugSkillName(input.name ?? "general")
    return { path: safeJoin(path.join(this.socratesHome, "skills"), `${skillName}/SKILL.md`), targetKind: "skills" }
  }

  private mustGetMemoryAgentJob(jobId: string): typeof memoryAgentJobs.$inferSelect {
    const row = this.handle.db.select().from(memoryAgentJobs).where(eq(memoryAgentJobs.id, jobId)).limit(1).get()
    if (!row) {
      throw new SocratesError("memory_agent_job_not_found", "Memory agent job was not found.", { details: { jobId } })
    }
    return row
  }

  private memoryAgentRunSummary(row: typeof memoryAgentJobs.$inferSelect): MemoryAgentRunSummary {
    const metadata = parseJsonObject(row.metadataJson)
    const output = parseJsonObject(row.outputJson)
    const evidenceTurnIds = parseJsonArray(row.evidenceTurnIdsJson)
    const actionRows = this.handle.db
      .select()
      .from(memoryAgentActions)
      .where(eq(memoryAgentActions.jobId, row.id))
      .orderBy(memoryAgentActions.createdAt)
      .all()
    return {
      id: row.id,
      status: row.status,
      trigger: row.trigger,
      providerId: row.providerId as MemoryAgentRunSummary["providerId"],
      modelId: row.modelId,
      evidenceTurnCount: evidenceTurnIds.length,
      evidenceTokensEstimate: row.evidenceTokensEstimate,
      startedAt: row.startedAt,
      ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      ...(typeof output.summary === "string" && output.summary.trim() ? { output: output.summary } : {}),
      ...(typeof metadata.error === "string" ? { error: metadata.error } : {}),
      ...(typeof metadata.sequenceFrom === "number" ? { sequenceFrom: metadata.sequenceFrom } : {}),
      ...(typeof metadata.sequenceTo === "number" ? { sequenceTo: metadata.sequenceTo } : {}),
      ...(Array.isArray(metadata.toolEvents) ? { toolEvents: metadata.toolEvents } : {}),
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

  private readToolDocs(input: ToolDocsToolInput): ToolDocsToolOutput {
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const contextLines = clampContextLines(input.contextLines)
    const files = input.path ? [this.resolveToolDocPath(input.path, input.area)] : this.toolDocFiles(input.area)
    const results = this.docsResults(files, input, contextLines, charLimit)
    const sliced = results.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? DEFAULT_SEARCH_LIMIT)).map(numberResult)
    const output = capMemoryResults(sliced, charLimit)
    return {
      operation: "read",
      ...(input.area ? { area: input.area } : {}),
      results: output.results,
      totalMatches: results.length,
      truncation: output.truncation,
      ...(output.warnings.length > 0 ? { warnings: output.warnings } : {}),
    }
  }

  private searchToolDocs(input: ToolDocsToolInput): ToolDocsToolOutput {
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const contextLines = clampContextLines(input.contextLines)
    const files = input.path ? [this.resolveToolDocPath(input.path, input.area)] : this.toolDocFiles(input.area)
    const results = this.docsResults(files, input, contextLines, charLimit)
    const sliced = results.slice(input.offset ?? 0, (input.offset ?? 0) + limit).map(numberResult)
    const output = capMemoryResults(sliced, charLimit)
    const warnings = [
      ...output.warnings,
      ...(results.length > limit + (input.offset ?? 0) ? ["tool_docs search hit the result limit; narrow query, area, or path."] : []),
    ]
    return {
      operation: "search",
      ...(input.area ? { area: input.area } : {}),
      results: output.results,
      totalMatches: results.length,
      truncation: output.truncation,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  private docsResults(files: MemoryFile[], input: ToolDocsToolInput, contextLines: number, charLimit: number): DocsResult[] {
    const query = input.query?.trim()
    const mode = input.searchMode ?? "keyword_all"
    return files.flatMap((file) => {
      const content = fs.readFileSync(file.absolutePath, "utf8")
      if (input.includeSections) {
        const sectionResults = sectionMatches(file, content, input, mode, query, contextLines, charLimit)
        if (sectionResults.length > 0 || query || input.includeSections) {
          return sectionResults
        }
      }
      if (query) {
        return lineSearchResults(file, content, query, mode, contextLines)
      }
      return [fileResult(file, content, charLimit)]
    })
  }

  private toolDocFiles(area?: ToolDocsArea): MemoryFile[] {
    const candidates: MemoryFile[] = [
      ...listMarkdownFiles(path.join(this.socratesHome, "tool_usage")).map((absolutePath) => memoryFile(this.socratesHome, "tool_usage", absolutePath)),
    ].filter((file) => fs.existsSync(file.absolutePath))
    return candidates.filter((file) => (area ? file.area === area : true)).sort((left, right) => left.path.localeCompare(right.path))
  }

  private resolveToolDocPath(inputPath: string, area?: ToolDocsArea): MemoryFile {
    const normalized = normalizeToolDocPath(inputPath, area)
    const absolutePath = safeJoin(this.socratesHome, normalized)
    if (!absolutePath.endsWith(".md") || !fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new SocratesError("tool_docs_file_not_found", "Tool docs path was not found or is not a markdown file.", {
        recoverable: true,
        details: { path: inputPath },
      })
    }
    const file = memoryFile(this.socratesHome, "tool_usage", absolutePath)
    if (area && file.area !== area) {
      throw new SocratesError("tool_docs_area_mismatch", "Tool docs path does not match the requested area.", {
        recoverable: true,
        details: { path: inputPath, area },
      })
    }
    return file
  }

  private listSkillsOutput(input: SkillsToolInput, workspacePath: string | undefined): SkillsToolOutput {
    const skills = this.skillInfos(workspacePath, input.scope).map(skillSummary)
    const offset = input.offset ?? 0
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
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
    }
  }

  private searchSkills(input: SkillsToolInput, workspacePath: string | undefined): SkillsToolOutput {
    const query = input.query?.trim() ?? ""
    const compiled = compileSearch(query, "keyword_any")
    const matches = this.skillInfos(workspacePath, input.scope).filter((skill) => compiled.score(`${skill.name}\n${skill.description}\n${skill.content}`) > 0)
    const offset = input.offset ?? 0
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
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
    }
  }

  private readSkill(input: SkillsToolInput, workspacePath: string | undefined): SkillsToolOutput {
    const skill = this.findSkill(workspacePath, input.name ?? "", input.scope)
    if (!skill) {
      throw new SocratesError("skill_not_found", "Skill was not found.", { recoverable: true, details: { name: input.name, scope: input.scope } })
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
      operation: "read",
      skills: [skillSummary(skill)],
      content: truncated.text,
      path: path.relative(skill.root, targetPath).replaceAll(path.sep, "/"),
      totalMatches: 1,
      truncation: truncationFor(content, charLimit),
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

  private findSkill(workspacePath: string | undefined, name: string, scope?: SkillScope): SkillInfo | undefined {
    return this.skillInfos(workspacePath, scope).find((skill) => skill.name === name)
  }

  private projectRoot(projectId: string): string {
    return path.join(this.socratesHome, "projects", projectId)
  }

  private soulPath(document: "identity" | "operating_principles"): string {
    return path.join(this.socratesHome, `${document}.md`)
  }

  private memoryAgentModelSettingsFor(): MemoryAgentModelSettings {
    const settings = this.options.getMemoryAgentGlobalSettings?.()
    const thinkingEnabled = settings?.thinkingEnabled ?? DEFAULT_MEMORY_AGENT_THINKING_ENABLED
    const thinkingEffort = settings?.thinkingEffort ?? (thinkingEnabled ? undefined : DEFAULT_MEMORY_AGENT_THINKING_EFFORT)
    return {
      providerId: settings?.providerId ?? DEFAULT_MEMORY_AGENT_PROVIDER_ID,
      modelId: settings?.modelId ?? DEFAULT_MEMORY_AGENT_MODEL_ID,
      thinkingEnabled,
      ...(thinkingEffort ? { thinkingEffort } : {}),
    }
  }

  private async generateProjectSkill(projectId: string, workspacePath: string, request: string, name: string): Promise<string> {
    const fallback = fallbackSkillMarkdown(name, request)
    if (!this.options.provider) {
      return fallback
    }
    const modelSettings = this.memoryAgentModelSettingsFor()
    const instructionRow = this.handle.db
      .select()
      .from(projectInstructions)
      .where(and(eq(projectInstructions.projectId, projectId), eq(projectInstructions.status, "active")))
      .orderBy(desc(projectInstructions.updatedAt))
      .get()
    const context = [
      `Skill name to use exactly: ${name}`,
      "Primary user request:",
      request.trim(),
      "",
      "Side guidance only. Use when relevant; ignore when not useful.",
      "--- project instructions",
      instructionRow?.content ?? "Not provided.",
      "--- project MEMORY.md",
      truncate(readIfExists(path.join(workspacePath, ".socrates", "MEMORY.md")) ?? "", 4_000).text,
      "--- repo docs",
      ...REPO_DOC_NAMES.map((docName) => `--- ${docName}\n${truncate(readIfExists(path.join(workspacePath, ".socrates", "repo_docs", docName)) ?? "", 3_000).text}`),
      "--- skill writer guidance",
      truncate(readIfExists(path.join(bundledSkillsDir(), "socrates-skill-writer", "SKILL.md")) ?? "", 5_000).text,
    ].join("\n\n")
    try {
      let text = ""
      for await (const event of this.options.provider.stream({
        providerId: modelSettings.providerId,
        modelId: modelSettings.modelId,
        system: PROJECT_SKILL_BUILDER_SYSTEM_PROMPT,
        messages: [{ role: "user", content: context }],
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
      const cleaned = stripMarkdownFence(text.trim())
      return parseSkillMarkdown(cleaned, path.join(workspacePath, ".socrates", "skills", name, "SKILL.md")) ? cleaned : fallback
    } catch {
      return fallback
    }
  }

  private applyPrimaryPatch(
    projectId: string,
    jobId: string,
    turnId: string | undefined,
    targetKind: "tool_usage" | "skills",
    targetPath: string,
    patch: MemoryPatchProposal,
  ): { applied: boolean; actionId: string; error?: string } {
    const action = this.createMemoryAction(projectId, jobId, turnId, targetKind, targetPath, patch, false)
    const current = readIfExists(targetPath) ?? ""
    const validation = validateMemoryPatch(current, patch)
    if (!validation.ok) {
      this.rejectMemoryAction(action.actionId, validation.error)
      this.appendEvent({ projectId, ...(turnId ? { turnId } : {}), type: "memory.primary.update_rejected", source: "server", payload: { jobId, actionId: action.actionId, path: targetPath, reason: validation.error } })
      return { applied: false, actionId: action.actionId, error: validation.error }
    }
    if (targetKind === "skills" && path.basename(targetPath) === "SKILL.md" && !parseSkillMarkdown(validation.next, targetPath)) {
      const error = "Skill patch must preserve valid Agent Skill frontmatter with matching folder name."
      this.rejectMemoryAction(action.actionId, error)
      this.appendEvent({ projectId, ...(turnId ? { turnId } : {}), type: "memory.primary.update_rejected", source: "server", payload: { jobId, actionId: action.actionId, path: targetPath, reason: error } })
      return { applied: false, actionId: action.actionId, error }
    }
    fs.writeFileSync(targetPath, validation.next)
    const afterHash = hashText(validation.next)
    this.handle.db.update(memoryAgentActions).set({ status: "applied", afterHash, appliedAt: nowIso() }).where(eq(memoryAgentActions.id, action.actionId)).run()
    this.appendEvent({
      projectId,
      ...(turnId ? { turnId } : {}),
      type: "memory.primary.updated",
      source: "server",
      payload: { jobId, actionId: action.actionId, path: targetPath, targetKind, rationale: patch.rationale },
    })
    return { applied: true, actionId: action.actionId }
  }

  private async applySoulPatch(
    projectId: string,
    jobId: string,
    latest: { conversationId?: string; sessionId?: string; turnId?: string } | undefined,
    patch: MemoryPatchProposal,
    modelSettings: MemoryAgentModelSettings,
  ): Promise<{ applied: boolean; actionId: string; error?: string }> {
    const document = patch.document
    const targetPath = document === "identity" || document === "operating_principles" ? this.soulPath(document) : this.soulPath("identity")
    const action = this.createMemoryAction(projectId, jobId, latest?.turnId, "soul", targetPath, patch, true)
    if (document !== "identity" && document !== "operating_principles") {
      const error = "Soul patch must target identity or operating_principles."
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
    fs.writeFileSync(targetPath, validation.next)
    const afterHash = hashText(validation.next)
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
    targetKind: "tool_usage" | "skills" | "soul",
    targetPath: string,
    patch: MemoryPatchProposal,
    requiresConfirmation: boolean,
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
        "If the edit is evidence-backed, narrow, durable, and appropriate for identity/principles, answer yes.",
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
const repoDocsRoot = (workspacePath: string): string => path.join(workspacePath, ".socrates", "repo_docs")

const repoDocPath = (docsRoot: string, name: (typeof REPO_DOC_NAMES)[number]): string => path.join(docsRoot, name)

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
    if (!fs.existsSync(targetPath) || isLegacyToolUsageSeed(name, fs.readFileSync(targetPath, "utf8"))) {
      fs.writeFileSync(targetPath, content)
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
  copyIfMissing(path.join(primaryRoot, "operating_principles.md"), path.join(socratesHome, "operating_principles.md"))
  const oldLearned = readIfExists(path.join(primaryRoot, "learned_patterns.md"))
  if (oldLearned?.trim()) {
    ensureFile(path.join(socratesHome, "skills", "general", "SKILL.md"), fallbackSkillMarkdown("general", oldLearned.trim()))
  }
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

const isLegacyToolUsageSeed = (name: string, content: string): boolean => {
  const trimmed = content.trim()
  if (trimmed.length > 500) {
    return false
  }
  return (
    (name === "trace_retrieve.md" && trimmed.includes("Use as an investigation tool: browse recent/project conversations without query")) ||
    (name === "edit_apply_patch.md" && trimmed.includes("Use patch/edit for file writes and Terminal for execution")) ||
    (name === "read_search.md" && trimmed.includes("Use bounded reads and targeted searches"))
  )
}

const PROJECT_SKILL_BUILDER_SYSTEM_PROMPT = [
  "You generate one Agent Skill for Socrates.",
  "Return only the complete SKILL.md markdown. Do not include a markdown fence, prefix, or suffix.",
  "The provided skill name is mandatory and must appear exactly in YAML frontmatter.",
  "YAML frontmatter must include name and description.",
  "The user's primary request is the main authority. Project instructions, memory, repo docs, and skill-writer guidance are side guidance only; ignore them when irrelevant.",
  "Keep the skill concise, procedural, and reusable. Do not include secrets, private keys, or long copied project text.",
].join("\n")

const stripMarkdownFence = (text: string): string => {
  const match = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(text.trim())
  return match?.[1]?.trim() ?? text.trim()
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

const memoryFile = (root: string, area: ToolDocsArea, absolutePath: string): MemoryFile => {
  const stats = fs.statSync(absolutePath)
  const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, "/")
  return {
    path: relativePath,
    absolutePath,
    area,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  }
}

const normalizeToolDocPath = (inputPath: string, area?: ToolDocsArea): string => {
  const normalized = inputPath.replaceAll("\\", "/").replace(/^\/+/, "")
  if (normalized.startsWith("tool_usage/")) {
    return normalized
  }
  if (area === "tool_usage") {
    return `tool_usage/${normalized}`
  }
  return normalized.includes("/") ? normalized : `tool_usage/${normalized}`
}

const lineSearchResults = (file: MemoryFile, content: string, query: string, mode: DocsSearchMode, contextLines: number): DocsResult[] => {
  const lines = content.split(/\r?\n/)
  const compiled = compileSearch(query, mode)
  return lines.flatMap((line, index) => {
    const score = compiled.score(line)
    if (score <= 0) {
      return []
    }
    return [lineWindowResult(file, lines, index, index, line, score, "line_match", contextLines)]
  })
}

const sectionMatches = (
  file: MemoryFile,
  content: string,
  _input: ToolDocsToolInput,
  mode: DocsSearchMode,
  query: string | undefined,
  contextLines: number,
  charLimit: number,
): DocsResult[] => {
  const lines = content.split(/\r?\n/)
  const sections = markdownSections(lines)
  const compiled = query ? compileSearch(query, mode) : undefined
  return sections.flatMap((section) => {
    const text = lines.slice(section.start, section.end + 1).join("\n")
    const score = compiled ? compiled.score(text) : 1
    if (compiled && score <= 0) {
      return []
    }
    const clipped = truncateToContextBudget(text, charLimit)
    return [
      {
        resultNumber: 0,
        resultType: "section",
        path: file.path,
        title: section.title,
        matchedText: query ? bestMatchingLine(text, query, mode) : section.title,
        snippet: clipped,
        modifiedAt: file.modifiedAt,
        lineStart: section.start + 1,
        lineEnd: section.end + 1,
        ...(contextLines > 0
          ? {
              contextBefore: truncateToContextBudget(lines.slice(Math.max(0, section.start - contextLines), section.start).join("\n"), MAX_CONTEXT_CHARS),
              contextAfter: truncateToContextBudget(lines.slice(section.end + 1, Math.min(lines.length, section.end + 1 + contextLines)).join("\n"), MAX_CONTEXT_CHARS),
            }
          : {}),
      },
    ]
  })
}

const fileResult = (file: MemoryFile, content: string, charLimit: number): DocsResult => ({
  resultNumber: 0,
  resultType: "file",
  path: file.path,
  title: firstHeading(content),
  snippet: truncateToContextBudget(content, charLimit),
  modifiedAt: file.modifiedAt,
  lineStart: 1,
  lineEnd: content.split(/\r?\n/).length,
})

const lineWindowResult = (
  file: MemoryFile,
  lines: string[],
  startIndex: number,
  endIndex: number,
  matchedText: string,
  _score: number,
  resultType: DocsResult["resultType"],
  contextLines: number,
): DocsResult => {
  const contextBefore = lines.slice(Math.max(0, startIndex - contextLines), startIndex).join("\n")
  const contextAfter = lines.slice(endIndex + 1, Math.min(lines.length, endIndex + 1 + contextLines)).join("\n")
  return {
    resultNumber: 0,
    resultType,
    path: file.path,
    title: nearestHeading(lines, startIndex),
    matchedText: matchedText.slice(0, 2_000),
    contextBefore: truncateToContextBudget(contextBefore, MAX_CONTEXT_CHARS),
    contextAfter: truncateToContextBudget(contextAfter, MAX_CONTEXT_CHARS),
    snippet: truncateToContextBudget([contextBefore, matchedText, contextAfter].filter(Boolean).join("\n"), MAX_CONTEXT_CHARS),
    modifiedAt: file.modifiedAt,
    lineStart: startIndex + 1,
    lineEnd: endIndex + 1,
  }
}

const numberResult = (result: DocsResult, index: number): DocsResult => ({ ...result, resultNumber: index + 1 })

const capMemoryResults = (results: DocsResult[], charLimit: number): { results: DocsResult[]; truncation: TruncationMetadata; warnings: string[] } => {
  const warnings: string[] = []
  let used = 0
  const capped: DocsResult[] = []
  for (const result of results) {
    const serializedLength = JSON.stringify(result).length
    if (used + serializedLength > charLimit && capped.length > 0) {
      warnings.push("Tool docs output was truncated by charLimit; narrow filters or increase charLimit.")
      break
    }
    used += serializedLength
    capped.push(result)
  }
  return {
    results: capped,
    truncation: {
      truncated: capped.length < results.length,
      charLimit,
      originalLength: JSON.stringify(results).length,
      returnedLength: JSON.stringify(capped).length,
    },
    warnings,
  }
}

const compileSearch = (query: string, mode: DocsSearchMode): { score: (text: string) => number } => {
  const lowerQuery = query.toLowerCase()
  const terms = searchTerms(query)
  if (mode === "regex") {
    let regex: RegExp
    try {
      regex = new RegExp(query, "i")
    } catch (error) {
      throw new SocratesError("tool_docs_invalid_regex", "tool_docs regex query is invalid.", {
        recoverable: true,
        details: { message: error instanceof Error ? error.message : String(error) },
      })
    }
    return { score: (text) => (regex.test(text) ? 70 : 0) }
  }
  if (mode === "exact_phrase") {
    return { score: (text) => countCaseInsensitive(text, lowerQuery) * 100 }
  }
  if (mode === "whole_word") {
    const regexes = terms.map((term) => new RegExp(`\\b${escapeRegExp(term)}\\b`, "i"))
    return { score: (text) => (regexes.length > 0 && regexes.every((regex) => regex.test(text)) ? 90 + regexes.length : 0) }
  }
  if (mode === "keyword_any") {
    return { score: (text) => terms.filter((term) => text.toLowerCase().includes(term)).length * 50 }
  }
  return {
    score: (text) => {
      const lower = text.toLowerCase()
      const matched = terms.filter((term) => lower.includes(term)).length
      return terms.length > 0 && matched === terms.length ? 80 + matched : 0
    },
  }
}

const searchTerms = (query: string): string[] => query.toLowerCase().match(/[a-z0-9_./:-]+/g)?.filter((term) => term.length > 0) ?? []

const countCaseInsensitive = (text: string, lowerNeedle: string): number => {
  if (!lowerNeedle.trim()) {
    return 0
  }
  return text.toLowerCase().split(lowerNeedle).length - 1
}

const bestMatchingLine = (text: string, query: string, mode: DocsSearchMode): string => {
  const compiled = compileSearch(query, mode)
  return text.split(/\r?\n/).find((line) => compiled.score(line) > 0)?.slice(0, 2_000) ?? query
}

const markdownSections = (lines: string[]): Array<{ title: string; start: number; end: number }> => {
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^#{1,6}\s+/.test(line))
    .map(({ line, index }) => ({ title: line.replace(/^#{1,6}\s+/, "").trim(), start: index }))
  if (headings.length === 0) {
    return lines.length === 0 ? [] : [{ title: "Full file", start: 0, end: lines.length - 1 }]
  }
  return headings.map((heading, index) => ({
    title: heading.title,
    start: heading.start,
    end: (headings[index + 1]?.start ?? lines.length) - 1,
  }))
}

const firstHeading = (content: string): string | undefined => /^#{1,6}\s+(.+)$/m.exec(content)?.[1]?.trim()

const nearestHeading = (lines: string[], index: number): string | undefined => {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const heading = /^#{1,6}\s+(.+)$/.exec(lines[cursor] ?? "")
    if (heading?.[1]) {
      return heading[1].trim()
    }
  }
  return undefined
}

const clampContextLines = (value?: number): number => Math.min(value ?? DEFAULT_CONTEXT_LINES, 100)

const truncateToContextBudget = (text: string, charLimit: number): string => truncate(text, Math.min(charLimit, MAX_CONTEXT_CHARS)).text

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

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

const slimMemoryToolEvent = (event: { type: string; toolName?: unknown; summary?: unknown; error?: unknown; argsPreview?: unknown; resultPreview?: unknown }): Record<string, unknown> => ({
  type: event.type,
  ...(typeof event.toolName === "string" ? { toolName: event.toolName } : {}),
  ...(typeof event.argsPreview === "string" ? { argsPreview: event.argsPreview.slice(0, 500) } : {}),
  ...(typeof event.summary === "string" ? { summary: event.summary.slice(0, 500) } : {}),
  ...(typeof event.resultPreview === "string" ? { resultPreview: event.resultPreview.slice(0, 500) } : {}),
  ...(event.error && typeof event.error === "object" && "message" in event.error ? { error: String((event.error as { message?: unknown }).message ?? "") } : {}),
})

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

const bestExcerpt = (content: string, query: string, limit: number): string => {
  const terms = query.toLowerCase().match(/[a-z0-9_./:-]+/g)?.filter((term) => term.length > 2) ?? []
  const lower = content.toLowerCase()
  const anchors = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0)
  const anchor = anchors[0] ?? 0
  const start = Math.max(0, anchor - Math.floor(limit / 2))
  return content.slice(start, start + limit)
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

const capByEstimatedTokens = (text: string, tokenLimit: number): string => {
  if (estimateTextTokens(text).inputTokens <= tokenLimit) {
    return text
  }
  return text.slice(0, tokenLimit * 4)
}
