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
} from "@socrates/contracts"
import { memoryDocRequiredSections } from "@socrates/contracts"
import type { ModelProvider, ProviderCredentialResolver } from "@socrates/providers"
import { estimateTextTokens } from "@socrates/providers"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, desc, eq } from "drizzle-orm"
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
import { emptyMemoryAgentSignal, scoreMemoryAgentSignal } from "./memoryAgentSignals"
import { emptyMemoryAgentSummary, parseMemoryAgentSummarySections } from "./memoryAgentSummary"
import {
  discoverSkills,
  fallbackSkillBody,
  fallbackSkillDescription,
  fallbackSkillMarkdown,
  parseSkillMarkdown,
  readSkillInfo,
  skillSummary,
  slugSkillName,
  isValidSkillName,
  stripFrontmatter,
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

  listProjectSkills(projectId: string, workspacePath: string | undefined): SkillSummary[] {
    this.ensureProjectMemory(projectId, workspacePath)
    return this.skillInfos(workspacePath, "project").map(skillSummary)
  }

  async buildProjectSkill(projectId: string, workspacePath: string, request: string, explicitName?: string): Promise<SkillSummary> {
    this.ensureProjectMemory(projectId, workspacePath)
    const skillRoot = path.join(workspacePath, ".socrates", "skills")
    fs.mkdirSync(skillRoot, { recursive: true })
    const name = explicitName ? this.availableExplicitSkillName(skillRoot, explicitName) : uniqueSkillName(skillRoot, slugSkillName(request))
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
    const skillDir = path.join(root, name)
    const skillFile = path.join(skillDir, "SKILL.md")
    const content = await this.generateGlobalSkill(request, name)
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(skillFile, content)
    const info = readSkillInfo("global", root, skillFile)
    if (!info) {
      const fallback = fallbackSkillMarkdown(name, request)
      fs.writeFileSync(skillFile, fallback)
      const fallbackInfo = readSkillInfo("global", root, skillFile)
      if (!fallbackInfo) {
        throw new SocratesError("global_skill_invalid", "Generated global skill did not match the Agent Skill format.", { recoverable: true })
      }
      return skillSummary(fallbackInfo)
    }
    return skillSummary(info)
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
    if (entries.entries.length === 0) {
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
    if (this.options.credentials && !this.options.credentials.getApiKey(input.settings.providerId)) {
      const reason = `${input.settings.providerId} credential is not configured.`
      const item = this.recordMemoryAgentCheck(input.trigger, "skipped", signal, reason, now)
      const state = input.updateState({ status: "skipped", lastCheckedAt: now, activeJobId: null, error: reason })
      return { state, pending: signal, item, skippedReason: reason }
    }

    const modelSettings: MemoryAgentModelSettings = {
      providerId: input.settings.providerId,
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
          toolDocs: async (toolInput) => this.runToolDocsTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput, "memory_agent"),
          skills: async (toolInput) => this.runSkillsTool(GLOBAL_MEMORY_AGENT_PROJECT_ID, undefined, toolInput),
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
      ...renderedEntries,
    ].join("\n")
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
    if (manifest.entries.length === 0) {
      return emptyMemoryAgentSignal(manifest.sequenceTo)
    }
    const turnIds = manifest.entries.map((entry) => entry.turnId)
    const fileStats = this.changedFileStats(turnIds)
    return scoreMemoryAgentSignal({
      sequenceFrom: manifest.sequenceFrom,
      sequenceTo: manifest.sequenceTo,
      turnCount: manifest.entries.length,
      toolCalls: manifest.entries.reduce((total, entry) => total + entry.counts.toolCalls, 0),
      fileChangeEvents: fileStats.fileChangeEvents,
      distinctChangedFiles: fileStats.distinctChangedFiles,
      totalTokens: this.totalTokensForTurns(turnIds),
    })
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
    const resolved = this.resolveEditFilesTarget(input)
    if (resolved.targetKind === "skills" && !context.allowSkillWrites) {
      const patch: MemoryPatchProposal = {
        oldText: input.editMode === "create" ? "" : input.oldText ?? "",
        newText: input.newText,
        ...(input.rationale ? { rationale: input.rationale } : {}),
        ...(input.sourceTurnIds ? { sourceTurnIds: input.sourceTurnIds } : {}),
      }
      const action = this.createMemoryAction(GLOBAL_MEMORY_AGENT_PROJECT_ID, context.jobId, context.turnId, "skills", resolved.path, patch, false)
      const error = "Scheduled memory runs may read skills but cannot create or update skills. Use the Memory Center Skills + flow for global skill creation."
      this.rejectMemoryAction(action.actionId, error)
      return this.rejectedEditFilesOutput(input, resolved.path, action.actionId, error)
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

  private editFilesPatchForInput(
    input: EditFilesToolInput,
    resolved: { path: string; targetKind: "skills" | "soul" | "user_profile"; document?: "identity" },
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
    ensureStructuredMemoryDoc(resolved.path, profile)
    const current = readIfExists(resolved.path) ?? ""
    const currentIndex = this.indexMemoryDocFile(resolved.path, profile)
    const currentSection = findMemoryDocSection(currentIndex, input.sectionId)
    const next = patchMemoryDocSection(current, profile, input.sectionId, input.oldText ?? "", input.newText, input.replaceAll)
    const nextSection = findMemoryDocSection(parseMemoryDoc(next, profile), input.sectionId)
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
    resolved: { path: string; targetKind: "skills" | "soul" | "user_profile"; document?: "identity" },
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

  private resolveEditFilesTarget(input: EditFilesToolInput): { path: string; targetKind: "skills" | "soul" | "user_profile"; document?: "identity" } {
    if (input.target === "identity") {
      return { path: this.soulPath(), targetKind: "soul", document: "identity" }
    }
    if (input.target === "user_profile") {
      return { path: this.userProfilePath(), targetKind: "user_profile" }
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

  private async generateGlobalSkill(request: string, name: string): Promise<string> {
    const fallback = fallbackSkillMarkdown(name, request)
    if (!this.options.provider) {
      return fallback
    }
    const modelSettings = this.memoryAgentModelSettingsFor()
    const globalSkills = this.skillInfos(undefined, "global")
      .map((skill) => `- ${skill.name}: ${skill.description}`)
      .join("\n")
    const context = [
      `Skill name to use exactly: ${name}`,
      "Primary user request:",
      request.trim(),
      "",
      "Side guidance only. Use when relevant; ignore when not useful.",
      "--- identity.md",
      truncate(readIfExists(this.soulPath()) ?? "", 4_000).text,
      "--- user_profile.md",
      truncate(readIfExists(this.userProfilePath()) ?? "", 4_000).text,
      "--- existing global skills",
      globalSkills || "No global skills are registered yet.",
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
      return parseSkillMarkdown(cleaned, path.join(this.socratesHome, "skills", name, "SKILL.md")) ? cleaned : fallback
    } catch {
      return fallback
    }
  }

  private applyPrimaryPatch(
    projectId: string,
    jobId: string,
    turnId: string | undefined,
    targetKind: "skills" | "user_profile",
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
    if (targetKind === "skills" && path.basename(targetPath) === "SKILL.md" && !parseSkillMarkdown(validation.next, targetPath)) {
      const error = "Skill patch must preserve valid Agent Skill frontmatter with matching folder name."
      this.rejectMemoryAction(action.actionId, error)
      this.appendEvent({ projectId, ...(turnId ? { turnId } : {}), type: "memory.primary.update_rejected", source: "server", payload: { jobId, actionId: action.actionId, path: targetPath, reason: error } })
      return { applied: false, actionId: action.actionId, error }
    }
    const next =
      targetKind === "skills"
        ? validation.next
        : stampMemoryDocFrontmatter(validation.next, {
            updatedAt: currentRuntimeTime().currentDateTime,
            updatedBy: "edit_files",
            lastEditedSection: lastEditedSection ?? "document",
          })
    fs.writeFileSync(targetPath, next)
    const afterHash = hashText(next)
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
    targetKind: "skills" | "soul" | "user_profile",
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
  const section = index.sections.find((candidate) => candidate.sectionId === sectionId)
  if (!section) {
    throw new SocratesError("memory_doc_section_not_found", `Section ${sectionId} was not found in ${index.path}.`, {
      recoverable: true,
      details: { path: index.path, sectionId },
    })
  }
  return section
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
  const signaturePayload = {
    workspaceRoot: environment.workspacePath,
    detectedStack: environment.detectedStack,
    javascript: environment.javascript,
    python: environment.python,
    rust: environment.rust,
  }
  const signature = hashText(JSON.stringify(signaturePayload))
  const packageManager = environment.javascript.packageManager ?? "none"
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
      "  dependency_files:",
      ...yamlList(environment.javascript.dependencyFiles, "    "),
      "  package_files:",
      ...yamlList(environment.javascript.packageFiles, "    "),
      "  workspace_packages:",
      ...yamlList(environment.javascript.packageNames, "    "),
      "  frameworks:",
      ...yamlList(environment.javascript.frameworks, "    "),
      "  root_scripts:",
      ...yamlList(environment.javascript.scripts, "    "),
      "python:",
      "  virtual_environments:",
      ...yamlList(environment.python.virtualEnvironments, "    "),
      "  dependency_files:",
      ...yamlList(environment.python.dependencyFiles, "    "),
      "  package_managers:",
      ...yamlList(environment.python.packageManagers, "    "),
      ...(environment.python.suggestedVirtualEnvironment ? [`  suggested_virtual_environment: ${environment.python.suggestedVirtualEnvironment}`] : []),
      "rust:",
      "  dependency_files:",
      ...yamlList(environment.rust.dependencyFiles, "    "),
      "  package_managers:",
      ...yamlList(environment.rust.packageManagers, "    "),
      "terminal_state: omitted",
      "notes:",
      "  - Runtime workspace scan facts are generated by the backend.",
      "  - Terminal output and live terminal state are intentionally not persisted here.",
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
  isLegacyToolUsageSeed(name, content) || !isStructuredToolUsageDoc(name, content)

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

const PROJECT_SKILL_BUILDER_SYSTEM_PROMPT = [
  "You generate one Agent Skill for Socrates.",
  "Return only the complete SKILL.md markdown. Do not include a markdown fence, prefix, or suffix.",
  "The provided skill name is mandatory and must appear exactly in YAML frontmatter.",
  "YAML frontmatter must include name and description.",
  "The user's primary request is the main authority. Project instructions, memory, repo docs, and skill-writer guidance are side guidance only; ignore them when irrelevant.",
  "The body must include clear sections for when to use the skill, workflow, verification or evidence requirements, and output style.",
  "Descriptions should contain natural trigger words from the user's request so future agents can discover the skill by search.",
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
