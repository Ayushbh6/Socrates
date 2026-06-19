import { projectDocsToolInputSchema, projectDocsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const projectDocsTool: SocratesTool<typeof projectDocsToolInputSchema._type, typeof projectDocsToolOutputSchema._type> = {
  name: "project_docs",
  description:
    'Read, search, index, or edit workspace-local project docs under .socrates. area="memory" targets MEMORY.md for durable project state; area="notes" targets PROJECT_NOTES.md for active working notes, the state ledger, and protected backend-owned runtime_context. Outputs include system runtime date/time metadata. Prefer operation="read_index" first, then "read_section" or "patch_section" by sectionId for focused recall and edits. Whole-doc read/search remains available as fallback. Generic edit/apply_patch cannot mutate these files.',
  inputSchema: projectDocsToolInputSchema,
  resultSchema: projectDocsToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "file",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.project_docs(input, context),
  summary: (output) =>
    output.operation === "edit" || output.operation === "patch_section"
      ? `${output.changed ? "Updated" : "Did not change"} ${output.area} project doc.`
      : output.operation === "search"
        ? `Found ${output.matches?.length ?? 0} ${output.area} project-doc match(es).`
        : output.operation === "read_index"
          ? `Read ${output.area} project-doc section index.`
          : output.operation === "read_section"
            ? `Read ${output.area} project-doc section ${output.section?.sectionId ?? ""}.`
        : `Read ${output.area} project doc.`,
  resultPreview: (output) => output.content ?? output.matches?.map((match) => `${match.line}: ${match.text}`).join("\n") ?? "",
  metrics: (output) => ({ filesRead: output.operation === "edit" ? 0 : 1, filesEdited: output.changed ? 1 : 0 }),
}
