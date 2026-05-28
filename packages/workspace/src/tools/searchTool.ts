import { execFile, spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import type { SearchToolInput, SearchToolOutput } from "@socrates/contracts"
import { clampCharLimit, resolveWorkspacePath, toWorkspaceRelativePath } from "./common"

const execFileAsync = promisify(execFile)
const defaultMaxResults = 20
const hardMaxResults = 50
const skippedDirectories = new Set([".git", "node_modules", "dist", "build", ".next", ".turbo", "coverage"])

export const searchWorkspace = async (input: SearchToolInput, context: { workspacePath: string }): Promise<SearchToolOutput> => {
  const root = resolveWorkspacePath(context.workspacePath, input.path)
  const maxResults = Math.min(input.maxResults ?? defaultMaxResults, hardMaxResults)
  const charLimit = clampCharLimit(input.charLimit)
  const warnings: string[] = []
  if (input.maxResults && input.maxResults > hardMaxResults) {
    warnings.push(`Search maxResults was capped at ${hardMaxResults}. Narrow path/query or paginate with a more specific search.`)
  }

  const matches =
    input.mode === "files"
      ? await searchFiles(root, context.workspacePath, input.query, maxResults, Boolean(input.includeHidden), warnings)
      : await searchText(root, context.workspacePath, input, maxResults, warnings)

  addResultCapWarning(matches.length, maxResults, warnings)
  const cappedMatches = matches.slice(0, maxResults)
  const boundedMatches = boundMatches(cappedMatches, charLimit)
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
  warnings: string[],
): Promise<SearchToolOutput["matches"]> => {
  const skipGenerated = shouldSkipGeneratedDirectories(root, workspacePath)
  const rgFiles = await tryRgFiles(root, includeHidden, skipGenerated)
  const candidates = rgFiles ?? (await walkFiles(root, includeHidden))
  const loweredQuery = normalizePathForSearch(query)
  const filtered = candidates.filter((candidate) => {
    const relative = candidateRelativePath(root, candidate)
    const basename = path.basename(relative)
    return query.includes("*")
      ? globLikeMatch(relative, query) || globLikeMatch(basename, query)
      : normalizePathForSearch(relative).includes(loweredQuery) || basename.toLowerCase().includes(loweredQuery)
  })
  addGeneratedDirectoryWarning(skipGenerated, warnings)
  addResultCapWarning(filtered.length, maxResults, warnings)
  return filtered.map((candidate) => ({ path: toWorkspaceRelativePath(workspacePath, candidateAbsolutePath(root, candidate)) }))
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
  const skipGenerated = shouldSkipGeneratedDirectories(root, workspacePath)
  if (input.regex === undefined && regexLike) {
    warnings.push("Query looked like regex syntax, so search interpreted it as regex. Set regex=false to search it literally.")
  }
  const args = [
    "--line-number",
    "--column",
    "--no-heading",
    "--color",
    "never",
    "--max-count",
    String(maxResults),
    ...(useRegex ? [] : ["--fixed-strings"]),
    ...(input.caseSensitive ? [] : ["--ignore-case"]),
    ...generatedDirectoryRgGlobs(skipGenerated),
    input.query,
    root,
  ]
  try {
    const rgOutput = await runRgWithLineLimit(args, maxResults + 1)
    const allMatches = parseRgOutput(rgOutput.stdout, workspacePath)
    addResultCapWarning(rgOutput.maybeMore ? maxResults + 1 : allMatches.length, maxResults, warnings)
    addGeneratedDirectoryWarning(skipGenerated, warnings)
    addZeroMatchWarning(allMatches, input, useRegex, regexLike, warnings)
    return allMatches
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & { stdout?: string; code?: number }
    if (nodeError.stdout) {
      const allMatches = parseRgOutput(nodeError.stdout, workspacePath)
      addResultCapWarning(allMatches.length, maxResults, warnings)
      addGeneratedDirectoryWarning(skipGenerated, warnings)
      addZeroMatchWarning(allMatches, input, useRegex, regexLike, warnings)
      return allMatches
    }
    if (nodeError.code === 1) {
      addZeroMatchWarning([], input, useRegex, regexLike, warnings)
      return []
    }
    if (useRegex && isInvalidRegexError(nodeError)) {
      warnings.push("Regex search failed to parse; retried as a literal fixed-string search.")
      const matches = await searchTextFallback(root, workspacePath, { ...input, regex: false }, maxResults, warnings)
      addZeroMatchWarning(matches, input, false, regexLike, warnings)
      return matches
    }
    const matches = await searchTextFallback(root, workspacePath, { ...input, regex: useRegex }, maxResults, warnings)
    addZeroMatchWarning(matches, input, useRegex, regexLike, warnings)
    return matches
  }
}

const runRgWithLineLimit = async (args: string[], maxLines: number): Promise<{ stdout: string; maybeMore: boolean }> =>
  new Promise((resolve, reject) => {
    const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] })
    const lines: string[] = []
    let buffer = ""
    let stderr = ""
    let maybeMore = false
    let settled = false

    const finish = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      if (error) {
        const enriched = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number }
        enriched.stdout = lines.join("\n")
        enriched.stderr = stderr
        reject(enriched)
        return
      }
      resolve({ stdout: lines.join("\n"), maybeMore })
    }

    const pushLine = (line: string) => {
      if (!line) {
        return
      }
      if (lines.length < maxLines) {
        lines.push(line)
        return
      }
      maybeMore = true
      child.kill()
      finish()
    }

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf("\n")
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        pushLine(line)
        if (maybeMore) {
          return
        }
        newlineIndex = buffer.indexOf("\n")
      }
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.on("error", (error) => finish(error))
    child.on("close", (code) => {
      if (maybeMore) {
        return
      }
      if (buffer.length > 0) {
        pushLine(buffer)
        buffer = ""
        if (maybeMore) {
          return
        }
      }
      if (code === 0 || code === 1) {
        finish()
        return
      }
      finish(Object.assign(new Error(`rg exited with code ${code ?? "unknown"}`), { code: code ?? undefined, stderr }))
    })

    setTimeout(() => {
      if (!settled) {
        child.kill()
        finish(Object.assign(new Error("rg timed out"), { code: "ETIMEDOUT", stderr }))
      }
    }, 20_000)
  })

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

const tryRgFiles = async (root: string, includeHidden: boolean, skipGenerated: boolean): Promise<string[] | null> => {
  try {
    const result = await execFileAsync("rg", ["--files", ...(includeHidden ? ["--hidden"] : []), ...generatedDirectoryRgGlobs(skipGenerated), root], {
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
  warnings: string[],
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
  addResultCapWarning(matches.length, maxResults, warnings)
  addGeneratedDirectoryWarning(shouldSkipGeneratedDirectories(root, workspacePath), warnings)
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

const shouldSkipGeneratedDirectories = (root: string, workspacePath: string): boolean => {
  const relative = normalizePathForSearch(path.relative(workspacePath, root))
  if (!relative || relative === ".") {
    return true
  }
  return !relative.split("/").some((segment) => skippedDirectories.has(segment))
}

const generatedDirectoryRgGlobs = (enabled: boolean): string[] =>
  enabled
    ? [...skippedDirectories].flatMap((directory) => ["--glob", `!${directory}/**`, "--glob", `!**/${directory}/**`])
    : []

const addGeneratedDirectoryWarning = (skipped: boolean, warnings: string[]): void => {
  if (!skipped || warnings.some((warning) => warning.includes("generated/vendor directories"))) {
    return
  }
  warnings.push("Search skipped generated/vendor directories by default: .git, node_modules, dist, build, .next, .turbo, coverage.")
}

const addResultCapWarning = (totalMatches: number, maxResults: number, warnings: string[]): void => {
  if (totalMatches <= maxResults || warnings.some((warning) => warning.includes("Search results were capped"))) {
    return
  }
  warnings.push(`Search results were capped at ${maxResults} matches. Narrow path/query to reduce noise.`)
}

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
