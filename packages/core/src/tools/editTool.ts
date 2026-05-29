import { editToolInputSchema, editToolModelInputSchema, editToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

const previewEdit = (input: typeof editToolInputSchema._type): string => {
  if (input.content !== undefined) {
    return `write: ${input.path}`
  }
  return `replace: ${input.path}`
}

const decideEditPolicy: SocratesTool<typeof editToolInputSchema._type, typeof editToolOutputSchema._type>["decidePolicy"] = async (
  input,
  context,
) => {
  if (context.runtimeConfig.sandboxMode === "read_only" || context.runtimeConfig.approvalMode === "read_only_auto") {
    return { type: "denied", reason: "File edits are not allowed in read-only mode." }
  }

  if (context.runtimeConfig.sandboxMode === "danger_full_access" || context.runtimeConfig.approvalMode === "approve_all") {
    return { type: "auto" }
  }

  const preview = await context.executors.edit({ ...input, dryRun: true }, context)

  return {
    type: "approval_required",
    request: {
      actionKind: "file_write",
      title: "Approve file edit",
      description: "Socrates wants to modify files in the active project workspace.",
      actionPreview: preview.diff.trim().length > 0 ? preview.diff : previewEdit(input),
      risk: "medium",
    },
  }
}

export const editTool: SocratesTool<typeof editToolInputSchema._type, typeof editToolOutputSchema._type> = {
  name: "edit",
  description:
    "Create or modify a file in the active project workspace. Use content for a whole-file write (create or overwrite). Use oldString and newString for a targeted multiline replace; set replaceAll to change every occurrence. Read the file first when overwriting or replacing so Socrates can verify freshness.",
  inputSchema: editToolInputSchema,
  modelInputSchema: editToolModelInputSchema,
  resultSchema: editToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "patch",
  decidePolicy: decideEditPolicy,
  execute: (input, context) => context.executors.edit(input, context),
  summary: (output) => summarizeEditOutput(output),
  resultPreview: (output) => output.diff,
  metrics: (output) => ({ filesEdited: output.changedFiles.length }),
}

const summarizeEditOutput = (output: typeof editToolOutputSchema._type): string => {
  const paths = Array.from(new Set(output.changedFiles.map((file) => file.path)))
  const verb = output.dryRun ? "Prepared" : "Edited"
  const onlyPath = paths[0]
  if (paths.length === 1 && onlyPath) {
    return `${verb} ${basename(onlyPath)}.`
  }
  return `${verb} ${paths.length} files.`
}

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path
