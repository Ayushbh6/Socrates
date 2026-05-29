import fs from "node:fs"
import path from "node:path"
import type { EditToolInput, EditToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { clampCharLimit, ensureParentDirectory, isSensitivePath, resolveWorkspacePath, toWorkspaceRelativePath, truncateText } from "./common"
import type { FileFreshnessTracker } from "./fileFreshness"
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

const editTestHooks: {
  afterWrite: ((filePath: string) => void) | undefined
} = { afterWrite: undefined }

export const editWorkspace = async (
  input: EditToolInput,
  context: { workspacePath: string; fileFreshness?: FileFreshnessTracker },
): Promise<EditToolOutput> => {
  const dryRun = input.dryRun ?? false
  const absolutePath = resolveWorkspacePath(context.workspacePath, input.path)
  if (isSensitivePath(absolutePath)) {
    throw new SocratesError("sensitive_path_denied", "Editing sensitive credential-like paths is denied in V1.", {
      details: { path: input.path },
    })
  }

  const relativePath = toWorkspaceRelativePath(context.workspacePath, absolutePath)
  const before = readFileSnapshot(absolutePath, { includeText: true })
  const isReplace = input.oldString !== undefined

  if (isReplace) {
    if (!before.exists) {
      throw new SocratesError("file_not_found", "Replace edit target does not exist", { details: { path: input.path } })
    }
    validateFreshness(context, absolutePath, before.contentHash)
    const oldString = input.oldString ?? ""
    const newString = input.newString ?? ""
    const occurrences = before.content?.split(oldString).length ?? 0
    const actualOccurrences = Math.max(occurrences - 1, 0)
    const replaceAll = input.replaceAll ?? false
    if (!replaceAll && actualOccurrences !== 1) {
      throw new SocratesError("replace_occurrence_mismatch", "Replace edit oldString occurrence count did not match", {
        details: { path: input.path, expectedOccurrences: 1, actualOccurrences },
        recoverable: true,
      })
    }
    if (replaceAll && actualOccurrences === 0) {
      throw new SocratesError("replace_occurrence_mismatch", "Replace edit oldString was not found", {
        details: { path: input.path, expectedOccurrences: "all", actualOccurrences: 0 },
        recoverable: true,
      })
    }
    const afterContent = replaceAll ? (before.content ?? "").split(oldString).join(newString) : (before.content ?? "").replace(oldString, newString)
    return writeSingleFile({
      input,
      context,
      dryRun,
      absolutePath,
      relativePath,
      before,
      afterContent,
      operation: "edited",
    })
  }

  const content = input.content ?? ""
  if (before.exists) {
    validateFreshness(context, absolutePath, before.contentHash)
  }
  return writeSingleFile({
    input,
    context,
    dryRun,
    absolutePath,
    relativePath,
    before,
    afterContent: content,
    operation: before.exists ? "overwritten" : "created",
  })
}

const validateFreshness = (
  context: { workspacePath: string; fileFreshness?: FileFreshnessTracker },
  absolutePath: string,
  actualHash: string | undefined,
): void => {
  if (!context.fileFreshness) {
    throw new SocratesError("edit_stale_content", "Read the file before editing it so Socrates can verify freshness.", {
      details: { path: toWorkspaceRelativePath(context.workspacePath, absolutePath), actualHash },
      recoverable: true,
    })
  }
  context.fileFreshness.validate(absolutePath, actualHash, context.workspacePath)
}

const writeSingleFile = async (params: {
  input: EditToolInput
  context: { workspacePath: string; fileFreshness?: FileFreshnessTracker }
  dryRun: boolean
  absolutePath: string
  relativePath: string
  before: FileSnapshot
  afterContent: string
  operation: ChangedFile["operation"]
}): Promise<EditToolOutput> => {
  const state: EditFileState = {
    absolutePath: params.absolutePath,
    relativePath: params.relativePath,
    original: params.before.content ?? "",
    current: params.afterContent,
    before: params.before,
    existedAtStart: params.before.exists,
    existsNow: true,
    operation: params.operation,
  }

  const changedFile: ChangedFile = {
    path: state.relativePath,
    operation: state.operation,
    verification: params.dryRun ? undefined : "verified",
    contentHashBefore: state.before.contentHash,
    sizeBytesBefore: state.before.sizeBytes,
  }

  if (!params.dryRun) {
    const expectedHash = hashText(state.current)
    safeWriteTextFile(state.absolutePath, state.current, state.before)
    editTestHooks.afterWrite?.(state.absolutePath)
    const after = readFileSnapshot(state.absolutePath, { includeText: true })
    verifyWrittenFile(state, after, expectedHash)
    params.context.fileFreshness?.record(state.absolutePath, after.contentHash, params.context.workspacePath)
    changedFile.verification = "verified"
    changedFile.contentHashAfter = after.contentHash
    changedFile.sizeBytesAfter = after.sizeBytes
    changedFile.lineDelta = countLines(state.current) - countLines(state.original)
  }

  const diff = createUnifiedDiff(state.relativePath, state.original, state.current)
  const truncated = truncateText(diff, clampCharLimit(), 0)
  return {
    changedFiles: [changedFile],
    diff: truncated.text,
    dryRun: params.dryRun,
    truncation: truncated.truncation,
  }
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
