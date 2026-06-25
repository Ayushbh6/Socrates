import { userProfileToolInputSchema, userProfileToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const userProfileTool: SocratesTool<typeof userProfileToolInputSchema._type, typeof userProfileToolOutputSchema._type> = {
  name: "user_profile",
  description:
    "Read-only access to the global user profile and stable cross-project preferences. Call this when the user asks what Socrates knows about them, asks about their preferences/profile, or when durable user context would materially improve an answer. Prefer read_index first, then read_section with a known sectionId for focused context. Use full read only when the whole profile is genuinely needed; it returns bounded markdown and should use a tight charLimit. This tool cannot edit the profile; user_profile updates are backend-memory-agent controlled.",
  inputSchema: userProfileToolInputSchema,
  resultSchema: userProfileToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.user_profile(input, context),
  summary: (output) => (output.operation === "read_section" ? `Read user profile section ${output.section?.sectionId ?? ""}.` : `Read user profile ${output.path}.`),
  resultPreview: (output) => output.content ?? "",
  metrics: () => ({ filesRead: 1 }),
}
