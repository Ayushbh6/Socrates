import fs from "node:fs"
import path from "node:path"
import { SocratesError } from "@socrates/shared"
import type { TruncationMetadata } from "@socrates/contracts"

export const DEFAULT_CHAR_LIMIT = 20_000
export const MAX_CHAR_LIMIT = 80_000

export const clampCharLimit = (charLimit?: number): number => Math.min(charLimit ?? DEFAULT_CHAR_LIMIT, MAX_CHAR_LIMIT)

export const resolveWorkspacePath = (workspacePath: string, requestedPath?: string): string => {
  const workspaceRoot = path.resolve(workspacePath)
  const target = path.resolve(workspaceRoot, requestedPath ?? ".")
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${path.sep}`)) {
    throw new SocratesError("workspace_path_escape", "Tool paths must stay inside the active project workspace", {
      details: { workspacePath: workspaceRoot, requestedPath },
    })
  }
  return target
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
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base.endsWith(".pem") ||
    base.endsWith(".key") ||
    base.includes("secret") ||
    base.includes("credential")
  )
}

export const ensureParentDirectory = (targetPath: string): void => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
}
