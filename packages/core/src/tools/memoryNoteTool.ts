import { memoryNoteToolInputSchema, memoryNoteToolOutputSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const memoryNoteTool: SocratesTool<typeof memoryNoteToolInputSchema._type, typeof memoryNoteToolOutputSchema._type> = {
  name: "memory_note",
  description:
    "Send one short notepad lead to the Global Memory Agent only when the current turn contains an important durable memory candidate. Never call this tool for content the user genuinely instructed Socrates not to remember, save, store, retain, learn, or add to memory. Prefer one memory_note per user turn; the backend hard-caps distinct notes at two per turn and deduplicates normalized repeats. Input is only note and optional importance. Do not decide the memory target, skill scope, skill name, or action. The backend attaches the current user message and trace refs automatically.",
  inputSchema: memoryNoteToolInputSchema,
  resultSchema: memoryNoteToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "other",
  decidePolicy: () => ({ type: "auto" }),
  execute: async (input, context) => {
    if (!context.executors.memory_note) {
      throw new SocratesError("memory_note_unavailable", "memory_note is not available in this runtime.", { recoverable: true })
    }
    return context.executors.memory_note(input, context)
  },
  summary: (output) => (output.result === "already_recorded" ? `Memory note #${output.noteNumber} was already recorded.` : `Created memory note #${output.noteNumber}.`),
  resultPreview: (output) =>
    output.result === "already_recorded"
      ? `memory note #${output.noteNumber} already_recorded; status=${output.status}; attachedSource=${output.attachedSource}`
      : `memory note #${output.noteNumber} opened; attachedSource=${output.attachedSource}`,
}
