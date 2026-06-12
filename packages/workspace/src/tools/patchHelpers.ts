import { spawn } from "node:child_process"
import type { ApplyPatchToolInput, EditToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import {
  assertNotProjectNotesMutation,
  assertNotProjectSkillsMutation,
  assertNotRepoDocsMutation,
  clampCharLimit,
  isSensitivePath,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
  truncateText,
} from "./common"
import type { FileFreshnessTracker } from "./fileFreshness"
import { readFileSnapshot, type FileSnapshot } from "./fileMetadata"
import { withWorkspaceMutationLock } from "./mutationLock"

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
  sawOldHeader?: boolean
  sawNewHeader?: boolean
  renameFrom?: string
  renameTo?: string
}

type PreparedPatch = {
  patch: string
  sourceFormat: "unified" | "structured"
  warnings: string[]
}

type StructuredPatchOperation =
  | { kind: "add"; path: string; content: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; movePath?: string; chunks: StructuredPatchChunk[] }

type StructuredPatchChunk = {
  oldLines: string[]
  newLines: string[]
  context?: string
  eof?: boolean
  lineNumber: number
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
  context: { workspacePath: string; fileFreshness?: FileFreshnessTracker },
): Promise<EditToolOutput> => withWorkspaceMutationLock(context.workspacePath, () => applyPatchWorkspaceLocked(input, context))

const applyPatchWorkspaceLocked = async (
  input: ApplyPatchToolInput,
  context: { workspacePath: string; fileFreshness?: FileFreshnessTracker },
): Promise<EditToolOutput> => {
  const dryRun = input.dryRun ?? false
  const prepared = preparePatch(patchTextFromInput(input), context.workspacePath)
  const changes = parsePatchFileChanges(prepared.patch)
  validatePatch(changes, context.workspacePath)
  const beforeSnapshots = collectPatchSnapshots(changes, context.workspacePath)
  validatePatchFreshness(changes, beforeSnapshots, context)
  const verificationByPath = new Map<string, PatchVerificationRecord>()

  if (!dryRun) {
    await applyPatch(context.workspacePath, prepared.patch)
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
  const truncated = truncateText(prepared.patch, clampCharLimit(), 0)
  const warnings = [
    ...(prepared.sourceFormat === "structured" ? ["Accepted structured apply_patch format and applied it as a verified unified diff."] : []),
    ...prepared.warnings,
  ]
  return {
    changedFiles,
    diff: truncated.text,
    dryRun,
    truncation: truncated.truncation,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

const patchTextFromInput = (input: ApplyPatchToolInput): string => {
  const withLegacyAlias = input as ApplyPatchToolInput & { patchText?: string }
  return input.patch ?? withLegacyAlias.patchText ?? ""
}

const preparePatch = (patchText: string, workspacePath: string): PreparedPatch => {
  const patch = normalizePatchText(stripOuterCodeFence(patchText))
  if (isStructuredPatch(patch)) {
    const structured = structuredPatchToUnifiedDiff(patch, workspacePath)
    return { patch: structured.patch, sourceFormat: "structured", warnings: structured.warnings }
  }
  validateUnifiedPatchSyntax(patch)
  return { patch, sourceFormat: "unified", warnings: [] }
}

const stripOuterCodeFence = (patchText: string): string => {
  const trimmed = patchText.trim()
  const match = /^```(?:diff|patch)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  return stripHeredoc(match?.[1] ?? patchText)
}

const stripHeredoc = (patchText: string): string => {
  const trimmed = patchText.trim()
  const match = /^(?:cat\s+)?<<['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\n([\s\S]*?)\n\1\s*$/.exec(trimmed)
  return match?.[2] ?? patchText
}

const normalizePatchText = (patchText: string): string => patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n")

const isStructuredPatch = (patchText: string): boolean => patchText.trimStart().startsWith("*** Begin Patch")

const structuredPatchToUnifiedDiff = (patchText: string, workspacePath: string): { patch: string; warnings: string[] } => {
  const parsed = parseStructuredPatch(patchText)
  const operations = parsed.operations
  validateStructuredPatchPaths(operations, workspacePath)
  const patches = operations
    .map((operation) => structuredOperationToUnifiedDiff(operation, workspacePath))
    .filter((patch) => patch.trim().length > 0)

  if (patches.length === 0) {
    throw new SocratesError("patch_parse_failed", "Patch did not contain any file changes.", {
      recoverable: true,
      details: { suggestion: "Add at least one Add File, Update File, Delete File, or Move to operation." },
    })
  }

  return { patch: `${patches.join("\n")}\n`, warnings: parsed.warnings }
}

const parseStructuredPatch = (patchText: string): { operations: StructuredPatchOperation[]; warnings: string[] } => {
  const lines = patchText.split("\n")
  const beginIndex = lines.findIndex((line) => line.trim() === "*** Begin Patch")
  const endIndex = lines.findIndex((line, index) => index > beginIndex && line.trim() === "*** End Patch")

  if (beginIndex < 0 || endIndex < 0 || beginIndex >= endIndex) {
    throw new SocratesError(
      "patch_parse_failed",
      "Structured patch format requires *** Begin Patch and *** End Patch markers.",
      {
        recoverable: true,
        details: {
          suggestion:
            "Use either a normal unified diff, or wrap structured edits with *** Begin Patch and *** End Patch.",
        },
      },
    )
  }

  const operations: StructuredPatchOperation[] = []
  const warnings: string[] = []
  let index = beginIndex + 1
  while (index < endIndex) {
    const line = lines[index] ?? ""
    const lineNumber = index + 1
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    if (line.startsWith("*** Add File:")) {
      const path = requireStructuredPath(line, "*** Add File:", lineNumber)
      const parsed = parseStructuredAdd(lines, index + 1, endIndex, path, warnings)
      operations.push({ kind: "add", path, content: parsed.content })
      index = parsed.nextIndex
      continue
    }
    if (line.startsWith("*** Delete File:")) {
      const path = requireStructuredPath(line, "*** Delete File:", lineNumber)
      const nextIndex = skipStructuredSectionBody(lines, index + 1, endIndex, "*** Delete File", lineNumber)
      operations.push({ kind: "delete", path })
      index = nextIndex
      continue
    }
    if (line.startsWith("*** Update File:")) {
      const path = requireStructuredPath(line, "*** Update File:", lineNumber)
      const parsed = parseStructuredUpdate(lines, index + 1, endIndex, path, warnings)
      operations.push({ kind: "update", path, ...(parsed.movePath ? { movePath: parsed.movePath } : {}), chunks: parsed.chunks })
      index = parsed.nextIndex
      continue
    }

    throw new SocratesError("patch_parse_failed", `Unexpected structured patch line ${lineNumber}: ${line}`, {
      recoverable: true,
      details: {
        line: lineNumber,
        suggestion:
          "Start each file section with *** Add File: <path>, *** Update File: <path>, or *** Delete File: <path>.",
      },
    })
  }

  return { operations, warnings }
}

const requireStructuredPath = (line: string, prefix: string, lineNumber: number): string => {
  const path = line.slice(prefix.length).trim()
  if (!path) {
    throw new SocratesError("patch_parse_failed", `Structured patch line ${lineNumber} is missing a path.`, {
      recoverable: true,
      details: { line: lineNumber, suggestion: `${prefix} must be followed by a workspace-relative path.` },
    })
  }
  return path
}

const parseStructuredAdd = (
  lines: string[],
  startIndex: number,
  endIndex: number,
  filePath: string,
  warnings: string[],
): { content: string; nextIndex: number } => {
  const contentLines: string[] = []
  let index = startIndex
  while (index < endIndex && !isStructuredSectionBoundary(lines[index] ?? "")) {
    const line = lines[index] ?? ""
    if (line.startsWith("+")) {
      contentLines.push(line.slice(1))
    } else {
      addPatchWarning(
        warnings,
        `Normalized Add File line ${index + 1} in ${filePath}: content lines should start with +; Socrates treated the line as added content.`,
      )
      contentLines.push(line)
    }
    index += 1
  }
  return { content: contentLines.length === 0 ? "" : `${contentLines.join("\n")}\n`, nextIndex: index }
}

const skipStructuredSectionBody = (
  lines: string[],
  startIndex: number,
  endIndex: number,
  sectionName: string,
  sectionLine: number,
): number => {
  let index = startIndex
  while (index < endIndex && !isStructuredSectionBoundary(lines[index] ?? "")) {
    const line = lines[index] ?? ""
    if (line.trim().length > 0) {
      throw new SocratesError("patch_parse_failed", `${sectionName} at line ${sectionLine} must not include hunk lines.`, {
        recoverable: true,
        details: {
          line: index + 1,
          suggestion: "For deletions, use only *** Delete File: <path>. Put changes in a separate Update File section.",
        },
      })
    }
    index += 1
  }
  return index
}

const parseStructuredUpdate = (
  lines: string[],
  startIndex: number,
  endIndex: number,
  filePath: string,
  warnings: string[],
): { movePath?: string; chunks: StructuredPatchChunk[]; nextIndex: number } => {
  let index = startIndex
  let movePath: string | undefined
  if (index < endIndex && (lines[index] ?? "").startsWith("*** Move to:")) {
    movePath = requireStructuredPath(lines[index] ?? "", "*** Move to:", index + 1)
    index += 1
  }

  const chunks: StructuredPatchChunk[] = []
  while (index < endIndex && !isStructuredSectionBoundary(lines[index] ?? "")) {
    const line = lines[index] ?? ""
    if (line.trim().length === 0) {
      index += 1
      continue
    }
    if (!line.startsWith("@@")) {
      addPatchWarning(warnings, `Normalized Update File section for ${filePath}: inserted an implicit @@ hunk before line ${index + 1}.`)
      const parsed = parseStructuredUpdateChunkBody(lines, index, endIndex, filePath, index + 1, undefined, warnings)
      chunks.push(parsed.chunk)
      index = parsed.nextIndex
      continue
    }

    const parsed = parseStructuredUpdateChunk(lines, index, endIndex, filePath, warnings)
    chunks.push(parsed.chunk)
    index = parsed.nextIndex
  }

  if (!movePath && chunks.length === 0) {
    throw new SocratesError("patch_parse_failed", `Update File section for ${filePath} has no hunks.`, {
      recoverable: true,
      details: { path: filePath, suggestion: "Add at least one @@ hunk, or use *** Delete File / *** Add File instead." },
    })
  }

  return { ...(movePath ? { movePath } : {}), chunks, nextIndex: index }
}

const parseStructuredUpdateChunk = (
  lines: string[],
  headerIndex: number,
  endIndex: number,
  filePath: string,
  warnings: string[],
): { chunk: StructuredPatchChunk; nextIndex: number } => {
  const header = lines[headerIndex] ?? ""
  return parseStructuredUpdateChunkBody(lines, headerIndex + 1, endIndex, filePath, headerIndex + 1, parseStructuredChunkContext(header), warnings)
}

const parseStructuredUpdateChunkBody = (
  lines: string[],
  startIndex: number,
  endIndex: number,
  filePath: string,
  lineNumber: number,
  context: string | undefined,
  warnings: string[],
): { chunk: StructuredPatchChunk; nextIndex: number } => {
  const oldLines: string[] = []
  const newLines: string[] = []
  let eof = false
  let index = startIndex

  while (index < endIndex && !isStructuredSectionBoundary(lines[index] ?? "") && !(lines[index] ?? "").startsWith("@@")) {
    const line = lines[index] ?? ""
    if (line === "*** End of File") {
      eof = true
      index += 1
      break
    }
    if (line.startsWith(" ")) {
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1))
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1))
    } else if (line.startsWith("\\")) {
      // Accept standard no-newline notes in generated patches.
    } else {
      addPatchWarning(
        warnings,
        line.length === 0
          ? `Normalized blank context line ${index + 1} in ${filePath}: blank context lines should be written as a single leading space.`
          : `Normalized context line ${index + 1} in ${filePath}: unchanged lines inside @@ hunks should start with a leading space.`,
      )
      oldLines.push(line)
      newLines.push(line)
    }
    index += 1
  }

  return {
    chunk: { oldLines, newLines, ...(context ? { context } : {}), ...(eof ? { eof } : {}), lineNumber },
    nextIndex: index,
  }
}

const addPatchWarning = (warnings: string[], warning: string): void => {
  if (!warnings.includes(warning)) {
    warnings.push(warning)
  }
}

const parseStructuredChunkContext = (header: string): string | undefined => {
  const raw = header.slice(2).trim()
  if (!raw || /^-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?(?:\s+@@.*)?$/.test(raw)) {
    return undefined
  }
  return raw
}

const isStructuredSectionBoundary = (line: string): boolean =>
  line.startsWith("*** Add File:") ||
  line.startsWith("*** Delete File:") ||
  line.startsWith("*** Update File:") ||
  line.trim() === "*** End Patch"

const validateStructuredPatchPaths = (operations: StructuredPatchOperation[], workspacePath: string): void => {
  for (const operation of operations) {
    for (const patchPath of structuredOperationPaths(operation)) {
      const absolutePath = resolveWorkspacePath(workspacePath, patchPath)
      assertNotProjectNotesMutation(workspacePath, absolutePath, patchPath)
      assertNotRepoDocsMutation(workspacePath, absolutePath, patchPath)
      assertNotProjectSkillsMutation(workspacePath, absolutePath, patchPath)
      if (isSensitivePath(absolutePath)) {
        throw new SocratesError("sensitive_path_denied", "Editing sensitive credential-like paths is denied in V1.", {
          details: { path: patchPath },
        })
      }
    }
  }
}

const structuredOperationPaths = (operation: StructuredPatchOperation): string[] =>
  operation.kind === "update" && operation.movePath ? [operation.path, operation.movePath] : [operation.path]

const structuredOperationToUnifiedDiff = (operation: StructuredPatchOperation, workspacePath: string): string => {
  if (operation.kind === "add") {
    return createWholeFileUnifiedDiff(undefined, operation.path, "", operation.content)
  }

  if (operation.kind === "delete") {
    const before = readExistingPatchTarget(workspacePath, operation.path)
    return createWholeFileUnifiedDiff(operation.path, undefined, before, "")
  }

  const before = readExistingPatchTarget(workspacePath, operation.path)
  const after = applyStructuredChunks(operation.path, before, operation.chunks)
  if (operation.movePath && before === after) {
    return [
      `diff --git a/${operation.path} b/${operation.movePath}`,
      "similarity index 100%",
      `rename from ${operation.path}`,
      `rename to ${operation.movePath}`,
      "",
    ].join("\n")
  }
  return createWholeFileUnifiedDiff(operation.path, operation.movePath ?? operation.path, before, after, operation.movePath !== undefined)
}

const readExistingPatchTarget = (workspacePath: string, patchPath: string): string => {
  const absolutePath = resolveWorkspacePath(workspacePath, patchPath)
  const snapshot = readFileSnapshot(absolutePath, { includeText: true })
  if (!snapshot.exists) {
    throw new SocratesError("patch_apply_failed", `Patch target does not exist: ${patchPath}`, {
      recoverable: true,
      details: {
        path: patchPath,
        suggestion: "Read the current workspace state and use Add File for new files or Update/Delete only for existing files.",
      },
    })
  }
  return snapshot.content ?? ""
}

const applyStructuredChunks = (filePath: string, before: string, chunks: StructuredPatchChunk[]): string => {
  if (chunks.length === 0) {
    return before
  }

  const originalLines = splitComparableLines(before)
  const replacements: Array<{ start: number; deleteCount: number; lines: string[] }> = []
  let searchFrom = 0

  for (const chunk of chunks) {
    let preferredSearchFrom = searchFrom
    let contextFound = false
    if (chunk.context) {
      const contextIndex = findLineSequence(originalLines, [chunk.context], searchFrom, false)
      if (contextIndex >= 0) {
        preferredSearchFrom = contextIndex + 1
        contextFound = true
      } else if (chunk.oldLines.length === 0) {
        throw new SocratesError("patch_context_mismatch", `Could not find structured patch context in ${filePath}: ${chunk.context}`, {
          recoverable: true,
          details: {
            path: filePath,
            line: chunk.lineNumber,
            expectedContext: chunk.context,
            suggestion:
              "Re-read the file and retry with an exact existing anchor line, or include old lines in the hunk so apply_patch can locate the insertion point.",
          },
        })
      }
    }

    if (chunk.oldLines.length === 0) {
      replacements.push({ start: preferredSearchFrom, deleteCount: 0, lines: chunk.newLines })
      continue
    }

    const found = findStructuredOldLines(originalLines, chunk.oldLines, {
      preferredSearchFrom,
      fallbackSearchFrom: searchFrom,
      eof: chunk.eof ?? false,
    })
    if (found < 0) {
      throw new SocratesError("patch_context_mismatch", `Could not find expected lines for structured patch in ${filePath}.`, {
        recoverable: true,
        details: {
          path: filePath,
          line: chunk.lineNumber,
          ...(chunk.context && !contextFound ? { ignoredContextHint: chunk.context } : {}),
          expectedLines: chunk.oldLines.join("\n"),
          suggestion:
            "Re-read the file and retry with exact current lines. Use the structured *** Begin Patch format rather than unified diff hunk counts.",
        },
      })
    }
    replacements.push({ start: found, deleteCount: chunk.oldLines.length, lines: chunk.newLines })
    searchFrom = found + chunk.oldLines.length
  }

  const nextLines = [...originalLines]
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    nextLines.splice(replacement.start, replacement.deleteCount, ...replacement.lines)
  }
  return `${nextLines.join("\n")}\n`
}

const findStructuredOldLines = (
  lines: string[],
  pattern: string[],
  options: { preferredSearchFrom: number; fallbackSearchFrom: number; eof: boolean },
): number => {
  const preferred = findLineSequence(lines, pattern, options.preferredSearchFrom, options.eof)
  if (preferred >= 0) {
    return preferred
  }
  if (options.fallbackSearchFrom !== options.preferredSearchFrom) {
    const fallback = findLineSequence(lines, pattern, options.fallbackSearchFrom, options.eof)
    if (fallback >= 0) {
      return fallback
    }
  }
  if (options.fallbackSearchFrom !== 0 && options.preferredSearchFrom !== 0) {
    return findLineSequence(lines, pattern, 0, options.eof)
  }
  return -1
}

const splitComparableLines = (content: string): string[] => {
  const lines = content.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines
}

const findLineSequence = (lines: string[], pattern: string[], startIndex: number, eof: boolean): number => {
  if (pattern.length === 0) {
    return -1
  }
  const comparators: Array<(left: string, right: string) => boolean> = [
    (left, right) => left === right,
    (left, right) => left.trimEnd() === right.trimEnd(),
    (left, right) => left.trim() === right.trim(),
    (left, right) => normalizeComparableLine(left.trim()) === normalizeComparableLine(right.trim()),
  ]
  for (const compare of comparators) {
    const found = findLineSequenceWithComparator(lines, pattern, startIndex, eof, compare)
    if (found >= 0) {
      return found
    }
  }
  return -1
}

const findLineSequenceWithComparator = (
  lines: string[],
  pattern: string[],
  startIndex: number,
  eof: boolean,
  compare: (left: string, right: string) => boolean,
): number => {
  if (eof) {
    const fromEnd = lines.length - pattern.length
    if (fromEnd >= startIndex && sequenceMatches(lines, pattern, fromEnd, compare)) {
      return fromEnd
    }
  }
  for (let index = startIndex; index <= lines.length - pattern.length; index += 1) {
    if (sequenceMatches(lines, pattern, index, compare)) {
      return index
    }
  }
  return -1
}

const sequenceMatches = (
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: (left: string, right: string) => boolean,
): boolean => pattern.every((line, offset) => compare(lines[startIndex + offset] ?? "", line))

const normalizeComparableLine = (line: string): string =>
  line
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\u00a0/g, " ")

const createWholeFileUnifiedDiff = (
  oldPath: string | undefined,
  newPath: string | undefined,
  before: string,
  after: string,
  includeRenameHeaders = false,
): string => {
  if (oldPath === newPath && before === after) {
    return ""
  }

  const beforeLines = splitComparableLines(before)
  const afterLines = splitComparableLines(after)
  const oldRange = formatUnifiedRange(beforeLines.length, true)
  const newRange = formatUnifiedRange(afterLines.length, false)
  const diffOldPath = oldPath ?? newPath
  const diffNewPath = newPath ?? oldPath
  const headers =
    includeRenameHeaders && oldPath && newPath
      ? [
          `diff --git a/${oldPath} b/${newPath}`,
          "similarity index 50%",
          `rename from ${oldPath}`,
          `rename to ${newPath}`,
        ]
      : [
          `diff --git a/${diffOldPath} b/${diffNewPath}`,
          ...(oldPath ? [] : ["new file mode 100644"]),
          ...(newPath ? [] : ["deleted file mode 100644"]),
        ]

  return [
    ...headers,
    `--- ${oldPath ? `a/${oldPath}` : "/dev/null"}`,
    `+++ ${newPath ? `b/${newPath}` : "/dev/null"}`,
    `@@ ${oldRange} ${newRange} @@`,
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
    "",
  ].join("\n")
}

const formatUnifiedRange = (lineCount: number, oldFile: boolean): string => {
  if (lineCount === 0) {
    return oldFile ? "-0,0" : "+0,0"
  }
  return `${oldFile ? "-" : "+"}1,${lineCount}`
}

const validateUnifiedPatchSyntax = (patchText: string): void => {
  const lines = patchText.split("\n")
  let sawFileHeader = false
  let sawNewHeader = false
  let activeHunk: {
    lineNumber: number
    header: string
    expectedOld: number
    expectedNew: number
    actualOld: number
    actualNew: number
  } | undefined

  const finishHunk = (nextLineNumber: number): void => {
    if (!activeHunk) {
      return
    }
    if (activeHunk.actualOld !== activeHunk.expectedOld || activeHunk.actualNew !== activeHunk.expectedNew) {
      throw new SocratesError(
        "patch_parse_failed",
        `Unified diff hunk line counts do not match at line ${activeHunk.lineNumber}.`,
        {
          recoverable: true,
          details: {
            line: activeHunk.lineNumber,
            header: activeHunk.header,
            expectedOldLines: activeHunk.expectedOld,
            actualOldLines: activeHunk.actualOld,
            expectedNewLines: activeHunk.expectedNew,
            actualNewLines: activeHunk.actualNew,
            stoppedBeforeLine: nextLineNumber,
            suggestion:
              "Do not retry by guessing unified-diff hunk counts. Retry with patchText using the structured *** Begin Patch / *** Update File format so no hunk counts are needed.",
          },
        },
      )
    }
    activeHunk = undefined
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ""
    const lineNumber = index + 1
    const isFinalEmptyLine = line === "" && index === lines.length - 1

    if (activeHunk) {
      if (isFinalEmptyLine) {
        finishHunk(lineNumber)
        continue
      }
      if (line.startsWith(" ")) {
        activeHunk.actualOld += 1
        activeHunk.actualNew += 1
        continue
      }
      if (line.startsWith("-") && !line.startsWith("--- ")) {
        activeHunk.actualOld += 1
        continue
      }
      if (line.startsWith("+") && !line.startsWith("+++ ")) {
        activeHunk.actualNew += 1
        continue
      }
      if (line.startsWith("\\")) {
        continue
      }
      if (isUnifiedPatchBoundary(line)) {
        finishHunk(lineNumber)
      } else {
        throw new SocratesError("patch_parse_failed", `Invalid unified diff hunk line ${lineNumber}.`, {
          recoverable: true,
          details: {
            line: lineNumber,
            text: line,
            suggestion:
              "Inside unified diff hunks, every body line must start with space, -, or +. Blank context lines must be written as a single leading space.",
          },
        })
      }
    }

    if (line.startsWith("diff --git ")) {
      sawFileHeader = false
      sawNewHeader = false
      continue
    }
    if (line.startsWith("--- ")) {
      sawFileHeader = true
      sawNewHeader = false
      continue
    }
    if (line.startsWith("+++ ")) {
      if (!sawFileHeader) {
        throw new SocratesError("patch_parse_failed", `Unified diff +++ header at line ${lineNumber} has no preceding --- header.`, {
          recoverable: true,
          details: { line: lineNumber, suggestion: "Each file patch must include --- old/path before +++ new/path." },
        })
      }
      sawNewHeader = true
      continue
    }
    if (line.startsWith("@@")) {
      if (!sawFileHeader || !sawNewHeader) {
        throw new SocratesError("patch_parse_failed", `Unified diff hunk at line ${lineNumber} has no complete file header.`, {
          recoverable: true,
          details: {
            line: lineNumber,
            suggestion: "Put --- a/path and +++ b/path before @@ hunks, or use structured *** Update File format.",
          },
        })
      }
      const parsed = parseUnifiedHunkHeader(line, lineNumber)
      activeHunk = { ...parsed, actualOld: 0, actualNew: 0 }
    }
  }

  finishHunk(lines.length + 1)
}

const parseUnifiedHunkHeader = (
  header: string,
  lineNumber: number,
): { lineNumber: number; header: string; expectedOld: number; expectedNew: number } => {
  const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(header)
  if (!match) {
    throw new SocratesError("patch_parse_failed", `Invalid unified diff hunk header at line ${lineNumber}.`, {
      recoverable: true,
      details: {
        line: lineNumber,
        header,
        suggestion: "Use a hunk header like @@ -12,3 +12,4 @@, or use structured *** Update File format.",
      },
    })
  }
  return {
    lineNumber,
    header,
    expectedOld: match[1] === undefined ? 1 : Number(match[1]),
    expectedNew: match[2] === undefined ? 1 : Number(match[2]),
  }
}

const isUnifiedPatchBoundary = (line: string): boolean =>
  line.startsWith("diff --git ") ||
  line.startsWith("--- ") ||
  line.startsWith("+++ ") ||
  line.startsWith("@@") ||
  line.startsWith("rename from ") ||
  line.startsWith("rename to ") ||
  line.startsWith("similarity index ") ||
  line.startsWith("new file mode ") ||
  line.startsWith("deleted file mode ") ||
  line.startsWith("index ")

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
      assertNotProjectNotesMutation(workspacePath, absolutePath, patchPath)
      assertNotRepoDocsMutation(workspacePath, absolutePath, patchPath)
      assertNotProjectSkillsMutation(workspacePath, absolutePath, patchPath)
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

export const pathsFromPatch = (patchText: string): string[] => {
  const normalized = normalizePatchText(stripOuterCodeFence(patchText))
  if (isStructuredPatch(normalized)) {
    return parseStructuredPatch(normalized).operations.flatMap((operation) =>
      operation.kind === "update" && operation.movePath ? [operation.path, operation.movePath] : [operation.path],
    )
  }
  return parsePatchFileChanges(normalized).map((change) => change.path)
}

const validatePatchFreshness = (
  changes: PatchFileChange[],
  beforeSnapshots: Map<string, FileSnapshot>,
  context: { workspacePath: string; fileFreshness?: FileFreshnessTracker },
): void => {
  for (const change of changes) {
    for (const patchPath of freshnessRequiredPaths(change)) {
      const absolutePath = resolveWorkspacePath(context.workspacePath, patchPath)
      const relativePath = toWorkspaceRelativePath(context.workspacePath, absolutePath)
      const before = beforeSnapshots.get(relativePath) ?? readFileSnapshot(absolutePath, { includeText: false })
      if (!before.exists) {
        continue
      }
      validateFreshness(context, absolutePath, before.contentHash)
    }
  }
}

const freshnessRequiredPaths = (change: PatchFileChange): string[] => {
  if (change.operation === "created") {
    return []
  }
  if (change.operation === "deleted") {
    return [change.oldPath ?? change.path]
  }
  if (change.operation === "renamed") {
    return [change.previousPath ?? change.oldPath ?? change.path]
  }
  return [change.path]
}

const validateFreshness = (
  context: { workspacePath: string; fileFreshness?: FileFreshnessTracker },
  absolutePath: string,
  actualHash: string | undefined,
): void => {
  if (!context.fileFreshness) {
    throw new SocratesError("edit_stale_content", "Read the file before applying a patch so Socrates can verify freshness.", {
      details: { path: toWorkspaceRelativePath(context.workspacePath, absolutePath), actualHash },
      recoverable: true,
    })
  }
  context.fileFreshness.validate(absolutePath, actualHash, context.workspacePath)
}

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
      if (section.sawOldHeader || section.sawNewHeader) {
        flush()
      }
      hasSection = true
      section.sawOldHeader = true
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
      section.sawNewHeader = true
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
        reject(createPatchApplyError(stderr, code))
      }
    })
    child.stdin.end(patchText)
  })

const createPatchApplyError = (stderr: string, code: number | null): SocratesError => {
  const corruptLine = /corrupt patch at line (\d+)/i.exec(stderr)?.[1]
  if (corruptLine) {
    return new SocratesError("patch_parse_failed", `Unified diff is corrupt near line ${corruptLine}.`, {
      recoverable: true,
      details: {
        stderr,
        code,
        line: Number(corruptLine),
        suggestion:
          "Do not retry by guessing unified-diff hunk counts. Retry with patchText using the structured *** Begin Patch / *** Update File format so no hunk counts are needed.",
      },
    })
  }

  const failedPatch = /error: patch failed: ([^:\n]+):(\d+)/i.exec(stderr)
  const doesNotApply = /error: ([^:\n]+): patch does not apply/i.exec(stderr)
  if (failedPatch || doesNotApply) {
    const path = failedPatch?.[1] ?? doesNotApply?.[1]
    const line = failedPatch?.[2] ? Number(failedPatch[2]) : undefined
    return new SocratesError("patch_apply_failed", `Patch context did not match current disk${path ? ` for ${path}` : ""}.`, {
      recoverable: true,
      details: {
        stderr,
        code,
        ...(path ? { path } : {}),
        ...(line ? { line } : {}),
        suggestion:
          "Re-read the affected file and retry using exact current context. For localized single-file edits, edit oldString/newString is usually simpler.",
      },
    })
  }

  if (/No valid patches in input/i.test(stderr)) {
    return new SocratesError("patch_parse_failed", "Patch input did not contain a valid file patch.", {
      recoverable: true,
      details: {
        stderr,
        code,
        suggestion:
          "Provide either a standard unified diff with ---/+++/@@ headers, or the structured format starting with *** Begin Patch.",
      },
    })
  }

  return new SocratesError("patch_apply_failed", "Patch could not be applied.", {
    recoverable: true,
    details: {
      stderr,
      code,
      suggestion: "Re-read the affected files and retry with current context.",
    },
  })
}

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
