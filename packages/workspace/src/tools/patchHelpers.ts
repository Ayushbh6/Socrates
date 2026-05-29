import { spawn } from "node:child_process"
import type { ApplyPatchToolInput, EditToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { clampCharLimit, isSensitivePath, resolveWorkspacePath, toWorkspaceRelativePath, truncateText } from "./common"
import { readFileSnapshot, type FileSnapshot } from "./fileMetadata"

type PatchChangedFile = EditToolOutput["changedFiles"][number]
type PatchOperation = PatchChangedFile["operation"]

type PatchFileChange = {
  path: string
  operation: Extract<PatchOperation, "created" | "patched" | "deleted" | "renamed">
  oldPath?: string
  newPath?: string
  previousPath?: string
}

type PatchSection = {
  oldPath?: string
  newPath?: string
  renameFrom?: string
  renameTo?: string
}

type PatchVerificationRecord = {
  path: string
  operation: PatchChangedFile["operation"]
  before: FileSnapshot
  after: FileSnapshot
  previousPath?: string
  lineDelta?: number
}

export const applyPatchWorkspace = async (
  input: ApplyPatchToolInput,
  context: { workspacePath: string },
): Promise<EditToolOutput> => {
  const dryRun = input.dryRun ?? false
  const changes = parsePatchFileChanges(input.patch)
  validatePatch(changes, context.workspacePath)
  const beforeSnapshots = collectPatchSnapshots(changes, context.workspacePath)
  const verificationByPath = new Map<string, PatchVerificationRecord>()

  if (!dryRun) {
    await applyPatch(context.workspacePath, input.patch)
    for (const change of changes) {
      const verification = verifyPatchChange(change, beforeSnapshots, context.workspacePath)
      verificationByPath.set(change.path, verification)
    }
  }

  const changedFiles = changes.map((change) => {
    const verification = verificationByPath.get(change.path)
    return enrichChangedFile(
      {
        path: change.path,
        operation: change.operation,
        ...(change.previousPath ? { previousPath: change.previousPath } : {}),
        verification: dryRun ? undefined : ("verified" as const),
      },
      verification,
    )
  })
  const truncated = truncateText(input.patch, clampCharLimit(), 0)
  return {
    changedFiles,
    diff: truncated.text,
    dryRun,
    truncation: truncated.truncation,
  }
}

const collectPatchSnapshots = (changes: PatchFileChange[], workspacePath: string): Map<string, FileSnapshot> => {
  const snapshots = new Map<string, FileSnapshot>()
  for (const change of changes) {
    for (const patchPath of snapshotPaths(change)) {
      const absolutePath = resolveWorkspacePath(workspacePath, patchPath)
      const relativePath = toWorkspaceRelativePath(workspacePath, absolutePath)
      if (!snapshots.has(relativePath)) {
        snapshots.set(relativePath, readFileSnapshot(absolutePath, { includeText: true }))
      }
    }
  }
  return snapshots
}

const snapshotPaths = (change: PatchFileChange): string[] => {
  if (change.operation === "created") {
    return [change.path]
  }
  if (change.operation === "deleted") {
    return [change.oldPath ?? change.path]
  }
  if (change.operation === "renamed") {
    return [change.previousPath ?? change.oldPath ?? change.path, change.path]
  }
  return [change.path]
}

const validatePatch = (changes: PatchFileChange[], workspacePath: string): void => {
  if (changes.length === 0) {
    throw new SocratesError("patch_parse_failed", "Patch did not contain any file changes.", { recoverable: true })
  }
  for (const change of changes) {
    for (const patchPath of snapshotPaths(change)) {
      const absolutePath = resolveWorkspacePath(workspacePath, patchPath)
      if (isSensitivePath(absolutePath)) {
        throw new SocratesError("sensitive_path_denied", "Editing sensitive credential-like paths is denied in V1.", {
          details: { path: patchPath },
        })
      }
    }
  }
}

const verifyPatchChange = (
  change: PatchFileChange,
  beforeSnapshots: Map<string, FileSnapshot>,
  workspacePath: string,
): PatchVerificationRecord => {
  if (change.operation === "created") {
    const after = readSnapshot(workspacePath, change.path)
    if (!after.snapshot.exists) {
      throw new SocratesError("patch_verification_failed", "Created patch target was not present after git apply.", {
        details: { path: change.path },
      })
    }
    return verificationRecord(change, beforeSnapshots.get(after.relativePath) ?? { exists: false }, after.snapshot)
  }

  if (change.operation === "deleted") {
    const beforePath = change.oldPath ?? change.path
    const after = readSnapshot(workspacePath, beforePath)
    if (after.snapshot.exists) {
      throw new SocratesError("patch_verification_failed", "Deleted patch target was still present after git apply.", {
        details: { path: beforePath, contentHashAfter: after.snapshot.contentHash },
      })
    }
    const before = beforeSnapshots.get(after.relativePath) ?? { exists: false }
    return verificationRecord(change, before, after.snapshot)
  }

  if (change.operation === "renamed") {
    const oldPath = change.previousPath ?? change.oldPath ?? change.path
    const oldAfter = readSnapshot(workspacePath, oldPath)
    if (oldAfter.snapshot.exists) {
      throw new SocratesError("patch_verification_failed", "Renamed patch source was still present after git apply.", {
        details: { path: oldPath, contentHashAfter: oldAfter.snapshot.contentHash },
      })
    }
    const newAfter = readSnapshot(workspacePath, change.path)
    if (!newAfter.snapshot.exists) {
      throw new SocratesError("patch_verification_failed", "Renamed patch target was not present after git apply.", {
        details: { path: change.path },
      })
    }
    const before = beforeSnapshots.get(oldAfter.relativePath) ?? { exists: false }
    return verificationRecord(change, before, newAfter.snapshot)
  }

  const after = readSnapshot(workspacePath, change.path)
  const before = beforeSnapshots.get(after.relativePath) ?? { exists: false }
  if (!after.snapshot.exists) {
    throw new SocratesError("patch_verification_failed", "Patch target was not present after git apply.", {
      details: { path: change.path, contentHashBefore: before.contentHash },
    })
  }
  if (before.exists && before.contentHash === after.snapshot.contentHash) {
    throw new SocratesError("patch_verification_failed", "Patch target content did not change after git apply.", {
      details: { path: change.path, contentHash: after.snapshot.contentHash },
    })
  }
  return verificationRecord(change, before, after.snapshot)
}

const readSnapshot = (workspacePath: string, patchPath: string): { relativePath: string; snapshot: FileSnapshot } => {
  const absolutePath = resolveWorkspacePath(workspacePath, patchPath)
  const relativePath = toWorkspaceRelativePath(workspacePath, absolutePath)
  return { relativePath, snapshot: readFileSnapshot(absolutePath, { includeText: true }) }
}

const verificationRecord = (change: PatchFileChange, before: FileSnapshot, after: FileSnapshot): PatchVerificationRecord => ({
  path: change.path,
  operation: change.operation,
  before,
  after,
  ...(change.previousPath ? { previousPath: change.previousPath } : {}),
  lineDelta: (after.lineCount ?? 0) - (before.lineCount ?? 0),
})

export const pathsFromPatch = (patchText: string): string[] => parsePatchFileChanges(patchText).map((change) => change.path)

export const parsePatchFileChanges = (patchText: string): PatchFileChange[] => {
  const changes: PatchFileChange[] = []
  let section: PatchSection = {}
  let hasSection = false

  const flush = (): void => {
    const change = sectionToChange(section)
    if (change) {
      changes.push(change)
    }
    section = {}
    hasSection = false
  }

  for (const line of patchText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush()
      hasSection = true
      continue
    }
    if (line.startsWith("--- ")) {
      if (!hasSection && (section.oldPath || section.newPath)) {
        flush()
      }
      hasSection = true
      const oldPath = parsePatchPath(line.slice(4))
      if (oldPath === undefined) {
        delete section.oldPath
      } else {
        section.oldPath = oldPath
      }
      continue
    }
    if (line.startsWith("+++ ")) {
      hasSection = true
      const newPath = parsePatchPath(line.slice(4))
      if (newPath === undefined) {
        delete section.newPath
      } else {
        section.newPath = newPath
      }
      continue
    }
    if (line.startsWith("rename from ")) {
      hasSection = true
      section.renameFrom = cleanPatchPath(line.slice("rename from ".length))
      continue
    }
    if (line.startsWith("rename to ")) {
      hasSection = true
      section.renameTo = cleanPatchPath(line.slice("rename to ".length))
    }
  }
  flush()
  return changes
}

const sectionToChange = (section: PatchSection): PatchFileChange | undefined => {
  const oldPath = section.renameFrom ?? section.oldPath
  const newPath = section.renameTo ?? section.newPath
  if (!oldPath && !newPath) {
    return undefined
  }
  if (!oldPath && newPath) {
    return { path: newPath, newPath, operation: "created" }
  }
  if (oldPath && !newPath) {
    return { path: oldPath, oldPath, operation: "deleted" }
  }
  if (oldPath && newPath && oldPath !== newPath) {
    return { path: newPath, oldPath, newPath, previousPath: oldPath, operation: "renamed" }
  }
  const path = newPath ?? oldPath
  return path ? { path, oldPath: path, newPath: path, operation: "patched" } : undefined
}

const parsePatchPath = (value: string): string | undefined => {
  const cleaned = cleanPatchPath(value)
  return cleaned === "/dev/null" ? undefined : cleaned
}

const cleanPatchPath = (value: string): string => {
  let cleaned = value.trim()
  const tabIndex = cleaned.indexOf("\t")
  if (tabIndex >= 0) {
    cleaned = cleaned.slice(0, tabIndex)
  }
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    cleaned = cleaned.slice(1, -1)
  }
  return cleaned.replace(/^[ab]\//, "")
}

const applyPatch = async (workspacePath: string, patchText: string): Promise<void> => {
  await runGitApply(workspacePath, patchText, true)
  await runGitApply(workspacePath, patchText, false)
}

const runGitApply = (workspacePath: string, patchText: string, check: boolean): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", ["apply", ...(check ? ["--check"] : []), "--whitespace=nowarn", "-"], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
      reject(new SocratesError("patch_timeout", "Patch application timed out"))
    }, 20_000)
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
      } else {
        reject(new SocratesError("patch_apply_failed", "Patch could not be applied", { details: { stderr, code } }))
      }
    })
    child.stdin.end(patchText)
  })

const enrichChangedFile = (file: PatchChangedFile, verification: PatchVerificationRecord | undefined): PatchChangedFile => {
  if (!verification) {
    return file
  }
  return {
    ...file,
    verification: "verified",
    ...(verification.previousPath ? { previousPath: verification.previousPath } : {}),
    contentHashBefore: verification.before.contentHash,
    contentHashAfter: verification.after.contentHash,
    sizeBytesBefore: verification.before.sizeBytes,
    sizeBytesAfter: verification.after.sizeBytes,
    lineDelta: verification.lineDelta,
  }
}
