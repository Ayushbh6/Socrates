import { projectDocsToolInputSchema, projectDocsToolModelInputSchema, projectDocsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const projectDocsTool: SocratesTool<typeof projectDocsToolInputSchema._type, typeof projectDocsToolOutputSchema._type> = {
  name: "project_docs",
  description:
    'Read, search, index, or edit workspace-local project docs under .socrates. area="memory" targets MEMORY.md; area="notes" targets PROJECT_NOTES.md, the state ledger, and protected backend-owned runtime_context. Prefer operation="read_index" first, then "read_section" or "patch_section" by sectionId. For patch_section, provide sectionId plus exact oldText and newText; do not pass text. For append, use operation="edit", editMode="append", and text. Generic edit/apply_patch cannot mutate these files.',
  inputSchema: projectDocsToolInputSchema,
  modelInputSchema: projectDocsToolModelInputSchema,
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
