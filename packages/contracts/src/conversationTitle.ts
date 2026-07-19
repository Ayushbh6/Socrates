import { z } from "zod"

export const conversationTitleAgentOutputSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
  })
  .strict()

export type ConversationTitleAgentOutput = z.infer<typeof conversationTitleAgentOutputSchema>
