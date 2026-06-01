import fs from "node:fs"
import path from "node:path"
import { SocratesError } from "@socrates/shared"
import type { TruncationMetadata } from "@socrates/contracts"

export const DEFAULT_CHAR_LIMIT = 20_000
export const MAX_CHAR_LIMIT = 80_000

export const clampCharLimit = (charLimit?: number): number => Math.min(charLimit ?? DEFAULT_CHAR_LIMIT, MAX_CHAR_LIMIT)

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
  if (relativePath !== ".socrates/project_notes.md") {
    return
  }
  throw new SocratesError(
    "project_notes_dedicated_tool_required",
    "PROJECT_NOTES.md can only be edited through the project_notes tool. Retry with project_notes operation=\"patch\"; normal read/search may still inspect it.",
    {
      recoverable: true,
      details: { path: requestedPath ?? ".socrates/PROJECT_NOTES.md", tool: "project_notes", operation: "patch" },
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
    ".socrates/repo_docs/*.md can only be edited through the repo_docs tool. Retry with repo_docs operation=\"patch\"; normal read/search may still inspect these files.",
    {
      recoverable: true,
      details: { path: requestedPath ?? relativePath, tool: "repo_docs", operation: "patch" },
    },
  )
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
