import { editToolInputSchema, editToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool, ToolPolicyDecision } from "./types"

const previewEdit = (input: typeof editToolInputSchema._type): string =>
  input.operations
    .map((operation) => {
      if (operation.type === "patch") {
        return operation.patch
      }
      return `${operation.type}: ${operation.path}`
    })
    .join("\n")

const decideEditPolicy: SocratesTool<typeof editToolInputSchema._type, typeof editToolOutputSchema._type>["decidePolicy"] = (
  input,
  context,
): ToolPolicyDecision => {
  if (context.runtimeConfig.sandboxMode === "read_only" || context.runtimeConfig.approvalMode === "read_only_auto") {
    return { type: "denied", reason: "File edits are not allowed in read-only mode." }
  }

  if (context.runtimeConfig.sandboxMode === "danger_full_access" || context.runtimeConfig.approvalMode === "approve_all") {
    return { type: "auto" }
  }

  return {
    type: "approval_required",
    request: {
      actionKind: input.operations.some((operation) => operation.type === "patch") ? "patch_apply" : "file_write",
      title: "Approve file edit",
      description: "Socrates wants to modify files in the active project workspace.",
      actionPreview: previewEdit(input),
      risk: "medium",
    },
  }
}

export const editTool: SocratesTool<typeof editToolInputSchema._type, typeof editToolOutputSchema._type> = {
  name: "edit",
  description:
    "Create, overwrite, precisely replace multiline text, or apply a patch in the active project workspace. Use this as the default way to deliver generated scripts, programs, and implementation changes. Use exact oldText for replacements.",
  inputSchema: editToolInputSchema,
  resultSchema: editToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "patch",
  decidePolicy: decideEditPolicy,
  execute: (input, context) => context.executors.edit(input, context),
  summary: (output) => `${output.dryRun ? "Prepared" : "Applied"} edits to ${output.changedFiles.length} file(s).`,
  resultPreview: (output) => output.diff,
  metrics: (output) => ({ filesEdited: output.changedFiles.length }),
}
