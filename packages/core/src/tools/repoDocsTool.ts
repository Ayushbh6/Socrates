import { repoDocsToolInputSchema, repoDocsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const repoDocsTool: SocratesTool<typeof repoDocsToolInputSchema._type, typeof repoDocsToolOutputSchema._type> = {
  name: "repo_docs",
  description:
    "Read, search, index, or edit the active workspace's four .socrates/repo_docs/*.md doctrine files. Outputs include system runtime date/time metadata. Call this before nontrivial repo work when repo rules, architecture, contracts, workflows, or durable pitfalls may matter. Prefer read_index first, then read_section or patch_section by sectionId for focused recall and edits. Whole-file read/search/edit remains available as fallback. Generic edit/apply_patch cannot mutate these files.",
  inputSchema: repoDocsToolInputSchema,
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
