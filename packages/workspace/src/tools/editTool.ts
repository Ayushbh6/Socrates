import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import type { EditOperation, EditToolInput, EditToolOutput } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { clampCharLimit, ensureParentDirectory, isSensitivePath, resolveWorkspacePath, toWorkspaceRelativePath, truncateText } from "./common"

export const editWorkspace = async (input: EditToolInput, context: { workspacePath: string }): Promise<EditToolOutput> => {
  const dryRun = input.dryRun ?? false
  const planned: Array<{ operation: EditOperation; path?: string; absolutePath?: string; before?: string; after?: string }> = []
  const changedFiles: EditToolOutput["changedFiles"] = []
  const diffs: string[] = []

  for (const operation of input.operations) {
    if (operation.type === "patch") {
      validatePatch(operation.patch, context.workspacePath)
      diffs.push(operation.patch)
      planned.push({ operation })
      changedFiles.push(...pathsFromPatch(operation.patch).map((patchPath) => ({ path: patchPath, operation: "patched" as const })))
      continue
    }

    const absolutePath = resolveWorkspacePath(context.workspacePath, operation.path)
    if (isSensitivePath(absolutePath)) {
      throw new SocratesError("sensitive_path_denied", "Editing sensitive credential-like paths is denied in V1.", {
        details: { path: operation.path },
      })
    }
    const relativePath = toWorkspaceRelativePath(context.workspacePath, absolutePath)
    const exists = fs.existsSync(absolutePath)
    const before = exists ? fs.readFileSync(absolutePath, "utf8") : ""
    let after: string
    let changedOperation: EditToolOutput["changedFiles"][number]["operation"]

    if (operation.type === "create") {
      if (exists) {
        throw new SocratesError("file_already_exists", "Create edit cannot overwrite an existing file", { details: { path: operation.path } })
      }
      after = operation.content
      changedOperation = "created"
    } else if (operation.type === "overwrite") {
      after = operation.content
      changedOperation = exists ? "overwritten" : "created"
    } else {
      if (!exists) {
        throw new SocratesError("file_not_found", "Replace edit target does not exist", { details: { path: operation.path } })
      }
      const occurrences = before.split(operation.oldText).length - 1
      const expected = operation.expectedOccurrences ?? 1
      if (occurrences !== expected) {
        throw new SocratesError("replace_occurrence_mismatch", "Replace edit oldText occurrence count did not match", {
          details: { path: operation.path, expectedOccurrences: expected, actualOccurrences: occurrences },
        })
      }
      after = before.split(operation.oldText).join(operation.newText)
      changedOperation = "edited"
    }

    planned.push({ operation, path: relativePath, absolutePath, before, after })
    changedFiles.push({ path: relativePath, operation: changedOperation })
    diffs.push(createSimpleDiff(relativePath, before, after))
  }

  if (!dryRun) {
    for (const item of planned) {
      if (item.operation.type === "patch") {
        await applyPatch(context.workspacePath, item.operation.patch)
        continue
      }
      if (!item.absolutePath || item.after === undefined) {
        continue
      }
      ensureParentDirectory(item.absolutePath)
      fs.writeFileSync(item.absolutePath, item.after)
    }
  }

  const diffText = diffs.join("\n")
  const truncated = truncateText(diffText, clampCharLimit(), 0)
  return {
    changedFiles,
    diff: truncated.text,
    dryRun,
    truncation: truncated.truncation,
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

const createSimpleDiff = (relativePath: string, before: string, after: string): string => {
  const beforeLines = before.split("\n")
  const afterLines = after.split("\n")
  return [
    `--- a/${relativePath}`,
    `+++ b/${relativePath}`,
    "@@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n")
}
