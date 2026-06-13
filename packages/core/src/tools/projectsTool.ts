import { projectsToolInputSchema, projectsToolOutputSchema } from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import type { SocratesTool } from "./types"

export const projectsTool: SocratesTool<typeof projectsToolInputSchema._type, typeof projectsToolOutputSchema._type> = {
  name: "projects",
  description:
    "List visible projects or conversations for the global backend memory agent. Returns metadata only; use trace_retrieve for deep conversation evidence.",
  inputSchema: projectsToolInputSchema,
  resultSchema: projectsToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "search",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => {
    if (!context.executors.projects) {
      throw new SocratesError("projects_tool_unavailable", "projects is not available in this runtime.", { recoverable: true })
    }
    return context.executors.projects(input, context)
  },
  summary: (output) =>
    output.operation === "list_projects"
      ? `Listed ${output.projects?.length ?? 0} project(s).`
      : `Listed ${output.conversations?.length ?? 0} conversation(s).`,
  resultPreview: (output) =>
    output.operation === "list_projects"
      ? (output.projects ?? []).map((project) => `${project.id} ${project.name} (${project.status})`).join("\n")
      : (output.conversations ?? []).map((conversation) => `${conversation.id} ${conversation.title ?? "Untitled"} (${conversation.status})`).join("\n"),
  metrics: (output) => ({ searchesRun: output.operation === "list_projects" || output.operation === "list_conversations" ? 1 : 0 }),
}
