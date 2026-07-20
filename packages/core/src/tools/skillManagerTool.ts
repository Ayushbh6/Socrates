import {
  skillManagerToolInputSchema,
  skillManagerToolOutputSchema,
  type SkillManagerToolInput,
  type SkillManagerToolOutput,
} from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const skillManagerTool: SocratesTool<SkillManagerToolInput, SkillManagerToolOutput> = {
  name: "skill_manager",
  description:
    "Create or delete a reusable project skill only when the user explicitly asks. Create delegates the approved request to the configured structured Skill Writer agent; never write .socrates/skills directly. Delete removes only the exact named project skill after approval. Use skills list or describe to verify the result.",
  inputSchema: skillManagerToolInputSchema,
  resultSchema: skillManagerToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "other",
  decidePolicy: (input) => ({
    type: "approval_required",
    request: {
      actionKind: "file_write",
      title: `${input.operation === "create" ? "Create" : "Delete"} project skill ${input.name}`,
      description: input.operation === "create"
        ? "Delegate this approved project-skill request to the configured Skill Writer agent."
        : "Delete this exact project skill and its owned files.",
      actionPreview: JSON.stringify(input, null, 2),
      risk: input.operation === "delete" ? "medium" : "low",
    },
  }),
  execute: async (input, context) => {
    if (!context.executors.skill_manager) {
      throw new SocratesError("skill_manager_unavailable", "Project skill management is not available in this runtime.", { recoverable: true })
    }
    return context.executors.skill_manager(input, context)
  },
  summary: (output) => `${output.status === "created" ? "Created" : "Deleted"} project skill ${output.name}.`,
  resultPreview: (output) => JSON.stringify(output, null, 2),
  metrics: () => ({ filesEdited: 1 }),
}
