import { projectDocsToolInputSchema, projectDocsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const projectDocsTool: SocratesTool<typeof projectDocsToolInputSchema._type, typeof projectDocsToolOutputSchema._type> = {
  name: "project_docs",
  description:
    'Read, search, or edit workspace-local project docs under .socrates. area="memory" targets MEMORY.md for durable project state; area="notes" targets PROJECT_NOTES.md for active working notes and the state ledger. Before bash/edit/apply_patch, read/search notes; after successful bash/edit/apply_patch, read/search memory before final. Edit is constrained by editMode append or replace.',
  inputSchema: projectDocsToolInputSchema,
  resultSchema: projectDocsToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "file",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.project_docs(input, context),
  summary: (output) =>
    output.operation === "edit"
      ? `${output.changed ? "Updated" : "Did not change"} ${output.area} project doc.`
      : output.operation === "search"
        ? `Found ${output.matches?.length ?? 0} ${output.area} project-doc match(es).`
        : `Read ${output.area} project doc.`,
  resultPreview: (output) => output.content ?? output.matches?.map((match) => `${match.line}: ${match.text}`).join("\n") ?? "",
  metrics: (output) => ({ filesRead: output.operation === "edit" ? 0 : 1, filesEdited: output.changed ? 1 : 0 }),
}
