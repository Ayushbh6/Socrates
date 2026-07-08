import { memoryNotesToolInputSchema, memoryNotesToolOutputSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const memoryNotesTool: SocratesTool<typeof memoryNotesToolInputSchema._type, typeof memoryNotesToolOutputSchema._type> = {
  name: "memory_notes",
  description:
    "Read the Global Memory Agent's numbered notepad inbox. Use list with at most 10 notes to see open previews, read(noteNumber) to load one full note plus backend trace lookup refs, and mark_done(noteNumber, outcome, resolution) after processing. outcome must be one of applied, already_represented, skipped, or proposed_skill. Notes are leads; classify before acting, chain into trace_retrieve for exact evidence, and always close with a one-line resolution.",
  inputSchema: memoryNotesToolInputSchema,
  resultSchema: memoryNotesToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "other",
  decidePolicy: () => ({ type: "auto" }),
  execute: async (input, context) => {
    if (!context.executors.memory_notes) {
      throw new SocratesError("memory_notes_unavailable", "memory_notes is not available in this runtime.", { recoverable: true })
    }
    return context.executors.memory_notes(input, context)
  },
  summary: (output) =>
    output.operation === "list"
      ? `Listed ${output.notes.length} memory note(s).`
      : output.operation === "read"
        ? `Read memory note #${output.notes[0]?.noteNumber ?? ""}.`
        : `Marked memory note #${output.notes[0]?.noteNumber ?? ""} done${output.notes[0]?.outcome ? ` as ${output.notes[0].outcome}` : ""}.`,
  resultPreview: (output) =>
    output.notes
      .map((note) => `#${note.noteNumber} ${note.importance}${note.outcome ? ` outcome=${note.outcome}` : ""}${note.defaultSkillScope ? ` default=${note.defaultSkillScope}` : ""}: ${note.note ?? note.notePreview ?? ""}`.trim())
      .join("\n"),
}
