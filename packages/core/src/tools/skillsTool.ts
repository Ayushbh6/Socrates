import {
  skillsToolInputSchema,
  skillsToolModelInputSchema,
  skillsToolOutputSchema,
  skillsToolReadModelInputSchema,
  type SkillsToolOutput,
  type SkillsToolReadModelInput,
} from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const skillsTool: SocratesTool<typeof skillsToolInputSchema._type, typeof skillsToolOutputSchema._type> = {
  name: "skills",
  description:
    "Discover and use Socrates skills, or import one Agent Skill ZIP from an exact user-supplied public HTTPS URL or ZIP attached to the current user message. Call list before domain tools for a saved workflow, named skill, checklist, recurring procedure, closure/handoff request, or specialized task; use describe with the exact canonical id to load SKILL.md, and use read for referenced supporting files. For imports, call preview_import with exactly one url or attachmentPath, report its metadata, conflicts, file counts, and security warnings, then call commit_import only after the user has asked to install that reviewed preview. Project is the default scope. Importing is not web search: never invent or discover a URL, never use Terminal to bypass preview, and never fake skill results.",
  inputSchema: skillsToolInputSchema,
  modelInputSchema: skillsToolModelInputSchema,
  resultSchema: skillsToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "search",
  decidePolicy: (input) =>
    input.operation === "commit_import"
      ? {
          type: "approval_required",
          request: {
            actionKind: "file_write",
            title: `Install ${input.scope ?? "project"} skill`,
            description: `Install the reviewed Agent Skill package into ${input.scope ?? "project"} scope${input.conflictStrategy === "replace" ? " and replace the existing skill" : ""}.`,
            actionPreview: JSON.stringify(
              {
                operation: input.operation,
                scope: input.scope ?? "project",
                previewId: input.previewId,
                conflictStrategy: input.conflictStrategy ?? "reject",
              },
              null,
              2,
            ),
            risk: input.conflictStrategy === "replace" ? "medium" : "low",
          },
        }
      : { type: "auto" },
  execute: (input, context) => context.executors.skills(input, context),
  summary: (output) =>
    output.operation === "preview_import"
      ? `Reviewed skill import ${output.importPreview?.skill.name ?? "package"}.`
      : output.operation === "commit_import"
        ? `Installed skill ${output.skills[0]?.name ?? "package"}.`
        : output.operation === "read" || output.operation === "describe"
      ? `Read skill ${output.skills[0]?.name ?? output.path ?? ""}.`
      : `${output.operation === "search" ? "Found" : "Listed"} ${output.skills.length} skill(s).`,
  resultPreview: (output) => {
    if (output.importPreview) return JSON.stringify(output.importPreview, null, 2)
    if (output.operation === "commit_import") return JSON.stringify({ skill: output.skills[0], replaced: output.replaced, warnings: output.warnings }, null, 2)
    if (output.content) return output.content
    return output.skills.map((skill) => `${skill.scope}:${skill.name} - ${skill.description}`).join("\n")
  },
  metrics: (output) => ({
    filesRead: output.operation === "read" ? 1 : 0,
    searchesRun: output.operation === "search" ? 1 : 0,
  }),
}

export const skillsReadOnlyTool: SocratesTool<SkillsToolReadModelInput, SkillsToolOutput> = {
  ...skillsTool,
  description:
    "List, describe, or read supporting files from installed Socrates skills in builtin, global, and project roots. Use list to discover exact ids, describe to load SKILL.md, and read for an exact referenced supporting path. This specialized-agent surface cannot import or mutate skills.",
  inputSchema: skillsToolReadModelInputSchema,
  modelInputSchema: skillsToolReadModelInputSchema,
  permission: "read",
  executeLane: "parallel",
  decidePolicy: () => ({ type: "auto" }),
}
