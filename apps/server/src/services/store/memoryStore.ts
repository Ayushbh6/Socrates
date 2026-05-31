import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  ProjectNotesToolInput,
  ProjectNotesToolOutput,
  SocratesMemoryScope,
  SocratesMemoryToolInput,
  SocratesMemoryToolOutput,
  TruncationMetadata,
} from "@socrates/contracts"
import type { ModelProvider, ProviderCredentialResolver } from "@socrates/providers"
import { estimateTextTokens } from "@socrates/providers"
import { SocratesError } from "@socrates/shared"
import { eq } from "drizzle-orm"
import { messages, toolCalls, turns } from "../../db/schema"
import { StoreBase } from "./shared"

const DEFAULT_CHAR_LIMIT = 20_000
const DEFAULT_LIST_LIMIT = 25
const DEFAULT_SEARCH_LIMIT = 20
const DIARY_TURN_TOKEN_CAP = 60_000
const WAKE_CONTEXT_CHAR_LIMIT = 4_000

type MemoryFile = {
  path: string
  absolutePath: string
  scope: SocratesMemoryScope
  sizeBytes: number
  modifiedAt: string
}

type MemoryStoreOptions = {
  socratesHome?: string
  provider?: ModelProvider
  credentials?: ProviderCredentialResolver
}

export class MemoryStore extends StoreBase {
  private readonly socratesHome: string

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
    if (input.operation === "list") {
      return this.listMemory(projectId, input)
    }
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
    void this.appendDiaryForTurnAsync(input).catch((error) => {
      this.appendEvent({
        projectId: input.projectId,
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        type: "memory.diary.failed",
        source: "server",
        payload: { message: error instanceof Error ? error.message : String(error) },
      })
    })
  }

  private listMemory(projectId: string, input: SocratesMemoryToolInput): SocratesMemoryToolOutput {
    const scope = input.scope
    const limit = input.limit ?? DEFAULT_LIST_LIMIT
    const offset = input.offset ?? 0
    const files = this.memoryFiles(projectId, scope, input.modifiedAfter, input.modifiedBefore)
      .slice(offset, offset + limit)
      .map(({ absolutePath: _absolutePath, ...file }) => file)
    return {
      operation: "list",
      ...(scope ? { scope } : {}),
      files,
      truncation: truncationFor(JSON.stringify(files), input.charLimit ?? DEFAULT_CHAR_LIMIT),
    }
  }

  private readMemory(projectId: string, input: SocratesMemoryToolInput): SocratesMemoryToolOutput {
    const resolved = this.resolveMemoryPath(projectId, input.path as string, input.scope)
    const content = fs.readFileSync(resolved.absolutePath, "utf8")
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const truncated = truncate(content, charLimit)
    return {
      operation: "read",
      scope: resolved.scope,
      content: truncated.text,
      truncation: truncationFor(content, charLimit),
      ...(truncated.truncated ? { warnings: ["Socrates memory file was truncated. Re-read with a larger charLimit if needed."] } : {}),
    }
  }

  private searchMemory(projectId: string, input: SocratesMemoryToolInput): SocratesMemoryToolOutput {
    const scope = input.scope
    const query = input.query as string
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const matches: NonNullable<SocratesMemoryToolOutput["matches"]> = []
    for (const file of this.memoryFiles(projectId, scope, input.modifiedAfter, input.modifiedBefore)) {
      const content = fs.readFileSync(file.absolutePath, "utf8")
      for (const match of lineMatches(content, query, limit - matches.length)) {
        matches.push({ path: file.path, scope: file.scope, line: match.line, text: match.text, modifiedAt: file.modifiedAt })
        if (matches.length >= limit) {
          break
        }
      }
      if (matches.length >= limit) {
        break
      }
    }
    return {
      operation: "search",
      ...(scope ? { scope } : {}),
      matches,
      truncation: truncationFor(JSON.stringify(matches), charLimit),
      ...(matches.length >= limit ? { warnings: ["Socrates memory search hit the match limit; narrow the query or scope."] } : {}),
    }
  }

  private memoryFiles(projectId: string, scope?: SocratesMemoryScope, modifiedAfter?: string, modifiedBefore?: string): MemoryFile[] {
    const roots: Array<{ scope: SocratesMemoryScope; root: string }> = []
    if (!scope || scope === "primary") {
      roots.push({ scope: "primary", root: path.join(this.socratesHome, "primary") })
    }
    if (!scope || scope === "project") {
      roots.push({ scope: "project", root: this.projectRoot(projectId) })
    }
    return roots
      .flatMap(({ scope: fileScope, root }) => listMarkdownFiles(root).map((absolutePath) => memoryFile(root, fileScope, absolutePath)))
      .filter((file) => (modifiedAfter ? file.modifiedAt >= modifiedAfter : true))
      .filter((file) => (modifiedBefore ? file.modifiedAt <= modifiedBefore : true))
      .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt) || left.path.localeCompare(right.path))
  }

  private resolveMemoryPath(projectId: string, inputPath: string, scope?: SocratesMemoryScope): MemoryFile {
    const normalized = inputPath.replaceAll("\\", "/").replace(/^\/+/, "")
    const inferredScope = normalized.startsWith("primary/") ? "primary" : normalized.startsWith("project/") ? "project" : scope
    if (!inferredScope) {
      throw new SocratesError("socrates_memory_scope_required", "Path must start with primary/ or project/, or scope must be provided.", {
        recoverable: true,
      })
    }
    const relative = normalized.replace(/^(primary|project)\//, "")
    const root = inferredScope === "primary" ? path.join(this.socratesHome, "primary") : this.projectRoot(projectId)
    const absolutePath = safeJoin(root, relative)
    if (!absolutePath.endsWith(".md") || !fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new SocratesError("socrates_memory_file_not_found", "Socrates memory path was not found or is not a markdown file.", {
        recoverable: true,
        details: { path: inputPath },
      })
    }
    return memoryFile(root, inferredScope, absolutePath)
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

  private async appendDiaryForTurnAsync(input: { projectId: string; conversationId: string; sessionId: string; turnId: string; workspacePath?: string }): Promise<void> {
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
        type: "memory.diary.skipped",
        source: "server",
        payload: { reason: "OpenRouter credential is not configured." },
      })
      return
    }
    const turnEvidence = this.turnEvidence(input.projectId, input.turnId)
    if (!turnEvidence.trim()) {
      return
    }
    const cappedEvidence = capByEstimatedTokens(turnEvidence, DIARY_TURN_TOKEN_CAP)
    const candidates = ["deepseek/deepseek-v4-pro", "xiaomi/mimo-v2.5-pro"]
    let note = ""
    let lastError: unknown
    for (const modelId of candidates) {
      try {
        note = await this.runDiaryModel(modelId, cappedEvidence)
        if (note.trim()) {
          break
        }
      } catch (error) {
        lastError = error
      }
    }
    if (!note.trim()) {
      throw lastError ?? new SocratesError("memory_diary_empty", "Diary model returned no note.", { recoverable: true })
    }
    const diaryPath = this.diaryPath(input.projectId, new Date())
    ensureFile(diaryPath, `# ${formatDiaryDate(new Date())}\n\n`)
    fs.appendFileSync(diaryPath, `\n## ${new Date().toISOString()} Turn ${input.turnId}\n\n${normalizeDiaryNote(note)}\n`)
    this.appendEvent({
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      type: "memory.diary.appended",
      source: "server",
      payload: { path: diaryPath },
    })
  }

  private turnEvidence(projectId: string, turnId: string): string {
    const turn = this.handle.db.select().from(turns).where(eq(turns.id, turnId)).limit(1).get()
    if (!turn) {
      return ""
    }
    const messageRows = this.handle.db.select().from(messages).where(eq(messages.turnId, turnId)).orderBy(messages.createdAt).all()
    const toolRows = this.handle.db.select().from(toolCalls).where(eq(toolCalls.turnId, turnId)).orderBy(toolCalls.startedAt).all()
    return [
      `Project: ${projectId}`,
      `Turn: ${turnId}`,
      ...messageRows.map((message) => `[${message.role}]\n${sanitizeForDiary(message.content)}`),
      ...toolRows.map((tool) => `[tool ${tool.toolName} ${tool.status}]\nArguments: ${sanitizeForDiary(tool.argumentsJson)}\nResult: ${sanitizeForDiary(tool.resultJson ?? "")}`),
    ].join("\n\n")
  }

  private async runDiaryModel(modelId: string, evidence: string): Promise<string> {
    let text = ""
    for await (const event of this.options.provider!.stream({
      providerId: "openrouter",
      modelId,
      system:
        "You write concise private Socrates project diary notes. Use exactly these markdown headings: Worked On, Learned, Mistakes, Decisions, Next. Record only durable project/product learning. Do not include secrets or long quotes.",
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
}

const projectNotesPath = (workspacePath: string): string => path.join(workspacePath, ".socrates", "PROJECT_NOTES.md")

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

const memoryFile = (root: string, scope: SocratesMemoryScope, absolutePath: string): MemoryFile => {
  const stats = fs.statSync(absolutePath)
  return {
    path: `${scope}/${path.relative(root, absolutePath).replaceAll(path.sep, "/")}`,
    absolutePath,
    scope,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  }
}

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
