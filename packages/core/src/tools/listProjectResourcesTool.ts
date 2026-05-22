import { listProjectResourcesToolInputSchema, listProjectResourcesToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const listProjectResourcesTool: SocratesTool<
  typeof listProjectResourcesToolInputSchema._type,
  typeof listProjectResourcesToolOutputSchema._type
> = {
  name: "list_project_resources",
  description:
    "List active project resources known to Socrates, especially uploaded files stored under .socrates/resources. Optional inputs: kind and limit. Use this before shell directory probing when the user asks about uploaded project files.",
  inputSchema: listProjectResourcesToolInputSchema,
  resultSchema: listProjectResourcesToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "file",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.list_project_resources(input, context),
  summary: (output) => output.summary,
  resultPreview: (output) =>
    output.resources
      .map((resource) => `${resource.name} (${resource.kind}, ${resource.source})${resource.uri ? ` - ${resource.uri}` : ""}`)
      .join("\n"),
  metrics: (output) => ({ filesRead: output.resources.length }),
}
