import { frontierHandoverToolInputSchema, frontierHandoverToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const frontierHandoverTool: SocratesTool<
  typeof frontierHandoverToolInputSchema._type,
  typeof frontierHandoverToolOutputSchema._type
> = {
  name: "handover_to_frontier",
  displayName: "Calling Frontier model",
  description:
    "Request a one-way handover of the current task to the configured Frontier model for the remainder of this turn. The user must approve the transfer. Frontier automatically receives the full conversation, every tool call and result, and all work already completed. You are the primary worker: make a real, substantive effort first, and request handover only after reaching a concrete unresolved capability or reliability blocker that you cannot overcome with the available evidence and tools. Do not request it merely because a task is long, difficult, high consequence, involves code or several ordinary tools, or encountered one recoverable error. Call this tool alone and without accompanying prose. focus is optional and must be a compact direction of at most 20 words; never restate the full request.",
  inputSchema: frontierHandoverToolInputSchema,
  resultSchema: frontierHandoverToolOutputSchema,
  permission: "execute",
  executeLane: "mutation",
  category: "other",
  decidePolicy: (input, context) => {
    const target = context.frontierModel
      ? `${context.frontierModel.modelId} through ${context.frontierModel.providerId}`
      : "the configured Frontier model"
    return {
      type: "approval_required",
      request: {
        actionKind: "other",
        title: "Call Frontier model",
        description: `Socrates is asking ${target} to take over this turn. The Frontier model will receive the complete conversation and tool history and will provide the final answer.`,
        actionPreview: input.focus ? `Focus: ${input.focus}` : "Continue the complete current task.",
        risk: "medium",
      },
    }
  },
  execute: async (input) => ({
    status: "accepted",
    ...(input.focus ? { focus: input.focus } : {}),
    message: "Frontier accepted the handover and will continue this task with the full turn context.",
  }),
  summary: (output) => (output.focus ? `Handed over to Frontier: ${output.focus}` : "Handed over to Frontier."),
  resultPreview: (output) => output.message,
}
