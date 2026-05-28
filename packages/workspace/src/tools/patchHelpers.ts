import { spawn } from "node:child_process"
import type { ApplyPatchToolInput, EditToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { clampCharLimit, isSensitivePath, resolveWorkspacePath, toWorkspaceRelativePath, truncateText } from "./common"
import { readFileSnapshot, type FileSnapshot } from "./fileMetadata"

type PatchChangedFile = EditToolOutput["changedFiles"][number]

type PatchVerificationRecord = {
  path: string
  operation: PatchChangedFile["operation"]
  before: FileSnapshot
  after: FileSnapshot
  lineDelta?: number
}

export const applyPatchWorkspace = async (
  input: ApplyPatchToolInput,
  context: { workspacePath: string },
): Promise<EditToolOutput> => {
  const dryRun = input.dryRun ?? false
  validatePatch(input.patch, context.workspacePath)
  const beforeSnapshots = collectPatchSnapshots(input.patch, context.workspacePath)
  const verificationByPath = new Map<string, PatchVerificationRecord>()

  if (!dryRun) {
    await applyPatch(context.workspacePath, input.patch)
    for (const patchPath of pathsFromPatch(input.patch)) {
      const absolutePath = resolveWorkspacePath(context.workspacePath, patchPath)
      const relativePath = toWorkspaceRelativePath(context.workspacePath, absolutePath)
      const before = beforeSnapshots.get(relativePath) ?? { exists: false }
      const after = readFileSnapshot(absolutePath, { includeText: true })
      verifyPatchedFile(relativePath, before, after)
      verificationByPath.set(relativePath, {
        path: relativePath,
        operation: "patched",
        before,
        after,
        lineDelta: (after.lineCount ?? 0) - (before.lineCount ?? 0),
      })
    }
  }

  const changedFiles = pathsFromPatch(input.patch).map((patchPath) => {
    const verification = verificationByPath.get(patchPath)
    return enrichChangedFile(
      {
        path: patchPath,
        operation: "patched" as const,
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

const collectPatchSnapshots = (patchText: string, workspacePath: string): Map<string, FileSnapshot> => {
  const snapshots = new Map<string, FileSnapshot>()
  for (const patchPath of pathsFromPatch(patchText)) {
    const absolutePath = resolveWorkspacePath(workspacePath, patchPath)
    const relativePath = toWorkspaceRelativePath(workspacePath, absolutePath)
    snapshots.set(relativePath, readFileSnapshot(absolutePath, { includeText: true }))
  }
  return snapshots
}

const validatePatch = (patchText: string, workspacePath: string): void => {
  for (const patchPath of pathsFromPatch(patchText)) {
    const absolutePath = resolveWorkspacePath(workspacePath, patchPath)
    if (isSensitivePath(absolutePath)) {
      throw new SocratesError("sensitive_path_denied", "Editing sensitive credential-like paths is denied in V1.", {
        details: { path: patchPath },
      })
    }
  }
}

export const pathsFromPatch = (patchText: string): string[] => {
  const paths = new Set<string>()
  for (const line of patchText.split("\n")) {
    if (!line.startsWith("+++ ") && !line.startsWith("--- ")) {
      continue
    }
    const raw = line.slice(4).trim()
    if (raw === "/dev/null") {
      continue
    }
    paths.add(raw.replace(/^[ab]\//, ""))
  }
  return [...paths]
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

const verifyPatchedFile = (relativePath: string, before: FileSnapshot, after: FileSnapshot): void => {
  if (!after.exists) {
    throw new SocratesError("patch_verification_failed", "Patch target was not present after git apply.", {
      details: { path: relativePath, contentHashBefore: before.contentHash },
    })
  }
  if (before.exists && before.contentHash === after.contentHash) {
    throw new SocratesError("patch_verification_failed", "Patch target content did not change after git apply.", {
      details: { path: relativePath, contentHash: after.contentHash },
    })
  }
}

const enrichChangedFile = (file: PatchChangedFile, verification: PatchVerificationRecord | undefined): PatchChangedFile => {
  if (!verification) {
    return file
  }
  return {
    ...file,
    verification: "verified",
    contentHashBefore: verification.before.contentHash,
    contentHashAfter: verification.after.contentHash,
    sizeBytesBefore: verification.before.sizeBytes,
    sizeBytesAfter: verification.after.sizeBytes,
    lineDelta: verification.lineDelta,
  }
}
