import fs from "node:fs"
import path from "node:path"
import type { DocsSearchMode, ToolDocsArea, ToolDocsToolInput, ToolDocsToolOutput, TruncationMetadata } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"

const DEFAULT_CHAR_LIMIT = 20_000
const DEFAULT_SEARCH_LIMIT = 20
const DEFAULT_CONTEXT_LINES = 8
const MAX_CONTEXT_CHARS = 28_000

type MemoryFile = {
  path: string
  absolutePath: string
  area: ToolDocsArea
  sizeBytes: number
  modifiedAt: string
}

type DocsResult = ToolDocsToolOutput["results"][number]
export type ToolDocsAudience = "main" | "memory_agent" | "all"

export class ToolDocsStore {
  constructor(private readonly socratesHome: string, private readonly audience: ToolDocsAudience = "main") {}

  run(input: ToolDocsToolInput): ToolDocsToolOutput {
    if (input.operation === "read") {
      return this.read(input)
    }
    return this.search(input)
  }

  listFiles(area?: ToolDocsArea): MemoryFile[] {
    const candidates: MemoryFile[] = [
      ...listMarkdownFiles(path.join(this.socratesHome, "tool_usage")).map((absolutePath) => memoryFile(this.socratesHome, "tool_usage", absolutePath)),
    ].filter((file) => fs.existsSync(file.absolutePath))
    return candidates
      .filter((file) => this.isVisibleToAudience(file.path))
      .filter((file) => (area ? file.area === area : true))
      .sort((left, right) => left.path.localeCompare(right.path))
  }

  private read(input: ToolDocsToolInput): ToolDocsToolOutput {
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const contextLines = clampContextLines(input.contextLines)
    if (input.path && this.isIndexPath(input.path, input.area)) {
      const results = this.indexResults(this.indexFiles(input.path, input.area), charLimit)
      const sliced = results.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? DEFAULT_SEARCH_LIMIT)).map(numberResult)
      const output = capToolDocResults(sliced, charLimit)
      return {
        operation: "read",
        ...(input.area ? { area: input.area } : {}),
        results: output.results,
        totalMatches: results.length,
        truncation: output.truncation,
        ...(output.warnings.length > 0 ? { warnings: output.warnings } : {}),
      }
    }
    const files = input.path ? [this.resolvePath(input.path, input.area)] : this.listFiles(input.area)
    const results = this.docsResults(files, input, contextLines, charLimit)
    const sliced = results.slice(input.offset ?? 0, (input.offset ?? 0) + (input.limit ?? DEFAULT_SEARCH_LIMIT)).map(numberResult)
    const output = capToolDocResults(sliced, charLimit)
    return {
      operation: "read",
      ...(input.area ? { area: input.area } : {}),
      results: output.results,
      totalMatches: results.length,
      truncation: output.truncation,
      ...(output.warnings.length > 0 ? { warnings: output.warnings } : {}),
    }
  }

  private search(input: ToolDocsToolInput): ToolDocsToolOutput {
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
    const charLimit = input.charLimit ?? DEFAULT_CHAR_LIMIT
    const contextLines = clampContextLines(input.contextLines)
    const files = input.path ? [this.resolvePath(input.path, input.area)] : this.listFiles(input.area)
    const results = this.docsResults(files, input, contextLines, charLimit)
    const sliced = results.slice(input.offset ?? 0, (input.offset ?? 0) + limit).map(numberResult)
    const output = capToolDocResults(sliced, charLimit)
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

  private isIndexPath(inputPath: string, area?: ToolDocsArea): boolean {
    const normalizedInput = inputPath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "")
    if (normalizedInput === "." || normalizedInput === "" || normalizedInput === "tool_usage" || normalizedInput === "tool_usage/.") {
      return true
    }
    const normalized = this.normalizePath(inputPath, area).replace(/\/+$/, "")
    const absolutePath = safeJoin(this.socratesHome, normalized)
    return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()
  }

  private indexFiles(inputPath: string, area?: ToolDocsArea): MemoryFile[] {
    const normalizedInput = inputPath.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "")
    if (normalizedInput === "." || normalizedInput === "" || normalizedInput === "tool_usage" || normalizedInput === "tool_usage/.") {
      return this.listFiles(area)
    }
    const normalized = this.normalizePath(inputPath, area).replace(/\/+$/, "")
    const absolutePath = safeJoin(this.socratesHome, normalized)
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isDirectory()) {
      return []
    }
    return listMarkdownFiles(absolutePath)
      .map((filePath) => memoryFile(this.socratesHome, "tool_usage", filePath))
      .filter((file) => this.isVisibleToAudience(file.path))
      .filter((file) => (area ? file.area === area : true))
      .sort((left, right) => left.path.localeCompare(right.path))
  }

  private indexResults(files: MemoryFile[], charLimit: number): DocsResult[] {
    return files.map((file) => {
      const content = readIfExists(file.absolutePath) ?? ""
      const description = firstMarkdownLine(content) || firstHeading(content)
      return {
        resultNumber: 0,
        resultType: "file",
        path: file.path,
        title: path.basename(file.path),
        snippet: truncateToContextBudget(
          [`Path: ${file.path}`, `Description: ${description}`, `Read hint: tool_docs({ operation: "read", path: "${file.path}" })`].join("\n"),
          charLimit,
        ),
        modifiedAt: file.modifiedAt,
        lineStart: 1,
        lineEnd: Math.max(1, content.split(/\r?\n/).length),
      }
    })
  }

  private docsResults(files: MemoryFile[], input: ToolDocsToolInput, contextLines: number, charLimit: number): DocsResult[] {
    const query = input.query?.trim()
    const mode = input.searchMode ?? "keyword_all"
    return files.flatMap((file) => {
      const content = fs.readFileSync(file.absolutePath, "utf8")
      if (input.includeSections) {
        const sectionResults = sectionMatches(file, content, mode, query, contextLines, charLimit)
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

  private resolvePath(inputPath: string, area?: ToolDocsArea): MemoryFile {
    const normalized = this.normalizePath(inputPath, area)
    const absolutePath = safeJoin(this.socratesHome, normalized)
    if (!absolutePath.endsWith(".md") || !fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new SocratesError("tool_docs_file_not_found", "Tool docs path was not found or is not a markdown file.", {
        recoverable: true,
        details: { path: inputPath },
      })
    }
    const file = memoryFile(this.socratesHome, "tool_usage", absolutePath)
    if (!this.isVisibleToAudience(file.path)) {
      throw new SocratesError("tool_docs_audience_mismatch", "Tool docs path is not visible to this agent.", {
        recoverable: true,
        details: { path: inputPath, audience: this.audience },
      })
    }
    if (area && file.area !== area) {
      throw new SocratesError("tool_docs_area_mismatch", "Tool docs path does not match the requested area.", {
        recoverable: true,
        details: { path: inputPath, area },
      })
    }
    return file
  }

  private normalizePath(inputPath: string, area?: ToolDocsArea): string {
    return normalizeToolDocPath(inputPath, area, this.audience)
  }

  private isVisibleToAudience(filePath: string): boolean {
    if (this.audience === "all") {
      return true
    }
    const normalized = filePath.replaceAll("\\", "/")
    const rootPrefix = "tool_usage/"
    const memoryAgentPrefix = "tool_usage/memory_agent/"
    if (this.audience === "memory_agent") {
      const relative = normalized.startsWith(memoryAgentPrefix) ? normalized.slice(memoryAgentPrefix.length) : ""
      return Boolean(relative) && !relative.includes("/")
    }
    const relative = normalized.startsWith(rootPrefix) ? normalized.slice(rootPrefix.length) : ""
    return Boolean(relative) && !relative.includes("/")
  }
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

const normalizeToolDocPath = (inputPath: string, area?: ToolDocsArea, audience: ToolDocsAudience = "main"): string => {
  const normalized = inputPath.replaceAll("\\", "/").replace(/^\/+/, "")
  if (audience !== "memory_agent" && (normalized === "bash.md" || normalized === "tool_usage/bash.md")) {
    return "tool_usage/terminal.md"
  }
  if (normalized.startsWith("tool_usage/")) {
    return normalized
  }
  if (audience === "memory_agent") {
    return normalized.includes("/") ? `tool_usage/${normalized}` : `tool_usage/memory_agent/${normalized}`
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
    return [lineWindowResult(file, lines, index, index, line, "line_match", contextLines)]
  })
}

const sectionMatches = (
  file: MemoryFile,
  content: string,
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

const capToolDocResults = (results: DocsResult[], charLimit: number): { results: DocsResult[]; truncation: TruncationMetadata; warnings: string[] } => {
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

export const firstMarkdownLine = (content: string): string => {
  const line = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    .split(/\r?\n/)
    .map((candidate) => candidate.trim().replace(/^#{1,6}\s*/, "").replace(/^[-*]\s+/, ""))
    .find((candidate) => candidate.length > 0)
  return line?.slice(0, 220) ?? ""
}

const readIfExists = (filePath: string): string | undefined => {
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return undefined
  }
  return fs.readFileSync(filePath, "utf8")
}

const safeJoin = (root: string, relativePath: string): string => {
  const resolved = path.resolve(root, relativePath)
  const resolvedRoot = path.resolve(root)
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new SocratesError("safe_path_escape", "Path must stay inside the expected root.", { recoverable: true })
  }
  return resolved
}

const truncate = (text: string, charLimit: number): { text: string; truncated: boolean } =>
  text.length <= charLimit ? { text, truncated: false } : { text: text.slice(0, charLimit), truncated: true }
