import { skillWriteToolInputSchema, skillWriteToolOutputSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const skillWriteTool: SocratesTool<typeof skillWriteToolInputSchema._type, typeof skillWriteToolOutputSchema._type> = {
  name: "skill_write",
  description:
    "Save the final SKILL.md for an already-approved skill create/update task. This tool only validates and writes the supplied skill content; it does not decide whether the skill should exist.",
  inputSchema: skillWriteToolInputSchema,
  resultSchema: skillWriteToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "other",
  decidePolicy: () => ({ type: "auto" }),
  execute: async (input, context) => {
    if (!context.executors.skill_write) {
      throw new SocratesError("skill_write_unavailable", "skill_write is not available in this runtime.", { recoverable: true })
    }
    return context.executors.skill_write(input, context)
  },
  summary: (output) => `${output.operation === "create" ? "Created" : "Updated"} ${output.scope} skill ${output.name}.`,
  resultPreview: (output) => `${output.scope}:${output.name}\n${output.path}\n${output.summary.description}`,
  metrics: () => ({ filesEdited: 1 }),
}
