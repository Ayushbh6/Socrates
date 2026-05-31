import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  Notification,
  ProjectNotesToolInput,
  ProjectNotesToolOutput,
  SoulToolInput,
  SoulToolOutput,
  SocratesMemoryCategory,
  SocratesMemoryScope,
  SocratesMemorySearchMode,
  SocratesMemoryToolInput,
  SocratesMemoryToolOutput,
  TruncationMetadata,
} from "@socrates/contracts"
import type { ModelProvider, ProviderCredentialResolver } from "@socrates/providers"
import { estimateTextTokens } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { eq, inArray } from "drizzle-orm"
import { events, fileOperations, memoryAgentActions, memoryAgentConfirmations, memoryAgentJobs, messages, patches, shellCommands, shellOutputChunks, toolCalls, turns } from "../../db/schema"
import { StoreBase } from "./shared"

const DEFAULT_CHAR_LIMIT = 20_000
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_CONTEXT_LINES = 8
const MAX_CONTEXT_CHARS = 28_000
const MEMORY_AGENT_TOKEN_CAP = 60_000
const DEFAULT_MEMORY_AGENT_IDLE_MS = 5 * 60 * 1000
const WAKE_CONTEXT_CHAR_LIMIT = 4_000
const SOUL_CONFIRMATION_PROMPT = "You are about to make changes to the soul. Are you sure?\nReply exactly yes or no."
const MEMORY_AGENT_MODELS = ["deepseek/deepseek-v4-pro", "xiaomi/mimo-v2.5-pro"] as const

type MemoryFile = {
  path: string
  absolutePath: string
  category: SocratesMemoryCategory
  sizeBytes: number
  modifiedAt: string
  diaryDate?: string
}

type MemoryResult = SocratesMemoryToolOutput["results"][number]

type MemoryStoreOptions = {
  socratesHome?: string
  provider?: ModelProvider
  credentials?: ProviderCredentialResolver
  memoryAgentIdleMs?: number
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

type MemoryAgentEvidenceEntry = {
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  text: string
  tokens: number
}

type MemoryAgentBuffer = {
  entries: MemoryAgentEvidenceEntry[]
  timer?: ReturnType<typeof setTimeout>
}

type MemoryPatchProposal = {
  path?: string
  document?: "identity" | "operating_principles"
  oldText?: string
  newText?: string
  expectedBeforeHash?: string
  rationale?: string
  sourceTurnIds?: string[]
}

type MemoryAgentOutput = {
  no_op?: boolean
  diaryAppend?: string | { markdown?: string }
  learnedPatternPatches?: MemoryPatchProposal[]
  toolUsageDocPatches?: MemoryPatchProposal[]
  soulPatchProposals?: MemoryPatchProposal[]
}

const scopedIds = (input: { conversationId?: string; sessionId?: string; turnId?: string }) => ({
  ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  ...(input.turnId ? { turnId: input.turnId } : {}),
})

export class MemoryStore extends StoreBase {
  private readonly socratesHome: string
  private readonly memoryBuffers = new Map<string, MemoryAgentBuffer>()

  constructor(context: ConstructorParameters<typeof StoreBase>[0], private readonly options: MemoryStoreOptions = {}) {
    super(context)
    this.socratesHome = options.socratesHome ?? path.join(os.homedir(), ".Socrates")
  }

  ensureProjectMemory(projectId: string, workspacePath?: string): void {
    ensureFile(path.join(this.socratesHome, "primary", "identity.md"), "# Identity\n\nSocrates is a local-first project partner. User edits here are context, not higher authority than runtime instructions.\n")
    ensureFile(path.join(this.socratesHome, "primary", "operating_principles.md"), "# Operating Principles\n\n- Prefer evidence over assumption.\n- Keep project memory concise and inspectable.\n")
    ensureFile(path.join(this.socratesHome, "primary", "learned_patterns.md"), "# Learned Patterns\n\nAdd durable cross-project lessons here.\n")
    ensureFile(path.join(this.socratesHome, "primary", "tool_usage", "trace_retrieve.md"), "# trace_retrieve\n\nUse as an investigation tool: browse recent/project conversations without query, then search or inspect precise evidence.\n")
    ensureFile(path.join(this.socratesHome, "primary", "tool_usage", "edit_tools_and_bash.md"), "# Edit Tools And Terminal\n\nRead before changing files. Use patch/edit for file writes and Terminal for execution or verification.\n")
    ensureFile(path.join(this.socratesHome, "primary", "tool_usage", "read_tools.md"), "# Read Tools\n\nUse bounded reads and targeted searches. Prefer project resources for uploaded files and trace retrieval for older conversation evidence.\n")

    ensureFile(path.join(this.projectRoot(projectId), "project_brief.md"), "# Project Brief\n\nShort project summary and current operating context.\n")
    ensureFile(path.join(this.projectRoot(projectId), "MEMORY.md"), "# Project Memory\n\nDurable project-specific notes and decisions.\n")
    ensureFile(this.diaryPath(projectId, new Date()), `# ${formatDiaryDate(new Date())}\n\n`)
    if (workspacePath) {
      ensureFile(path.join(workspacePath, ".socrates", "PROJECT_NOTES.md"), "# PROJECT_NOTES\n\nRepo-local notes for Socrates. Users may edit this file directly.\n")
    }
  }

  runSocratesMemoryTool(projectId: string, workspacePath: string | undefined, input: SocratesMemoryToolInput): SocratesMemoryToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    if (input.operation === "read") {
      return this.readMemory(projectId, input)
    }
    return this.searchMemory(projectId, input)
  }

  runProjectNotesTool(projectId: string, workspacePath: string, input: ProjectNotesToolInput): ProjectNotesToolOutput {
    this.ensureProjectMemory(projectId, workspacePath)
    const notesPath = projectNotesPath(workspacePath)
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const content = fs.readFileSync(notesPath, "utf8")
    if (input.operation === "read") {
      const truncated = truncate(content, charLimit)
      return {
        operation: "read",
        path: notesPath,
        content: truncated.text,
        truncation: truncationFor(content, charLimit),
        ...(truncated.truncated ? { warnings: ["PROJECT_NOTES.md was truncated. Re-read with a larger charLimit if needed."] } : {}),
      }
    }
    if (input.operation === "search") {
      const matches = lineMatches(content, input.query as string, DEFAULT_SEARCH_LIMIT)
      return {
        operation: "search",
        path: notesPath,
        matches: matches.map((match) => ({ line: match.line, text: match.text })),
        truncation: truncationFor(JSON.stringify(matches), charLimit),
        ...(matches.length === DEFAULT_SEARCH_LIMIT ? { warnings: ["PROJECT_NOTES.md search hit the match limit; narrow the query."] } : {}),
      }
    }
    const oldText = input.oldText ?? ""
    const newText = input.newText ?? ""
    const occurrences = oldText.length === 0 ? 0 : countOccurrences(content, oldText)
    if (oldText.length === 0 || occurrences === 0) {
      throw new SocratesError("project_notes_patch_failed", "oldText was not found in PROJECT_NOTES.md.", { recoverable: true })
    }
    if (!input.replaceAll && occurrences > 1) {
      throw new SocratesError("project_notes_patch_ambiguous", "oldText matched more than once. Retry with a longer oldText or replaceAll=true.", {
        recoverable: true,
        details: { occurrences },
      })
    }
    const next = input.replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText)
    fs.writeFileSync(notesPath, next)
    return {
      operation: "patch",
      path: notesPath,
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
        path: `primary/${document}.md`,
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
    const projectMemory = readIfExists(path.join(this.projectRoot(projectId), "MEMORY.md"))
    const projectBrief = readIfExists(path.join(this.projectRoot(projectId), "project_brief.md"))
    const notes = workspacePath ? readIfExists(projectNotesPath(workspacePath)) : undefined
    const diary = readIfExists(this.latestDiaryPath(projectId) ?? "")
    const query = userQuery.trim()
    for (const [label, content] of [
      ["Project brief", projectBrief],
      ["Project memory", projectMemory],
      ["PROJECT_NOTES", notes],
      ["Recent diary", diary],
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

  appendDiaryForTurn(input: { projectId: string; conversationId: string; sessionId: string; turnId: string; workspacePath?: string }): void {
    void this.enqueueMemoryAgentForTurn(input).catch((error) => {
      this.appendEvent({
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: "memory.agent.failed",
        source: "server",
        payload: { message: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  private readMemory(projectId: string, input: SocratesMemoryToolInput): SocratesMemoryToolOutput {
    const scope = input.scope ?? "project"
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const contextLines = clampContextLines(input.contextLines)
    const files = input.path ? [this.resolveMemoryPath(projectId, input.path, input.category)] : this.memoryFiles(projectId, input)
    const results = this.memoryResults(files, input, contextLines, charLimit)
    const sliced = results.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? DEFAULT_SEARCH_LIMIT)).map(numberResult)
    const output = capMemoryResults(sliced, charLimit)
    return {
      operation: "read",
      scope,
      ...(input.category ? { category: input.category } : {}),
      results: output.results,
      totalMatches: results.length,
      truncation: output.truncation,
      ...(output.warnings.length > 0 ? { warnings: output.warnings } : {}),
    }
  }

  private searchMemory(projectId: string, input: SocratesMemoryToolInput): SocratesMemoryToolOutput {
    const scope = input.scope ?? "project"
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const contextLines = clampContextLines(input.contextLines)
    const files = input.path ? [this.resolveMemoryPath(projectId, input.path, input.category)] : this.memoryFiles(projectId, input)
    const results = this.memoryResults(files, input, contextLines, charLimit)
    const sliced = results.slice(input.offset ?? 0, (input.offset ?? 0) + limit).map(numberResult)
    const output = capMemoryResults(sliced, charLimit)
    const warnings = [
      ...output.warnings,
      ...(results.length > limit + (input.offset ?? 0) ? ["Socrates memory search hit the result limit; narrow query, category, scope, or date filters."] : []),
    ]
    return {
      operation: "search",
      scope,
      ...(input.category ? { category: input.category } : {}),
      results: output.results,
      totalMatches: results.length,
      truncation: output.truncation,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  private memoryResults(files: MemoryFile[], input: SocratesMemoryToolInput, contextLines: number, charLimit: number): MemoryResult[] {
    const query = input.query?.trim()
    const mode = input.searchMode ?? "keyword_all"
    return files.flatMap((file) => {
      const content = fs.readFileSync(file.absolutePath, "utf8")
      if (input.includeSections || file.category === "diary") {
        const sectionResults = sectionMatches(file, content, input, mode, query, contextLines, charLimit)
        if (sectionResults.length > 0 || query || input.includeSections || file.category === "diary") {
          return sectionResults
        }
      }
      if (query) {
        return lineSearchResults(file, content, query, mode, contextLines)
      }
      return [fileResult(file, content, charLimit)]
    })
  }

  private memoryFiles(projectId: string, input: SocratesMemoryToolInput): MemoryFile[] {
    const files = this.allMemoryFiles(projectId, input.scope ?? "project", input.category)
    return files
      .filter((file) => withinRange(file.modifiedAt, input.modifiedAfter, input.modifiedBefore))
      .filter((file) => withinDiaryFilters(file, input))
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path))
      .slice(input.memoryOffset ?? 0, (input.memoryOffset ?? 0) + (input.memoryLimit ?? 50))
  }

  private allMemoryFiles(projectId: string, scope: SocratesMemoryScope, category?: SocratesMemoryCategory): MemoryFile[] {
    const primaryRoot = path.join(this.socratesHome, "primary")
    const projectRoot = this.projectRoot(projectId)
    const candidates: MemoryFile[] = [
      memoryFile(primaryRoot, "learned_patterns", path.join(primaryRoot, "learned_patterns.md")),
      ...listMarkdownFiles(path.join(primaryRoot, "tool_usage")).map((absolutePath) => memoryFile(primaryRoot, "tool_usage", absolutePath)),
      memoryFile(projectRoot, "project_brief", path.join(projectRoot, "project_brief.md")),
      memoryFile(projectRoot, "project_memory", path.join(projectRoot, "MEMORY.md")),
      ...listMarkdownFiles(path.join(projectRoot, "diary")).map((absolutePath) => memoryFile(projectRoot, "diary", absolutePath)),
    ].filter((file) => fs.existsSync(file.absolutePath))
    return candidates.filter((file) => (category ? file.category === category : categoryForScope(scope, file.category)))
  }

  private resolveMemoryPath(projectId: string, inputPath: string, category?: SocratesMemoryCategory): MemoryFile {
    const normalized = normalizeMemoryPath(inputPath, category)
    if (normalized === "primary/identity.md" || normalized === "primary/operating_principles.md") {
      throw new SocratesError("socrates_memory_core_soul_not_tool_visible", "Identity and operating principles are core agent soul files and are not exposed through socrates_memory.", {
        recoverable: true,
      })
    }
    const root = normalized.startsWith("primary/") ? path.join(this.socratesHome, "primary") : this.projectRoot(projectId)
    const relative = normalized.replace(/^(primary|project)\//, "")
    const absolutePath = safeJoin(root, relative)
    if (!absolutePath.endsWith(".md") || !fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new SocratesError("socrates_memory_file_not_found", "Socrates memory path was not found or is not a markdown file.", {
        recoverable: true,
        details: { path: inputPath },
      })
    }
    const file = memoryFile(root, inferCategoryFromPath(normalized), absolutePath)
    if (category && file.category !== category) {
      throw new SocratesError("socrates_memory_category_mismatch", "Socrates memory path does not match the requested category.", {
        recoverable: true,
        details: { path: inputPath, category },
      })
    }
    return file
  }

  private projectRoot(projectId: string): string {
    return path.join(this.socratesHome, "projects", projectId)
  }

  private diaryPath(projectId: string, date: Date): string {
    const year = date.getFullYear().toString()
    const month = String(date.getMonth() + 1).padStart(2, "0")
    return path.join(this.projectRoot(projectId), "diary", year, month, `${formatDiaryDate(date)}.md`)
  }

  private latestDiaryPath(projectId: string): string | undefined {
    return listMarkdownFiles(path.join(this.projectRoot(projectId), "diary")).sort((left, right) => right.localeCompare(left))[0]
  }

  private soulPath(document: "identity" | "operating_principles"): string {
    return path.join(this.socratesHome, "primary", `${document}.md`)
  }

  private async enqueueMemoryAgentForTurn(input: { projectId: string; conversationId: string; sessionId: string; turnId: string; workspacePath?: string }): Promise<void> {
    this.ensureProjectMemory(input.projectId, input.workspacePath)
    if (!this.options.provider) {
      return
    }
    if (this.options.credentials && !this.options.credentials.getApiKey("openrouter")) {
      this.appendEvent({
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: "memory.agent.skipped",
        source: "server",
        payload: { reason: "OpenRouter credential is not configured." },
      })
      return
    }
    const turnEvidence = this.turnEvidence(input.projectId, input.turnId)
    if (!turnEvidence.trim()) {
      return
    }
    const entry: MemoryAgentEvidenceEntry = {
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      text: turnEvidence,
      tokens: estimateTextTokens(turnEvidence).inputTokens,
    }
    const buffer = this.memoryBuffers.get(input.projectId) ?? { entries: [] }
    buffer.entries.push(entry)
    if (buffer.timer) {
      clearTimeout(buffer.timer)
    }
    const totalTokens = buffer.entries.reduce((sum, item) => sum + item.tokens, 0)
    if (totalTokens >= MEMORY_AGENT_TOKEN_CAP) {
      this.memoryBuffers.delete(input.projectId)
      await this.runMemoryAgentBatch(input.projectId, buffer.entries, "buffer_limit")
      return
    }
    const idleMs = this.options.memoryAgentIdleMs ?? DEFAULT_MEMORY_AGENT_IDLE_MS
    buffer.timer = setTimeout(() => {
      const current = this.memoryBuffers.get(input.projectId)
      if (!current) {
        return
      }
      this.memoryBuffers.delete(input.projectId)
      void this.runMemoryAgentBatch(input.projectId, current.entries, "idle").catch((error) => {
        this.appendEvent({
          projectId: input.projectId,
          conversationId: input.conversationId,
          sessionId: input.sessionId,
          turnId: input.turnId,
          type: "memory.agent.failed",
          source: "server",
          payload: { message: error instanceof Error ? error.message : String(error) },
        })
      })
    }, idleMs)
    buffer.timer.unref?.()
    this.memoryBuffers.set(input.projectId, buffer)
  }

  private async runMemoryAgentBatch(projectId: string, entries: MemoryAgentEvidenceEntry[], trigger: "buffer_limit" | "idle" | "manual" | "turn_completed"): Promise<void> {
    if (entries.length === 0 || !this.options.provider) {
      return
    }
    const latest = entries[entries.length - 1]
    const jobId = createId("memjob")
    const startedAt = nowIso()
    const evidenceTokensEstimate = entries.reduce((sum, entry) => sum + entry.tokens, 0)
    this.handle.db
      .insert(memoryAgentJobs)
      .values({
        id: jobId,
        projectId,
        conversationId: latest?.conversationId,
        sessionId: latest?.sessionId,
        turnId: latest?.turnId,
        status: "running",
        trigger,
        providerId: "openrouter",
        modelId: MEMORY_AGENT_MODELS[0],
        fallbackModelIdsJson: JSON.stringify(MEMORY_AGENT_MODELS.slice(1)),
        evidenceTurnIdsJson: JSON.stringify(entries.map((entry) => entry.turnId)),
        evidenceTokensEstimate,
        startedAt,
      })
      .run()
    this.appendEvent({
      projectId,
      ...scopedIds(latest ?? {}),
      type: "memory.agent.started",
      source: "server",
      payload: { jobId, projectId, trigger, evidenceTokensEstimate },
    })

    try {
      let parsed: MemoryAgentOutput | undefined
      let usedModelId: string = MEMORY_AGENT_MODELS[0]
      let lastError: unknown
      const cappedEvidence = capByEstimatedTokens(this.buildMemoryAgentInput(projectId, entries), MEMORY_AGENT_TOKEN_CAP)
      for (const modelId of MEMORY_AGENT_MODELS) {
        try {
          parsed = parseMemoryAgentOutput(await this.runMemoryAgentModel(modelId, cappedEvidence))
          usedModelId = modelId
          break
        } catch (error) {
          lastError = error
        }
      }
      if (!parsed) {
        throw lastError ?? new SocratesError("memory_agent_empty", "Memory agent returned no parseable output.", { recoverable: true })
      }
      const applied = await this.applyMemoryAgentOutput(projectId, jobId, latest, parsed, usedModelId)
      this.handle.db
        .update(memoryAgentJobs)
        .set({
          status: applied.noOp ? "no_op" : "completed",
          modelId: usedModelId,
          outputJson: JSON.stringify(parsed),
          completedAt: nowIso(),
        })
        .where(eq(memoryAgentJobs.id, jobId))
        .run()
      this.appendEvent({
        projectId,
        ...scopedIds(latest ?? {}),
        type: "memory.agent.completed",
        source: "server",
        payload: {
          jobId,
          status: applied.noOp ? "no_op" : "completed",
          modelId: usedModelId,
          diaryAppended: applied.diaryAppended,
          actionsApplied: applied.actionsApplied,
          actionsRejected: applied.actionsRejected,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.handle.db.update(memoryAgentJobs).set({ status: "failed", completedAt: nowIso(), metadataJson: JSON.stringify({ error: message }) }).where(eq(memoryAgentJobs.id, jobId)).run()
      this.appendEvent({
        projectId,
        ...scopedIds(latest ?? {}),
        type: "memory.agent.failed",
        source: "server",
        payload: { jobId, error: { code: "memory_agent_failed", message } },
      })
    }
  }

  private buildMemoryAgentInput(projectId: string, entries: MemoryAgentEvidenceEntry[]): string {
    const primaryRoot = path.join(this.socratesHome, "primary")
    const targetSnippets = [
      ["identity.md", readIfExists(path.join(primaryRoot, "identity.md"))],
      ["operating_principles.md", readIfExists(path.join(primaryRoot, "operating_principles.md"))],
      ["learned_patterns.md", readIfExists(path.join(primaryRoot, "learned_patterns.md"))],
      ["tool_usage/trace_retrieve.md", readIfExists(path.join(primaryRoot, "tool_usage", "trace_retrieve.md"))],
      ["tool_usage/edit_tools_and_bash.md", readIfExists(path.join(primaryRoot, "tool_usage", "edit_tools_and_bash.md"))],
      ["tool_usage/read_tools.md", readIfExists(path.join(primaryRoot, "tool_usage", "read_tools.md"))],
    ] as const
    return [
      `Project: ${projectId}`,
      `Evidence turn ids: ${entries.map((entry) => entry.turnId).join(", ")}`,
      "Current target memory files with hashes:",
      ...targetSnippets.map(([label, content]) => {
        const text = content ?? ""
        return `--- ${label}\nsha256: ${hashText(text)}\n${truncate(text, 8_000).text}`
      }),
      "Turn evidence:",
      ...entries.map((entry) => entry.text),
    ].join("\n\n")
  }

  private turnEvidence(projectId: string, turnId: string): string {
    const turn = this.handle.db.select().from(turns).where(eq(turns.id, turnId)).limit(1).get()
    if (!turn) {
      return ""
    }
    const messageRows = this.handle.db.select().from(messages).where(eq(messages.turnId, turnId)).orderBy(messages.createdAt).all()
    const toolRows = this.handle.db.select().from(toolCalls).where(eq(toolCalls.turnId, turnId)).orderBy(toolCalls.startedAt).all()
    const toolIds = toolRows.map((tool) => tool.id)
    const fileRows = this.handle.db.select().from(fileOperations).where(eq(fileOperations.turnId, turnId)).orderBy(fileOperations.startedAt).all()
    const patchRows = this.handle.db.select().from(patches).where(eq(patches.turnId, turnId)).orderBy(patches.createdAt).all()
    const shellRows = this.handle.db.select().from(shellCommands).where(eq(shellCommands.turnId, turnId)).orderBy(shellCommands.startedAt).all()
    const shellChunks =
      shellRows.length > 0
        ? this.handle.db.select().from(shellOutputChunks).where(inArray(shellOutputChunks.shellCommandId, shellRows.map((row) => row.id))).orderBy(shellOutputChunks.sequence).all()
        : []
    const eventRows = this.handle.db.select().from(events).where(eq(events.turnId, turnId)).orderBy(events.sequence).all()
    return [
      `Project: ${projectId}`,
      `Turn: ${turnId}`,
      ...messageRows.map((message) => `[${message.role}]\n${sanitizeForDiary(message.content)}`),
      ...toolRows.map((tool) => `[tool ${tool.toolName} ${tool.status}]\nArguments: ${sanitizeForDiary(tool.argumentsJson)}\nResult: ${sanitizeForDiary(tool.resultJson ?? "")}`),
      ...fileRows.map((file) => `[file ${file.operation} ${file.status}]\n${file.path}\nBefore: ${file.contentHashBefore ?? ""}\nAfter: ${file.contentHashAfter ?? ""}\nMetadata: ${sanitizeForDiary(file.metadataJson ?? "")}`),
      ...patchRows.map((patch) => `[patch ${patch.status}]\n${sanitizeForDiary(patch.diffText).slice(0, 8_000)}`),
      ...shellRows.map((shell) => {
        const output = shellChunks
          .filter((chunk) => chunk.shellCommandId === shell.id)
          .map((chunk) => `[${chunk.stream}] ${chunk.text}`)
          .join("\n")
        return `[shell ${shell.status}]\n${sanitizeForDiary(shell.command)}\n${sanitizeForDiary(output).slice(0, 8_000)}`
      }),
      ...eventRows
        .filter((event) => !["agent.answer.delta", "agent.thinking.delta"].includes(event.type))
        .map((event) => `[event ${event.type}]\n${sanitizeForDiary(event.payloadJson).slice(0, 4_000)}`),
      toolIds.length > 0 ? `Tool ids: ${toolIds.join(", ")}` : "",
    ].join("\n\n")
  }

  private async runMemoryAgentModel(modelId: string, evidence: string): Promise<string> {
    let text = ""
    for await (const event of this.options.provider!.stream({
      providerId: "openrouter",
      modelId,
      system: MEMORY_AGENT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: evidence }],
      runtimeConfig: {
        providerId: "openrouter",
        modelId,
        thinkingEnabled: false,
        thinkingEffort: "none",
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

  private async applyMemoryAgentOutput(
    projectId: string,
    jobId: string,
    latest: MemoryAgentEvidenceEntry | undefined,
    output: MemoryAgentOutput,
    modelId: string,
  ): Promise<{ noOp: boolean; diaryAppended: boolean; actionsApplied: number; actionsRejected: number }> {
    let diaryAppended = false
    let actionsApplied = 0
    let actionsRejected = 0
    const diaryMarkdown = typeof output.diaryAppend === "string" ? output.diaryAppend : output.diaryAppend?.markdown
    if (diaryMarkdown?.trim()) {
      const diaryPath = this.diaryPath(projectId, new Date())
      ensureFile(diaryPath, `# ${formatDiaryDate(new Date())}\n\n`)
      fs.appendFileSync(diaryPath, `\n## ${new Date().toISOString()} Memory Agent Batch ${jobId}\n\n${normalizeDiaryNote(diaryMarkdown)}\n`)
      diaryAppended = true
      this.appendEvent({
        projectId,
        ...scopedIds(latest ?? {}),
        type: "memory.diary.appended",
        source: "server",
        payload: { jobId, path: diaryPath },
      })
    }
    for (const patch of output.learnedPatternPatches ?? []) {
      const result = this.applyPrimaryPatch(projectId, jobId, latest?.turnId, "learned_patterns", path.join(this.socratesHome, "primary", "learned_patterns.md"), patch)
      actionsApplied += result.applied ? 1 : 0
      actionsRejected += result.applied ? 0 : 1
    }
    for (const patch of output.toolUsageDocPatches ?? []) {
      const result = this.applyPrimaryPatch(projectId, jobId, latest?.turnId, "tool_usage", this.resolveToolUsagePatchPath(patch.path), patch)
      actionsApplied += result.applied ? 1 : 0
      actionsRejected += result.applied ? 0 : 1
    }
    for (const patch of output.soulPatchProposals ?? []) {
      const result = await this.applySoulPatch(projectId, jobId, latest, patch, modelId)
      actionsApplied += result.applied ? 1 : 0
      actionsRejected += result.applied ? 0 : 1
    }
    return {
      noOp: output.no_op === true && !diaryAppended && actionsApplied === 0 && actionsRejected === 0,
      diaryAppended,
      actionsApplied,
      actionsRejected,
    }
  }

  private applyPrimaryPatch(
    projectId: string,
    jobId: string,
    turnId: string | undefined,
    targetKind: "learned_patterns" | "tool_usage",
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
    latest: MemoryAgentEvidenceEntry | undefined,
    patch: MemoryPatchProposal,
    modelId: string,
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
        providerId: "openrouter",
        modelId,
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

    const confirmationText = await this.runSoulConfirmationModel(modelId, targetPath, patch)
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
    targetKind: "learned_patterns" | "tool_usage" | "soul",
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

  private async runSoulConfirmationModel(modelId: string, targetPath: string, patch: MemoryPatchProposal): Promise<string> {
    let text = ""
    for await (const event of this.options.provider!.stream({
      providerId: "openrouter",
      modelId,
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
        providerId: "openrouter",
        modelId,
        thinkingEnabled: false,
        thinkingEffort: "none",
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

  private resolveToolUsagePatchPath(inputPath: string | undefined): string {
    const root = path.join(this.socratesHome, "primary", "tool_usage")
    if (!inputPath) {
      return path.join(root, "trace_retrieve.md")
    }
    const normalized = inputPath.replaceAll("\\", "/").replace(/^primary\/tool_usage\//, "").replace(/^tool_usage\//, "")
    const resolved = safeJoin(root, normalized)
    if (!resolved.endsWith(".md")) {
      throw new SocratesError("memory_agent_tool_usage_path_invalid", "Tool-usage memory patch target must be a markdown file.", {
        recoverable: true,
        details: { path: inputPath },
      })
    }
    return resolved
  }
}

const projectNotesPath = (workspacePath: string): string => path.join(workspacePath, ".socrates", "PROJECT_NOTES.md")

const MEMORY_AGENT_SYSTEM_PROMPT = [
  "You are the Socrates backend memory agent. You maintain private Socrates memory after user turns; you are not the chat assistant.",
  "Return exactly one JSON object and no markdown fence, prose, prefix, or suffix.",
  "Allowed top-level keys: no_op, diaryAppend, learnedPatternPatches, toolUsageDocPatches, soulPatchProposals.",
  "If there is no durable learning, return {\"no_op\":true}.",
  "diaryAppend should be concise markdown using exactly these headings: Worked On, Learned, Mistakes, Decisions, Next.",
  "learnedPatternPatches, toolUsageDocPatches, and soulPatchProposals are arrays of patch objects.",
  "Patch object schema: {\"path\": optional string, \"document\": optional \"identity\"|\"operating_principles\", \"expectedBeforeHash\": optional sha256, \"oldText\": exact existing text, \"newText\": replacement text, \"rationale\": short reason, \"sourceTurnIds\": array of source turn ids}.",
  "Only propose patches when the evidence clearly supports a durable memory update. Prefer no_op over speculative edits.",
  "Never include secrets, credentials, private keys, long verbatim quotes, or sensitive user data. Redact them if they appear in evidence.",
  "Never invent identity changes. Soul proposals must be rare, narrow, evidence-backed, and appropriate for long-lived identity or operating principles.",
  "Tool-usage docs should explain exact usage patterns, common mistakes, and investigation workflows in polished markdown.",
  "Do not write project brief or project MEMORY updates in this phase.",
].join("\n")

const parseMemoryAgentOutput = (text: string): MemoryAgentOutput => {
  const trimmed = text.trim()
  const jsonText = trimmed.startsWith("{") ? trimmed : trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
  const parsed = JSON.parse(jsonText) as MemoryAgentOutput
  return {
    ...(parsed.no_op === true ? { no_op: true } : {}),
    ...(typeof parsed.diaryAppend === "string" || (parsed.diaryAppend && typeof parsed.diaryAppend === "object") ? { diaryAppend: parsed.diaryAppend } : {}),
    ...(Array.isArray(parsed.learnedPatternPatches) ? { learnedPatternPatches: parsed.learnedPatternPatches.map(normalizeMemoryPatch).filter(Boolean) as MemoryPatchProposal[] } : {}),
    ...(Array.isArray(parsed.toolUsageDocPatches) ? { toolUsageDocPatches: parsed.toolUsageDocPatches.map(normalizeMemoryPatch).filter(Boolean) as MemoryPatchProposal[] } : {}),
    ...(Array.isArray(parsed.soulPatchProposals) ? { soulPatchProposals: parsed.soulPatchProposals.map(normalizeMemoryPatch).filter(Boolean) as MemoryPatchProposal[] } : {}),
  }
}

const normalizeMemoryPatch = (value: unknown): MemoryPatchProposal | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const record = value as Record<string, unknown>
  return {
    ...(typeof record.path === "string" ? { path: record.path } : {}),
    ...(record.document === "identity" || record.document === "operating_principles" ? { document: record.document } : {}),
    ...(typeof record.oldText === "string" ? { oldText: record.oldText } : {}),
    ...(typeof record.newText === "string" ? { newText: record.newText } : {}),
    ...(typeof record.expectedBeforeHash === "string" ? { expectedBeforeHash: record.expectedBeforeHash } : {}),
    ...(typeof record.rationale === "string" ? { rationale: record.rationale } : {}),
    ...(Array.isArray(record.sourceTurnIds) ? { sourceTurnIds: record.sourceTurnIds.filter((item): item is string => typeof item === "string") } : {}),
  }
}

const validateMemoryPatch = (current: string, patch: MemoryPatchProposal): { ok: true; next: string } | { ok: false; error: string } => {
  if (patch.expectedBeforeHash && patch.expectedBeforeHash !== hashText(current)) {
    return { ok: false, error: "Expected before hash did not match current file." }
  }
  if (!patch.oldText || patch.newText === undefined) {
    return { ok: false, error: "Memory patch must include oldText and newText." }
  }
  const occurrences = countOccurrences(current, patch.oldText)
  if (occurrences === 0) {
    return { ok: false, error: "oldText was not found in target memory file." }
  }
  if (occurrences > 1) {
    return { ok: false, error: "oldText matched more than once in target memory file." }
  }
  return { ok: true, next: current.replace(patch.oldText, patch.newText) }
}

const hashText = (text: string): string => createHash("sha256").update(text).digest("hex")

const simpleDiff = (oldText: string, newText: string): string =>
  [`--- old`, `+++ new`, ...oldText.split(/\r?\n/).map((line) => `-${line}`), ...newText.split(/\r?\n/).map((line) => `+${line}`)].join("\n")

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

const memoryFile = (root: string, category: SocratesMemoryCategory, absolutePath: string): MemoryFile => {
  const stats = fs.statSync(absolutePath)
  const relativePath = path.relative(root, absolutePath).replaceAll(path.sep, "/")
  const pathPrefix = category === "learned_patterns" || category === "tool_usage" ? "primary" : "project"
  const diaryDate = category === "diary" ? /(\d{4}-\d{2}-\d{2})\.md$/.exec(relativePath)?.[1] : undefined
  return {
    path: `${pathPrefix}/${relativePath}`,
    absolutePath,
    category,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    ...(diaryDate ? { diaryDate } : {}),
  }
}

const categoryForScope = (scope: SocratesMemoryScope, category: SocratesMemoryCategory): boolean => {
  if (scope === "all") {
    return true
  }
  if (scope === "primary") {
    return category === "learned_patterns" || category === "tool_usage"
  }
  return category === "project_brief" || category === "project_memory" || category === "diary"
}

const inferCategoryFromPath = (normalizedPath: string): SocratesMemoryCategory => {
  if (normalizedPath === "primary/learned_patterns.md") {
    return "learned_patterns"
  }
  if (normalizedPath.startsWith("primary/tool_usage/")) {
    return "tool_usage"
  }
  if (normalizedPath === "project/project_brief.md") {
    return "project_brief"
  }
  if (normalizedPath === "project/MEMORY.md") {
    return "project_memory"
  }
  if (normalizedPath.startsWith("project/diary/")) {
    return "diary"
  }
  throw new SocratesError("socrates_memory_path_not_exposed", "This Socrates memory path is not exposed through socrates_memory.", {
    recoverable: true,
    details: { path: normalizedPath },
  })
}

const normalizeMemoryPath = (inputPath: string, category?: SocratesMemoryCategory): string => {
  const normalized = inputPath.replaceAll("\\", "/").replace(/^\/+/, "")
  if (normalized.startsWith("primary/") || normalized.startsWith("project/")) {
    return normalized
  }
  if (normalized === "identity.md" || normalized === "operating_principles.md") {
    return `primary/${normalized}`
  }
  if (normalized === "learned_patterns.md" || category === "learned_patterns") {
    return normalized.startsWith("learned_patterns") ? `primary/${normalized}` : `primary/learned_patterns.md`
  }
  if (normalized.startsWith("tool_usage/") || category === "tool_usage") {
    return normalized.startsWith("tool_usage/") ? `primary/${normalized}` : `primary/tool_usage/${normalized}`
  }
  if (normalized === "project_brief.md" || category === "project_brief") {
    return normalized === "project_brief.md" ? "project/project_brief.md" : `project/${normalized}`
  }
  if (normalized === "MEMORY.md" || normalized === "memory.md" || category === "project_memory") {
    return normalized.toLowerCase() === "memory.md" ? "project/MEMORY.md" : `project/${normalized}`
  }
  if (normalized.startsWith("diary/") || category === "diary") {
    return normalized.startsWith("diary/") ? `project/${normalized}` : `project/diary/${normalized}`
  }
  return `project/${normalized}`
}

const withinRange = (value: string | undefined, after?: string, before?: string): boolean => {
  if (!value) {
    return !after && !before
  }
  return (after ? value >= after : true) && (before ? value <= before : true)
}

const withinDiaryFilters = (file: MemoryFile, input: SocratesMemoryToolInput): boolean => {
  if (file.category !== "diary") {
    return !input.diaryDateAfter && !input.diaryDateBefore && !input.year && !input.month && !input.day
  }
  const date = file.diaryDate
  if (!date) {
    return false
  }
  const [year, month, day] = date.split("-").map(Number)
  return (
    withinRange(date, input.diaryDateAfter, input.diaryDateBefore) &&
    (input.year ? year === input.year : true) &&
    (input.month ? month === input.month : true) &&
    (input.day ? day === input.day : true)
  )
}

const lineSearchResults = (file: MemoryFile, content: string, query: string, mode: SocratesMemorySearchMode, contextLines: number): MemoryResult[] => {
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
  input: SocratesMemoryToolInput,
  mode: SocratesMemorySearchMode,
  query: string | undefined,
  contextLines: number,
  charLimit: number,
): MemoryResult[] => {
  const lines = content.split(/\r?\n/)
  const sections = markdownSections(lines)
  const compiled = query ? compileSearch(query, mode) : undefined
  return sections.flatMap((section) => {
    const text = lines.slice(section.start, section.end + 1).join("\n")
    const score = compiled ? compiled.score(text) : 1
    const entryTimestamp = file.category === "diary" ? timestampFromHeading(section.title) : undefined
    if (file.category === "diary" && !withinRange(entryTimestamp, input.entryAfter, input.entryBefore)) {
      return []
    }
    if (compiled && score <= 0) {
      return []
    }
    const clipped = truncateToContextBudget(text, charLimit)
    return [
      {
        resultNumber: 0,
        resultType: file.category === "diary" ? "diary_entry" : "section",
        path: file.path,
        title: section.title,
        matchedText: query ? bestMatchingLine(text, query, mode) : section.title,
        snippet: clipped,
        modifiedAt: file.modifiedAt,
        ...(file.diaryDate ? { diaryDate: file.diaryDate } : {}),
        ...(entryTimestamp ? { entryTimestamp } : {}),
        lineStart: section.start + 1,
        lineEnd: section.end + 1,
        score,
        inspectArgs: { operation: "read", path: file.path, category: file.category },
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

const fileResult = (file: MemoryFile, content: string, charLimit: number): MemoryResult => ({
  resultNumber: 0,
  resultType: "file",
  path: file.path,
  title: firstHeading(content),
  snippet: truncateToContextBudget(content, charLimit),
  modifiedAt: file.modifiedAt,
  ...(file.diaryDate ? { diaryDate: file.diaryDate } : {}),
  lineStart: 1,
  lineEnd: content.split(/\r?\n/).length,
  score: 0,
  inspectArgs: { operation: "read", path: file.path, category: file.category },
})

const lineWindowResult = (
  file: MemoryFile,
  lines: string[],
  startIndex: number,
  endIndex: number,
  matchedText: string,
  score: number,
  resultType: MemoryResult["resultType"],
  contextLines: number,
): MemoryResult => {
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
    ...(file.diaryDate ? { diaryDate: file.diaryDate } : {}),
    lineStart: startIndex + 1,
    lineEnd: endIndex + 1,
    score,
    inspectArgs: { operation: "read", path: file.path, category: file.category },
  }
}

const numberResult = (result: MemoryResult, index: number): MemoryResult => ({ ...result, resultNumber: index + 1 })

const capMemoryResults = (results: MemoryResult[], charLimit: number): { results: MemoryResult[]; truncation: TruncationMetadata; warnings: string[] } => {
  const warnings: string[] = []
  let used = 0
  const capped: MemoryResult[] = []
  for (const result of results) {
    const serializedLength = JSON.stringify(result).length
    if (used + serializedLength > charLimit && capped.length > 0) {
      warnings.push("Socrates memory output was truncated by charLimit; narrow filters or increase charLimit.")
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

const compileSearch = (query: string, mode: SocratesMemorySearchMode): { score: (text: string) => number } => {
  const lowerQuery = query.toLowerCase()
  const terms = searchTerms(query)
  if (mode === "regex") {
    let regex: RegExp
    try {
      regex = new RegExp(query, "i")
    } catch (error) {
      throw new SocratesError("socrates_memory_invalid_regex", "socrates_memory regex query is invalid.", {
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

const bestMatchingLine = (text: string, query: string, mode: SocratesMemorySearchMode): string => {
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

const timestampFromHeading = (heading: string): string | undefined => /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/.exec(heading)?.[0]

const clampContextLines = (value?: number): number => Math.min(value ?? DEFAULT_CONTEXT_LINES, 100)

const truncateToContextBudget = (text: string, charLimit: number): string => truncate(text, Math.min(charLimit, MAX_CONTEXT_CHARS)).text

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const safeJoin = (root: string, relativePath: string): string => {
  const resolved = path.resolve(root, relativePath)
  const resolvedRoot = path.resolve(root)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new SocratesError("socrates_memory_unsafe_path", "Socrates memory path must stay inside the memory root.", { recoverable: true })
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

const formatDiaryDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

const capByEstimatedTokens = (text: string, tokenLimit: number): string => {
  if (estimateTextTokens(text).inputTokens <= tokenLimit) {
    return text
  }
  return text.slice(0, tokenLimit * 4)
}

const sanitizeForDiary = (text: string): string => text.replace(/\b(sk-[A-Za-z0-9_-]{12,}|[A-Za-z0-9_-]{32,})\b/g, "[redacted]")

const normalizeDiaryNote = (text: string): string => text.trim()
