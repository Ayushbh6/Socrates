import { repoDocsToolInputSchema, repoDocsToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const repoDocsTool: SocratesTool<typeof repoDocsToolInputSchema._type, typeof repoDocsToolOutputSchema._type> = {
  name: "repo_docs",
  description:
    "Read, search, or edit the active workspace's four .socrates/repo_docs/*.md doctrine files. Edit is a constrained oldText/newText replacement against one allowlisted repo-doc file only; use it for durable repo behavior, contracts, workflows, and pitfalls.",
  inputSchema: repoDocsToolInputSchema,
  resultSchema: repoDocsToolOutputSchema,
  permission: "mutate",
  executeLane: "mutation",
  category: "file",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.repo_docs(input, context),
  summary: (output) =>
    output.operation === "edit"
      ? `${output.changed ? "Updated" : "Did not change"} ${output.path ?? "repo docs"}.`
      : output.operation === "search"
        ? `Found ${output.matches?.length ?? 0} repo-doc match(es).`
        : output.path
          ? `Read ${output.path}.`
          : `Listed ${output.paths?.length ?? 0} repo-doc file(s).`,
  resultPreview: (output) => output.content ?? output.matches?.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") ?? output.paths?.join("\n") ?? "",
  metrics: (output) => ({ filesRead: output.operation === "edit" ? 0 : (output.paths?.length ?? 1), filesEdited: output.changed ? 1 : 0 }),
}
