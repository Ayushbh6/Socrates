import { skillsToolInputSchema, skillsToolModelInputSchema, skillsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const skillsTool: SocratesTool<typeof skillsToolInputSchema._type, typeof skillsToolOutputSchema._type> = {
  name: "skills",
  description:
    "List or describe Socrates skills from builtin, global, and project skill roots. Call list before answering when a user asks for a saved workflow, named skill, project/global skill, checklist, recurring procedure, or specialized/unfamiliar task that may already have instructions. Use describe with the exact canonical id from list whenever possible; use name only for an exact listed name. Do not copy a display name into id. Do not fake skill results.",
  inputSchema: skillsToolInputSchema,
  modelInputSchema: skillsToolModelInputSchema,
  resultSchema: skillsToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "search",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.skills(input, context),
  summary: (output) =>
    output.operation === "read" || output.operation === "describe"
      ? `Read skill ${output.skills[0]?.name ?? output.path ?? ""}.`
      : `${output.operation === "search" ? "Found" : "Listed"} ${output.skills.length} skill(s).`,
  resultPreview: (output) => {
    if (output.content) return output.content
    return output.skills.map((skill) => `${skill.scope}:${skill.name} - ${skill.description}`).join("\n")
  },
  metrics: (output) => ({
    filesRead: output.operation === "read" ? 1 : 0,
    searchesRun: output.operation === "search" ? 1 : 0,
  }),
}
