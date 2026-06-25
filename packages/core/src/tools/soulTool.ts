import { soulToolInputSchema, soulToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const soulTool: SocratesTool<typeof soulToolInputSchema._type, typeof soulToolOutputSchema._type> = {
  name: "soul",
  description:
    "Read-only access to Socrates core identity document. Call this when the user asks about Socrates' soul, identity, voice, operating principles, safety boundaries, or exact stored self-description. Prefer read_index first, then read_section with a known sectionId for focused context. Use full read only when the whole identity document is genuinely needed; it returns bounded markdown and should use a tight charLimit. This is not the user profile. This tool cannot edit identity; identity updates are backend-memory-agent controlled.",
  inputSchema: soulToolInputSchema,
  resultSchema: soulToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.soul(input, context),
  summary: (output) => (output.operation === "read_section" ? `Read identity section ${output.section?.sectionId ?? ""}.` : `Read ${output.path}.`),
  resultPreview: (output) => output.content ?? "",
  metrics: () => ({ filesRead: 1 }),
}
