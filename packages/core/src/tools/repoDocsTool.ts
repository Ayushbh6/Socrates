import { repoDocsToolInputSchema, repoDocsToolModelInputSchema, repoDocsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const repoDocsTool: SocratesTool<typeof repoDocsToolInputSchema._type, typeof repoDocsToolOutputSchema._type> = {
  name: "repo_docs",
  description:
    'Read, search, index, or edit the active workspace\'s four .socrates/repo_docs/*.md doctrine files. Call this before nontrivial repo work when repo rules, architecture, contracts, workflows, or durable pitfalls may matter. Prefer read_index first, then read_section or patch_section by sectionId. For patch_section, provide path, sectionId, exact oldText, and newText; do not pass text. For whole-doc replacement, use edit with path plus oldText/newText. Generic edit/apply_patch cannot mutate these files.',
  inputSchema: repoDocsToolInputSchema,
  modelInputSchema: repoDocsToolModelInputSchema,
  resultSchema: repoDocsToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "file",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.repo_docs(input, context),
  summary: (output) =>
    output.operation === "edit" || output.operation === "patch_section"
      ? `${output.changed ? "Updated" : "Did not change"} ${output.path ?? "repo docs"}.`
      : output.operation === "search"
        ? `Found ${output.matches?.length ?? 0} repo-doc match(es).`
        : output.operation === "read_index"
          ? `Read ${output.index ? output.path : "repo-doc"} section index.`
          : output.operation === "read_section"
            ? `Read ${output.path ?? "repo-doc"} section ${output.section?.sectionId ?? ""}.`
        : output.path
          ? `Read ${output.path}.`
          : `Listed ${output.paths?.length ?? 0} repo-doc file(s).`,
  resultPreview: (output) => output.content ?? output.matches?.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") ?? output.paths?.join("\n") ?? "",
  metrics: (output) => ({ filesRead: output.operation === "edit" ? 0 : (output.paths?.length ?? 1), filesEdited: output.changed ? 1 : 0 }),
}
