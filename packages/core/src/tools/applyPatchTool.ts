import { applyPatchToolInputSchema, applyPatchToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

const previewPatch = (input: typeof applyPatchToolInputSchema._type): string => {
  const lines = input.patch.split("\n").filter(Boolean).slice(0, 3)
  return lines.length > 0 ? `patch:\n${lines.join("\n")}` : "patch: workspace"
}

const decidePatchPolicy: SocratesTool<typeof applyPatchToolInputSchema._type, typeof applyPatchToolOutputSchema._type>["decidePolicy"] =
  async (input, context) => {
    if (context.runtimeConfig.sandboxMode === "read_only" || context.runtimeConfig.approvalMode === "read_only_auto") {
      return { type: "denied", reason: "Patch application is not allowed in read-only mode." }
    }

    if (context.runtimeConfig.sandboxMode === "danger_full_access" || context.runtimeConfig.approvalMode === "approve_all") {
      return { type: "auto" }
    }

    const preview = await context.executors.apply_patch({ ...input, dryRun: true }, context)

    return {
      type: "approval_required",
      request: {
        actionKind: "patch_apply",
        title: "Approve patch",
        description: "Socrates wants to apply a unified diff patch in the active project workspace.",
        actionPreview: preview.diff.trim().length > 0 ? preview.diff : previewPatch(input),
        risk: "medium",
      },
    }
  }

export const applyPatchTool: SocratesTool<typeof applyPatchToolInputSchema._type, typeof applyPatchToolOutputSchema._type> = {
  name: "apply_patch",
  description:
    "Apply a unified diff patch to one or more files in the active project workspace using git apply. Use for multi-hunk or multi-file changes. Read affected files first when exact context matters.",
  inputSchema: applyPatchToolInputSchema,
  resultSchema: applyPatchToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "patch",
  decidePolicy: decidePatchPolicy,
  execute: (input, context) => context.executors.apply_patch(input, context),
  summary: (output) => {
    const paths = Array.from(new Set(output.changedFiles.map((file) => file.path)))
    if (paths.length === 1) {
      const onlyPath = paths[0]
      return onlyPath ? `Patched ${basename(onlyPath)}.` : "Patched files."
    }
    return `Patched ${paths.length} files.`
  },
  resultPreview: (output) => output.diff,
  metrics: (output) => ({ filesEdited: output.changedFiles.length }),
}

const basename = (path: string): string => path.split(/[\\/]/).pop() ?? path
