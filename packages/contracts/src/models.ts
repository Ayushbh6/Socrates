import { z } from "zod"

export const providerIdSchema = z.enum(["openai", "google", "openrouter"])

export const thinkingEffortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh"])

export const modelThinkingOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    enabled: z.boolean(),
    effort: thinkingEffortSchema.optional(),
  })
  .strict()

export const modelOptionSchema = z
  .object({
    providerId: providerIdSchema,
    providerLabel: z.string().min(1),
    modelId: z.string().min(1),
    label: z.string().min(1),
    isDefault: z.boolean(),
    contextWindowTokens: z.number().int().positive().optional(),
    capabilities: z
      .object({
        vision: z.boolean(),
      })
      .strict()
      .optional(),
    thinkingOptions: z.array(modelThinkingOptionSchema).min(1),
    defaultThinkingOptionId: z.string().min(1),
  })
  .strict()

export const listModelsResponseSchema = z
  .object({
    models: z.array(modelOptionSchema),
    defaultModel: z
      .object({
        providerId: providerIdSchema,
        modelId: z.string().min(1),
        thinkingOptionId: z.string().min(1),
      })
      .strict(),
  })
  .strict()

export const conversationTokenUsageSchema = z
  .object({
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
  })
  .strict()

export type ProviderId = z.infer<typeof providerIdSchema>
export type ThinkingEffort = z.infer<typeof thinkingEffortSchema>
export type ModelThinkingOption = z.infer<typeof modelThinkingOptionSchema>
export type ModelOption = z.infer<typeof modelOptionSchema>
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>
export type ConversationTokenUsage = z.infer<typeof conversationTokenUsageSchema>
