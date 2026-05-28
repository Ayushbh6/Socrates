import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { EditOperation, EditToolInput, EditToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { clampCharLimit, ensureParentDirectory, isSensitivePath, resolveWorkspacePath, toWorkspaceRelativePath, truncateText } from "./common"
import { countLines, hashText, readFileSnapshot, type FileSnapshot } from "./fileMetadata"

type ChangedFile = EditToolOutput["changedFiles"][number]

type EditFileState = {
  absolutePath: string
  relativePath: string
  original: string
  current: string
  before: FileSnapshot
  existedAtStart: boolean
  existsNow: boolean
  operation: ChangedFile["operation"]
}

type VerificationRecord = {
  path: string
  operation: ChangedFile["operation"]
  before: FileSnapshot
  after: FileSnapshot
  expectedHash?: string
  lineDelta?: number
}

const editTestHooks: {
  afterWrite: ((filePath: string) => void) | undefined
} = { afterWrite: undefined }

export const editWorkspace = async (input: EditToolInput, context: { workspacePath: string }): Promise<EditToolOutput> => {
  const dryRun = input.dryRun ?? false
  const plannedPatches: Array<{
    operation: Extract<EditOperation, { type: "patch" }>
    beforeSnapshots: Map<string, FileSnapshot>
  }> = []
  const fileStates = new Map<string, EditFileState>()
  const changedFilesByPath = new Map<string, ChangedFile>()
  const verificationByPath = new Map<string, VerificationRecord>()

  for (const operation of input.operations) {
    if (operation.type === "patch") {
      validatePatch(operation.patch, context.workspacePath)
      plannedPatches.push({
        operation,
        beforeSnapshots: collectPatchSnapshots(operation, context.workspacePath),
      })
      continue
    }

    const absolutePath = resolveWorkspacePath(context.workspacePath, operation.path)
    if (isSensitivePath(absolutePath)) {
      throw new SocratesError("sensitive_path_denied", "Editing sensitive credential-like paths is denied in V1.", {
        details: { path: operation.path },
      })
    }
    const relativePath = toWorkspaceRelativePath(context.workspacePath, absolutePath)
    let state = fileStates.get(absolutePath)
    if (!state) {
      const before = readFileSnapshot(absolutePath, { includeText: true })
      state = {
        absolutePath,
        relativePath,
        original: before.content ?? "",
        current: before.content ?? "",
        before,
        existedAtStart: before.exists,
        existsNow: before.exists,
        operation: before.exists ? "edited" : "created",
      }
      fileStates.set(absolutePath, state)
    }
    let after: string
    let changedOperation: EditToolOutput["changedFiles"][number]["operation"]

    if (operation.type === "create") {
      if (state.existsNow) {
        throw new SocratesError("file_already_exists", "Create edit cannot overwrite an existing file", { details: { path: operation.path } })
      }
      after = operation.content
      changedOperation = "created"
    } else if (operation.type === "overwrite") {
      if (state.existedAtStart) {
        assertBaseContentHash(operation.path, state.before.contentHash, operation.baseContentHash)
      }
      after = operation.content
      changedOperation = state.existsNow ? "overwritten" : "created"
    } else {
      if (!state.existsNow) {
        throw new SocratesError("file_not_found", "Replace edit target does not exist", { details: { path: operation.path } })
      }
      const occurrences = state.current.split(operation.oldText).length - 1
      const expected = operation.expectedOccurrences ?? 1
      if (occurrences !== expected) {
        throw new SocratesError("replace_occurrence_mismatch", "Replace edit oldText occurrence count did not match", {
          details: { path: operation.path, expectedOccurrences: expected, actualOccurrences: occurrences },
        })
      }
      after = state.current.split(operation.oldText).join(operation.newText)
      changedOperation = "edited"
    }

    state.current = after
    state.existsNow = true
    state.operation = combineOperations(state, changedOperation)
    changedFilesByPath.set(relativePath, {
      path: relativePath,
      operation: state.operation,
      verification: dryRun ? undefined : "verified",
      contentHashBefore: state.before.contentHash,
      sizeBytesBefore: state.before.sizeBytes,
    })
  }

  if (!dryRun) {
    for (const item of fileStates.values()) {
      const expectedHash = hashText(item.current)
      safeWriteTextFile(item.absolutePath, item.current, item.before)
      editTestHooks.afterWrite?.(item.absolutePath)
      const after = readFileSnapshot(item.absolutePath, { includeText: true })
      verifyWrittenFile(item, after, expectedHash)
      verificationByPath.set(item.relativePath, {
        path: item.relativePath,
        operation: item.operation,
        before: item.before,
        after,
        expectedHash,
        lineDelta: countLines(item.current) - countLines(item.original),
      })
    }
    for (const item of plannedPatches) {
      await applyPatch(context.workspacePath, item.operation.patch)
      for (const patchPath of pathsFromPatch(item.operation.patch)) {
        const absolutePath = resolveWorkspacePath(context.workspacePath, patchPath)
        const relativePath = toWorkspaceRelativePath(context.workspacePath, absolutePath)
        const before = item.beforeSnapshots.get(relativePath) ?? { exists: false }
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
  }

  const patchedFiles = plannedPatches.flatMap((item) =>
    pathsFromPatch(item.operation.patch).map((patchPath) => ({
      path: patchPath,
      operation: "patched" as const,
      verification: dryRun ? undefined : ("verified" as const),
    })),
  )
  const changedFiles = [...changedFilesByPath.values(), ...patchedFiles].map((file) => enrichChangedFile(file, verificationByPath.get(file.path)))
  const diffs = [
    ...[...fileStates.values()].map((item) => createUnifiedDiff(item.relativePath, item.original, item.current)).filter(Boolean),
    ...plannedPatches.map((item) => item.operation.patch),
  ]
  const diffText = diffs.join("\n")
  const truncated = truncateText(diffText, clampCharLimit(), 0)
  return {
    changedFiles,
    diff: truncated.text,
    dryRun,
    truncation: truncated.truncation,
  }
}

const combineOperations = (
  state: { existedAtStart: boolean; operation: ChangedFile["operation"] },
  next: ChangedFile["operation"],
): ChangedFile["operation"] => {
  if (!state.existedAtStart) {
    return "created"
  }
  if (state.operation === "overwritten" || next === "overwritten") {
    return "overwritten"
  }
  return "edited"
}

const assertBaseContentHash = (path: string, actualHash: string | undefined, baseContentHash: string | undefined): void => {
  if (!baseContentHash) {
    throw new SocratesError("edit_stale_content", "Overwrite edits to existing files require a fresh baseContentHash from read.", {
      details: { path, actualHash },
    })
  }
  if (actualHash !== baseContentHash) {
    throw new SocratesError("edit_stale_content", "File content changed since Socrates last read it.", {
      details: { path, expectedBaseContentHash: baseContentHash, actualHash },
    })
  }
}

const collectPatchSnapshots = (
  operation: Extract<EditOperation, { type: "patch" }>,
  workspacePath: string,
): Map<string, FileSnapshot> => {
  const snapshots = new Map<string, FileSnapshot>()
  for (const patchPath of pathsFromPatch(operation.patch)) {
    const absolutePath = resolveWorkspacePath(workspacePath, patchPath)
    const relativePath = toWorkspaceRelativePath(workspacePath, absolutePath)
    const snapshot = readFileSnapshot(absolutePath, { includeText: true })
    if (snapshot.exists) {
      assertBaseContentHash(relativePath, snapshot.contentHash, operation.baseContentHashes?.[relativePath] ?? operation.baseContentHashes?.[patchPath])
    }
    snapshots.set(relativePath, snapshot)
  }
  return snapshots
}

const safeWriteTextFile = (absolutePath: string, content: string, before: FileSnapshot): void => {
  ensureParentDirectory(absolutePath)
  const tempPath = path.join(path.dirname(absolutePath), `.${path.basename(absolutePath)}.socrates-${process.pid}-${Date.now()}.tmp`)
  let fd: number | undefined
  try {
    fd = fs.openSync(tempPath, "w", before.mode === undefined ? 0o666 : before.mode & 0o777)
    fs.writeFileSync(fd, content, "utf8")
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tempPath, absolutePath)
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // Ignore close errors while reporting the original write failure.
      }
    }
    try {
      fs.rmSync(tempPath, { force: true })
    } catch {
      // Ignore cleanup errors while reporting the original write failure.
    }
    throw new SocratesError("edit_write_failed", "Could not write file edit to disk.", {
      details: { path: absolutePath, message: error instanceof Error ? error.message : String(error) },
    })
  }
}

const verifyWrittenFile = (state: EditFileState, after: FileSnapshot, expectedHash: string): void => {
  if (!after.exists || after.contentHash !== expectedHash || after.content !== state.current) {
    throw new SocratesError("edit_verification_failed", "File edit did not persist to disk as expected.", {
      details: {
        path: state.relativePath,
        expectedContentHash: expectedHash,
        actualContentHash: after.contentHash,
        expectedSizeBytes: Buffer.byteLength(state.current, "utf8"),
        actualSizeBytes: after.sizeBytes,
      },
    })
  }
}

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

const enrichChangedFile = (file: ChangedFile, verification: VerificationRecord | undefined): ChangedFile => {
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

const pathsFromPatch = (patchText: string): string[] => {
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

type LineDiffOp = {
  kind: "context" | "add" | "remove"
  line: string
  oldLine?: number
  newLine?: number
}

const createUnifiedDiff = (relativePath: string, before: string, after: string): string => {
  if (before === after) {
    return ""
  }
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  const ops = diffLines(beforeLines, afterLines)
  const hunks = buildUnifiedHunks(ops)
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    ...hunks.flatMap((hunk) => [
      hunk.header,
      ...hunk.ops.map((op) => `${op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " "}${op.line}`),
    ]),
  ].join("\n")
}

const diffLines = (beforeLines: string[], afterLines: string[]): LineDiffOp[] => {
  let prefix = 0
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const beforeMiddle = beforeLines.slice(prefix, beforeLines.length - suffix)
  const afterMiddle = afterLines.slice(prefix, afterLines.length - suffix)
  const ops: LineDiffOp[] = []

  for (let index = 0; index < prefix; index += 1) {
    ops.push({ kind: "context", line: beforeLines[index] ?? "", oldLine: index + 1, newLine: index + 1 })
  }

  if (beforeMiddle.length * afterMiddle.length > 2_000_000) {
    for (let index = 0; index < beforeMiddle.length; index += 1) {
      ops.push({ kind: "remove", line: beforeMiddle[index] ?? "", oldLine: prefix + index + 1 })
    }
    for (let index = 0; index < afterMiddle.length; index += 1) {
      ops.push({ kind: "add", line: afterMiddle[index] ?? "", newLine: prefix + index + 1 })
    }
  } else {
    ops.push(...diffMiddleLines(beforeMiddle, afterMiddle, prefix))
  }

  for (let index = suffix; index > 0; index -= 1) {
    const oldLine = beforeLines.length - index + 1
    const newLine = afterLines.length - index + 1
    ops.push({ kind: "context", line: beforeLines[oldLine - 1] ?? "", oldLine, newLine })
  }

  return ops
}

const diffMiddleLines = (beforeLines: string[], afterLines: string[], offset: number): LineDiffOp[] => {
  const rows = beforeLines.length + 1
  const cols = afterLines.length + 1
  const table = Array.from({ length: rows }, () => Array<number>(cols).fill(0))

  for (let row = beforeLines.length - 1; row >= 0; row -= 1) {
    for (let col = afterLines.length - 1; col >= 0; col -= 1) {
      const currentRow = table[row] as number[]
      currentRow[col] =
        beforeLines[row] === afterLines[col]
          ? (table[row + 1]?.[col + 1] ?? 0) + 1
          : Math.max(table[row + 1]?.[col] ?? 0, table[row]?.[col + 1] ?? 0)
    }
  }

  const ops: LineDiffOp[] = []
  let row = 0
  let col = 0
  while (row < beforeLines.length || col < afterLines.length) {
    if (row < beforeLines.length && col < afterLines.length && beforeLines[row] === afterLines[col]) {
      ops.push({ kind: "context", line: beforeLines[row] ?? "", oldLine: offset + row + 1, newLine: offset + col + 1 })
      row += 1
      col += 1
    } else if (col < afterLines.length && (row >= beforeLines.length || (table[row]?.[col + 1] ?? 0) >= (table[row + 1]?.[col] ?? 0))) {
      ops.push({ kind: "add", line: afterLines[col] ?? "", newLine: offset + col + 1 })
      col += 1
    } else if (row < beforeLines.length) {
      ops.push({ kind: "remove", line: beforeLines[row] ?? "", oldLine: offset + row + 1 })
      row += 1
    }
  }
  return ops
}

const buildUnifiedHunks = (ops: LineDiffOp[], contextLines = 3): Array<{ header: string; ops: LineDiffOp[] }> => {
  const changeIndexes = ops
    .map((op, index) => (op.kind === "add" || op.kind === "remove" ? index : -1))
    .filter((index) => index >= 0)
  const hunks: Array<{ start: number; end: number }> = []

  for (const changeIndex of changeIndexes) {
    const start = Math.max(0, changeIndex - contextLines)
    const end = Math.min(ops.length - 1, changeIndex + contextLines)
    const previous = hunks[hunks.length - 1]
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end)
    } else {
      hunks.push({ start, end })
    }
  }

  return hunks.map((hunk) => {
    const hunkOps = ops.slice(hunk.start, hunk.end + 1)
    const oldLines = hunkOps.filter((op) => op.kind !== "add")
    const newLines = hunkOps.filter((op) => op.kind !== "remove")
    const oldStart = firstLineNumber(oldLines, "oldLine")
    const newStart = firstLineNumber(newLines, "newLine")
    return {
      header: `@@ -${oldStart},${oldLines.length} +${newStart},${newLines.length} @@`,
      ops: hunkOps,
    }
  })
}

const firstLineNumber = (ops: LineDiffOp[], key: "oldLine" | "newLine"): number => {
  const value = ops.find((op) => op[key] !== undefined)?.[key]
  return value ?? 1
}

export const __editToolTest = {
  setAfterWriteHook(hook: ((filePath: string) => void) | undefined): void {
    editTestHooks.afterWrite = hook
  },
}
