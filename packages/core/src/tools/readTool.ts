import { readToolInputSchema, readToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const readTool: SocratesTool<typeof readToolInputSchema._type, typeof readToolOutputSchema._type> = {
  name: "read",
  description:
    "Read a bounded file, directory, document, structured data file, or image from the active project workspace. Output is capped to an estimated 4k tokens by default and 6k tokens max; use charLimit, tokenLimit, and offset for large files.",
  inputSchema: readToolInputSchema,
  resultSchema: readToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "file",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.read(input, context),
  summary: (output) => `Read ${output.kind} ${output.path}.`,
  resultPreview: (output) => output.content ?? output.entries?.map((entry) => entry.path).join("\n") ?? output.image?.description ?? "",
  metrics: (output) => ({ filesRead: output.kind === "directory" ? 0 : 1 }),
}
