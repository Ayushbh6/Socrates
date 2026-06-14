import { soulToolInputSchema, soulToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const soulTool: SocratesTool<typeof soulToolInputSchema._type, typeof soulToolOutputSchema._type> = {
  name: "soul",
  description:
    "Read-only access to Socrates core soul documents: identity and operating principles. Call this when the user asks about Socrates' soul, identity, principles, or exact stored self-description. This is not the user profile. This tool cannot edit soul files; soul updates are backend-memory-agent controlled.",
  inputSchema: soulToolInputSchema,
  resultSchema: soulToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.soul(input, context),
  summary: (output) => `Read ${output.documents.length} soul document(s).`,
  resultPreview: (output) => output.documents.map((document) => `# ${document.document}\n${document.content}`).join("\n\n"),
  metrics: (output) => ({ filesRead: output.documents.length }),
}
