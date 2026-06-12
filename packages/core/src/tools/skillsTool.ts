import { skillsToolInputSchema, skillsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const skillsTool: SocratesTool<typeof skillsToolInputSchema._type, typeof skillsToolOutputSchema._type> = {
  name: "skills",
  description:
    'List, search, or read Socrates skills from builtin, global, and project skill roots. Skills are read-only for the main agent; use them for reusable workflows, learned patterns, and specialized procedures.',
  inputSchema: skillsToolInputSchema,
  resultSchema: skillsToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "search",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.skills(input, context),
  summary: (output) =>
    output.operation === "read"
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
