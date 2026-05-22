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

  const matches = input.mode === "files"
    ? await searchFiles(root, context.workspacePath, input.query, maxResults, Boolean(input.includeHidden))
    : await searchText(root, context.workspacePath, input, maxResults)

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
  const rgFiles = await tryRgFiles(root)
  const candidates = rgFiles ?? (await walkFiles(root, includeHidden))
  const loweredQuery = query.toLowerCase()
  return candidates
    .filter((candidate) => {
      const relative = path.relative(root, candidate)
      return query.includes("*") ? globLikeMatch(relative, query) : relative.toLowerCase().includes(loweredQuery)
    })
    .slice(0, maxResults)
    .map((candidate) => ({ path: toWorkspaceRelativePath(workspacePath, path.isAbsolute(candidate) ? candidate : path.join(root, candidate)) }))
}

const searchText = async (
  root: string,
  workspacePath: string,
  input: SearchToolInput,
  maxResults: number,
): Promise<SearchToolOutput["matches"]> => {
  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    ...(input.regex ? [] : ["--fixed-strings"]),
    ...(input.caseSensitive ? [] : ["--ignore-case"]),
    input.query,
    root,
  ]
  try {
    const result = await execFileAsync("rg", args, { encoding: "utf8", timeout: 20_000, maxBuffer: 4_000_000 })
    return parseRgOutput(result.stdout, workspacePath).slice(0, maxResults)
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & { stdout?: string; code?: number }
    if (nodeError.stdout) {
      return parseRgOutput(nodeError.stdout, workspacePath).slice(0, maxResults)
    }
    if (nodeError.code === 1) {
      return []
    }
    return searchTextFallback(root, workspacePath, input, maxResults)
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

const tryRgFiles = async (root: string): Promise<string[] | null> => {
  try {
    const result = await execFileAsync("rg", ["--files", root], { encoding: "utf8", timeout: 20_000, maxBuffer: 4_000_000 })
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
  const escaped = pattern.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("**", ".*").replaceAll("*", "[^/]*")
  return new RegExp(`^${escaped}$`).test(value)
}
