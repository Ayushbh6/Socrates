import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { SearchToolInput, SearchToolOutput } from "@socrates/contracts"
import { clampCharLimit, resolveWorkspacePath, toWorkspaceRelativePath } from "./common"

const execFileAsync = promisify(execFile)
const defaultMaxResults = 100
const skippedDirectories = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"])

export const searchWorkspace = async (input: SearchToolInput, context: { workspacePath: string }): Promise<SearchToolOutput> => {
  const root = resolveWorkspacePath(context.workspacePath, input.path)
  const maxResults = input.maxResults ?? defaultMaxResults
  const charLimit = clampCharLimit(input.charLimit)
  const warnings: string[] = []

  const matches =
    input.mode === "files"
      ? await searchFiles(root, context.workspacePath, input.query, maxResults, Boolean(input.includeHidden))
      : await searchText(root, context.workspacePath, input, maxResults, warnings)

  const boundedMatches = boundMatches(matches, charLimit)
  const serialized = JSON.stringify(matches)
  const boundedSerialized = JSON.stringify(boundedMatches)

  return {
    mode: input.mode,
    query: input.query,
    matches: boundedMatches,
    totalMatches: matches.length,
    truncation: {
      truncated: boundedMatches.length < matches.length || boundedSerialized.length < serialized.length,
      charLimit,
      originalLength: serialized.length,
      returnedLength: boundedSerialized.length,
    },
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

const boundMatches = (matches: SearchToolOutput["matches"], charLimit: number): SearchToolOutput["matches"] => {
  const bounded: SearchToolOutput["matches"] = []
  for (const match of matches) {
    const next = [...bounded, match]
    if (JSON.stringify(next).length > charLimit) {
      break
    }
    bounded.push(match)
  }
  return bounded
}

const searchFiles = async (
  root: string,
  workspacePath: string,
  query: string,
  maxResults: number,
  includeHidden: boolean,
): Promise<SearchToolOutput["matches"]> => {
  const rgFiles = await tryRgFiles(root, includeHidden)
  const candidates = rgFiles ?? (await walkFiles(root, includeHidden))
  const loweredQuery = normalizePathForSearch(query)
  return candidates
    .filter((candidate) => {
      const relative = candidateRelativePath(root, candidate)
      const basename = path.basename(relative)
      return query.includes("*")
        ? globLikeMatch(relative, query) || globLikeMatch(basename, query)
        : normalizePathForSearch(relative).includes(loweredQuery) || basename.toLowerCase().includes(loweredQuery)
    })
    .slice(0, maxResults)
    .map((candidate) => ({ path: toWorkspaceRelativePath(workspacePath, candidateAbsolutePath(root, candidate)) }))
}

const searchText = async (
  root: string,
  workspacePath: string,
  input: SearchToolInput,
  maxResults: number,
  warnings: string[],
): Promise<SearchToolOutput["matches"]> => {
  const regexLike = looksLikeRegexQuery(input.query)
  const useRegex = input.regex ?? regexLike
  if (input.regex === undefined && regexLike) {
    warnings.push("Query looked like regex syntax, so search interpreted it as regex. Set regex=false to search it literally.")
  }
  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    ...(useRegex ? [] : ["--fixed-strings"]),
    ...(input.caseSensitive ? [] : ["--ignore-case"]),
    input.query,
    root,
  ]
  try {
    const result = await execFileAsync("rg", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 4_000_000 })
    const matches = parseRgOutput(result.stdout, workspacePath).slice(0, maxResults)
    addZeroMatchWarning(matches, input, useRegex, regexLike, warnings)
    return matches
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & { stdout?: string; code?: number }
    if (nodeError.stdout) {
      const matches = parseRgOutput(nodeError.stdout, workspacePath).slice(0, maxResults)
      addZeroMatchWarning(matches, input, useRegex, regexLike, warnings)
      return matches
    }
    if (nodeError.code === 1) {
      addZeroMatchWarning([], input, useRegex, regexLike, warnings)
      return []
    }
    if (useRegex && isInvalidRegexError(nodeError)) {
      warnings.push("Regex search failed to parse; retried as a literal fixed-string search.")
      const matches = await searchTextFallback(root, workspacePath, { ...input, regex: false }, maxResults)
      addZeroMatchWarning(matches, input, false, regexLike, warnings)
      return matches
    }
    const matches = await searchTextFallback(root, workspacePath, { ...input, regex: useRegex }, maxResults)
    addZeroMatchWarning(matches, input, useRegex, regexLike, warnings)
    return matches
  }
}

const parseRgOutput = (stdout: string, workspacePath: string): SearchToolOutput["matches"] =>
  stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = /^(.*?):(\d+):(\d+):(.*)$/.exec(line)
      if (!match) {
        return { path: line }
      }
      return {
        path: toWorkspaceRelativePath(workspacePath, match[1] ?? ""),
        line: Number(match[2]),
        column: Number(match[3]),
        text: match[4],
      }
    })

const tryRgFiles = async (root: string, includeHidden: boolean): Promise<string[] | null> => {
  try {
    const result = await execFileAsync("rg", ["--files", ...(includeHidden ? ["--hidden"] : []), root], {
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 4_000_000,
    })
    return result.stdout.split("\n").filter(Boolean)
  } catch {
    return null
  }
}

const walkFiles = async (root: string, includeHidden: boolean): Promise<string[]> => {
  const found: string[] = []
  const walk = async (directory: string) => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".")) {
        continue
      }
      if (entry.isDirectory() && skippedDirectories.has(entry.name)) {
        continue
      }
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
      } else {
        found.push(entryPath)
      }
    }
  }
  await walk(root)
  return found
}

const searchTextFallback = async (
  root: string,
  workspacePath: string,
  input: SearchToolInput,
  maxResults: number,
): Promise<SearchToolOutput["matches"]> => {
  const files = await walkFiles(root, Boolean(input.includeHidden))
  const flags = input.caseSensitive ? "" : "i"
  const regex = input.regex ? new RegExp(input.query, flags) : null
  const needle = input.caseSensitive ? input.query : input.query.toLowerCase()
  const matches: SearchToolOutput["matches"] = []
  for (const file of files) {
    if (matches.length >= maxResults) {
      break
    }
    const text = await fs.readFile(file, "utf8").catch(() => "")
    const lines = text.split("\n")
    for (let index = 0; index < lines.length && matches.length < maxResults; index += 1) {
      const line = lines[index] ?? ""
      const haystack = input.caseSensitive ? line : line.toLowerCase()
      if (regex ? regex.test(line) : haystack.includes(needle)) {
        matches.push({ path: toWorkspaceRelativePath(workspacePath, file), line: index + 1, text: line })
      }
    }
  }
  return matches
}

const globLikeMatch = (value: string, pattern: string): boolean => {
  const normalizedValue = normalizePathForSearch(value)
  const normalizedPattern = normalizePathForSearch(pattern)
  const escaped = normalizedPattern.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*")
  return new RegExp(`^${escaped}$`, "i").test(normalizedValue)
}

const candidateAbsolutePath = (root: string, candidate: string): string => (path.isAbsolute(candidate) ? candidate : path.join(root, candidate))

const candidateRelativePath = (root: string, candidate: string): string => normalizePathForSearch(path.relative(root, candidateAbsolutePath(root, candidate)))

const normalizePathForSearch = (value: string): string => value.replaceAll("\\", "/").toLowerCase()

const looksLikeRegexQuery = (query: string): boolean =>
  /(^|[^\\])\|/.test(query) ||
  query.includes(".*") ||
  query.includes("\\b") ||
  query.includes("\\d") ||
  query.includes("\\w") ||
  /[[\](){}+?^$]/.test(query)

const addZeroMatchWarning = (
  matches: SearchToolOutput["matches"],
  input: SearchToolInput,
  usedRegex: boolean,
  regexLike: boolean,
  warnings: string[],
): void => {
  if (matches.length > 0 || !regexLike) {
    return
  }
  if (usedRegex) {
    warnings.push("No matches found for regex-looking query. Try simpler terms or separate searches if this was too narrow.")
  } else {
    warnings.push("No matches found. Query looked like regex syntax; set regex=true or use simpler literal terms.")
  }
}

const isInvalidRegexError = (error: NodeJS.ErrnoException & { stderr?: string }): boolean => {
  const stderr = typeof error.stderr === "string" ? error.stderr : ""
  return stderr.toLowerCase().includes("regex parse error") || stderr.toLowerCase().includes("invalid regex")
}
