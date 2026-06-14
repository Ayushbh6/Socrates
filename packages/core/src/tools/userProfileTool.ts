import { userProfileToolInputSchema, userProfileToolOutputSchema } from "@socrates/contracts"
import type { SocratesTool } from "./types"

export const userProfileTool: SocratesTool<typeof userProfileToolInputSchema._type, typeof userProfileToolOutputSchema._type> = {
  name: "user_profile",
  description:
    "Read-only access to the global user profile and stable cross-project preferences. Call this when the user asks what Socrates knows about them, asks about their preferences/profile, or when durable user context would materially improve an answer. This tool cannot edit the profile; user_profile updates are backend-memory-agent controlled.",
  inputSchema: userProfileToolInputSchema,
  resultSchema: userProfileToolOutputSchema,
  permission: "read",
  executeLane: "parallel",
  category: "trace",
  decidePolicy: () => ({ type: "auto" }),
  execute: (input, context) => context.executors.user_profile(input, context),
  summary: (output) => `Read user profile ${output.path}.`,
  resultPreview: (output) => output.content,
  metrics: () => ({ filesRead: 1 }),
}
