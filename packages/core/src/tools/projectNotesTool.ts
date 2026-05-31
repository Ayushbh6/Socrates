import { projectNotesToolInputSchema, projectNotesToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const projectNotesTool: SocratesTool<typeof projectNotesToolInputSchema._type, typeof projectNotesToolOutputSchema._type> = {
  name: "project_notes",
  description:
    "Read, search, or patch the active workspace's .socrates/PROJECT_NOTES.md file. Patch is a constrained oldText/newText replacement against that one file only; use it for repo-local Socrates notes, not arbitrary source edits.",
  inputSchema: projectNotesToolInputSchema,
  resultSchema: projectNotesToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "file",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.project_notes(input, context),
  summary: (output) =>
    output.operation === "patch"
      ? `${output.changed ? "Updated" : "Did not change"} PROJECT_NOTES.md.`
      : output.operation === "search"
        ? `Found ${output.matches?.length ?? 0} PROJECT_NOTES.md match(es).`
        : "Read PROJECT_NOTES.md.",
  resultPreview: (output) => output.content ?? output.matches?.map((match) => `${match.line}: ${match.text}`).join("\n") ?? "",
  metrics: (output) => ({ filesRead: output.operation === "patch" ? 0 : 1, filesEdited: output.changed ? 1 : 0 }),
}
