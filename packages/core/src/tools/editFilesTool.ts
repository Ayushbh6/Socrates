import { editFilesToolInputSchema, editFilesToolOutputSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const editFilesTool: SocratesTool<typeof editFilesToolInputSchema._type, typeof editFilesToolOutputSchema._type> = {
  name: "edit_files",
  description:
    'Write global memory-agent targets through scoped names only. target is "identity", "operating_principles", "tool_doc", or "skill"; name is required for tool_doc and skill. No arbitrary filesystem paths are accepted.',
  inputSchema: editFilesToolInputSchema,
  resultSchema: editFilesToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "file",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => {
    if (!context.executors.edit_files) {
      throw new SocratesError("edit_files_tool_unavailable", "edit_files is not available in this runtime.", { recoverable: true })
    }
    return context.executors.edit_files(input, context)
  },
  summary: (output) => `${output.status} ${output.target}${output.name ? `/${output.name}` : ""}.`,
  resultPreview: (output) => output.diff ?? `${output.status}: ${output.path}`,
  metrics: (output) => ({ filesEdited: output.changed ? 1 : 0 }),
}
