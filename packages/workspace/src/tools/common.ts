import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SocratesError } from "@socrates/shared"
import type { TruncationMetadata } from "@socrates/contracts"

export const DEFAULT_CHAR_LIMIT = 20_000
export const MAX_CHAR_LIMIT = 80_000
export const DEFAULT_TOKEN_LIMIT = 4_000
export const MAX_TOKEN_LIMIT = 6_000
const APPROX_CHARS_PER_TOKEN = 4

export const clampCharLimit = (charLimit?: number): number => Math.min(charLimit ?? DEFAULT_CHAR_LIMIT, MAX_CHAR_LIMIT)

export const clampTokenLimit = (tokenLimit?: number): number => Math.min(tokenLimit ?? DEFAULT_TOKEN_LIMIT, MAX_TOKEN_LIMIT)

export const charLimitForTokenCap = (tokenLimit?: number): number => clampTokenLimit(tokenLimit) * APPROX_CHARS_PER_TOKEN

export const resolveWorkspacePath = (workspacePath: string, requestedPath?: string): string => {
  const workspaceRoot = path.resolve(workspacePath)
  const normalizedRequest = normalizeWorkspaceRequestPath(requestedPath)
  const target = path.resolve(workspaceRoot, normalizedRequest ?? ".")
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new SocratesError("workspace_path_escape", "Tool paths must stay inside the active project workspace", {
      details: { workspacePath: workspaceRoot, requestedPath },
    })
  }
  return target
}

const normalizeWorkspaceRequestPath = (requestedPath?: string): string | undefined => {
  if (!requestedPath) {
    return requestedPath
  }
  return requestedPath.replaceAll("\\", path.sep)
}

export const toWorkspaceRelativePath = (workspacePath: string, targetPath: string): string => {
  const relative = path.relative(path.resolve(workspacePath), path.resolve(targetPath))
  return relative.length === 0 ? "." : relative
}

export const truncateText = (text: string, charLimit = DEFAULT_CHAR_LIMIT, offset = 0): { text: string; truncation: TruncationMetadata } => {
  const limit = clampCharLimit(charLimit)
  const start = Math.min(offset, text.length)
  const end = Math.min(start + limit, text.length)
  const sliced = text.slice(start, end)
  return {
    text: sliced,
    truncation: {
      truncated: end < text.length,
      charLimit: limit,
      originalLength: text.length,
      returnedLength: sliced.length,
      ...(end < text.length ? { nextOffset: end } : {}),
    },
  }
}

export const emptyTruncation = (charLimit?: number): TruncationMetadata => ({
  truncated: false,
  charLimit: clampCharLimit(charLimit),
  returnedLength: 0,
})

export const isProbablyBinary = (buffer: Buffer): boolean => {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000))
  return sample.includes(0)
}

export const isSensitivePath = (targetPath: string): boolean => {
  const base = path.basename(targetPath).toLowerCase()
  if (isEnvTemplatePath(base)) {
    return false
  }
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.includes("secret") ||
    base.includes("credential")
  )
}

export const assertNotProjectNotesMutation = (workspacePath: string, targetPath: string, requestedPath?: string): void => {
  const relativePath = toWorkspaceRelativePath(workspacePath, targetPath).replaceAll(path.sep, "/").toLowerCase()
  if (relativePath !== ".socrates/project_notes.md" && relativePath !== ".socrates/memory.md") {
    return
  }
  const area = relativePath.endsWith("memory.md") ? "memory" : "notes"
  throw new SocratesError(
    "project_docs_dedicated_tool_required",
    ".socrates/MEMORY.md and PROJECT_NOTES.md can only be edited through the project_docs tool. Retry with project_docs operation=\"edit\" and the correct area; normal read/search may still inspect them.",
    {
      recoverable: true,
      details: { path: requestedPath ?? relativePath, tool: "project_docs", operation: "edit", area },
    },
  )
}

export const assertNotRepoDocsMutation = (workspacePath: string, targetPath: string, requestedPath?: string): void => {
  const relativePath = toWorkspaceRelativePath(workspacePath, targetPath).replaceAll(path.sep, "/").toLowerCase()
  if (!relativePath.startsWith(".socrates/repo_docs/") || !relativePath.endsWith(".md")) {
    return
  }
  throw new SocratesError(
    "repo_docs_dedicated_tool_required",
    ".socrates/repo_docs/*.md can only be edited through the repo_docs tool. Retry with repo_docs operation=\"edit\"; normal read/search may still inspect these files.",
    {
      recoverable: true,
      details: { path: requestedPath ?? relativePath, tool: "repo_docs", operation: "edit" },
    },
  )
}

export const assertNotProjectSkillsMutation = (workspacePath: string, targetPath: string, requestedPath?: string): void => {
  const relativePath = toWorkspaceRelativePath(workspacePath, targetPath).replaceAll(path.sep, "/").toLowerCase()
  if (!relativePath.startsWith(".socrates/skills/")) {
    return
  }
  throw new SocratesError(
    "project_skills_dedicated_builder_required",
    ".socrates/skills/* can only be changed through the backend skill builder. Use the project dashboard Skills + flow; normal read/search may still inspect project skills.",
    {
      recoverable: true,
      details: { path: requestedPath ?? relativePath, tool: "skills", operation: "read" },
    },
  )
}

type ProtectedSocratesPathMention = {
  targetKind: "project_docs" | "repo_docs" | "project_skills" | "global_skills" | "tool_usage" | "soul" | "user_profile"
  pattern: string
}

type ProtectedSocratesPathOptions = {
  homeDir?: string
}

export const findProtectedSocratesPathMentions = (
  text: string,
  options: ProtectedSocratesPathOptions = {},
): ProtectedSocratesPathMention[] => {
  const normalized = normalizeCommandPathText(text)
  const homeDir = options.homeDir ?? os.homedir()
  const patterns = protectedSocratesPathPatterns(homeDir)
  const seen = new Set<string>()
  const matches: ProtectedSocratesPathMention[] = []
  for (const pattern of patterns) {
    if (!containsPathMention(normalized, pattern.pattern)) {
      continue
    }
    const key = `${pattern.targetKind}:${pattern.pattern}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    matches.push(pattern)
  }
  return matches
}

export const assertNoProtectedSocratesPathMentions = (
  text: string,
  options: ProtectedSocratesPathOptions = {},
): void => {
  const matches = findProtectedSocratesPathMentions(text, options)
  if (matches.length === 0) {
    return
  }
  throw new SocratesError(
    "terminal_protected_socrates_path_rejected",
    "Terminal command rejected because it mentions Socrates-owned memory, docs, tool-usage, soul, user-profile, or skills paths. Use project_docs, repo_docs, tool_docs, soul, user_profile, skills, or the dashboard skill builder instead.",
    {
      recoverable: true,
      details: {
        matches,
        note: "This is a cross-platform preflight guard for obvious protected path mentions, not an OS process sandbox.",
      },
    },
  )
}

const protectedSocratesPathPatterns = (homeDir: string): ProtectedSocratesPathMention[] => {
  const globalRoots = [
    "~/.socrates",
    "$home/.socrates",
    "${home}/.socrates",
    "$env:home/.socrates",
    "%userprofile%/.socrates",
    "$env:userprofile/.socrates",
    normalizeCommandPathText(homeDir ? path.join(homeDir, ".Socrates") : ""),
  ].filter((item): item is string => item.length > 0)

  return [
    { targetKind: "project_docs", pattern: ".socrates/memory.md" },
    { targetKind: "project_docs", pattern: ".socrates/project_notes.md" },
    { targetKind: "repo_docs", pattern: ".socrates/repo_docs" },
    { targetKind: "project_skills", pattern: ".socrates/skills" },
    { targetKind: "project_skills", pattern: ".socrates/skill" },
    ...globalRoots.flatMap((root) => [
      { targetKind: "global_skills" as const, pattern: `${root}/skills` },
      { targetKind: "global_skills" as const, pattern: `${root}/skill` },
      { targetKind: "tool_usage" as const, pattern: `${root}/tool_usage` },
      { targetKind: "soul" as const, pattern: `${root}/identity.md` },
      { targetKind: "user_profile" as const, pattern: `${root}/user_profile.md` },
    ]),
  ]
}

const normalizeCommandPathText = (value: string): string =>
  value.replaceAll("\\", "/").replaceAll(/\/+/g, "/").toLowerCase()

const containsPathMention = (text: string, pattern: string): boolean => {
  let index = text.indexOf(pattern)
  while (index >= 0) {
    const after = text.at(index + pattern.length)
    if (after === undefined || !/[a-z0-9._-]/i.test(after)) {
      return true
    }
    index = text.indexOf(pattern, index + pattern.length)
  }
  return false
}

const isEnvTemplatePath = (base: string): boolean =>
  base === ".env.example" ||
  base === ".env.sample" ||
  base === ".env.template" ||
  base.endsWith(".env.example") ||
  base.endsWith(".env.sample") ||
  base.endsWith(".env.template") ||
  base.endsWith(".env.local.example")

export const ensureParentDirectory = (targetPath: string): void => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
}
