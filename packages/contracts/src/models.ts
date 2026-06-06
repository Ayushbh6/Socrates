import { z } from "zod"
import { idSchema } from "./entities"

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

export const conversationContextUsageSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    contextWindowTokens: z.number().int().nonnegative(),
    contextUsedTokens: z.number().int().nonnegative(),
    contextLeftTokens: z.number().int().nonnegative(),
    contextUsedPercent: z.number().min(0).max(100),
  })
  .strict()

export const aiUsageCostSourceSchema = z.enum(["provider_reported", "computed", "unknown", "mixed"])

export const aiUsageSourceKindSchema = z.enum(["main_model_call", "context_compaction", "conversation_title"])

export const usageBreakdownItemSchema = z
  .object({
    key: z.string().min(1),
    providerId: providerIdSchema.optional(),
    modelId: z.string().min(1).optional(),
    sourceKind: aiUsageSourceKindSchema.optional(),
    sourceId: idSchema.optional(),
    status: z.string().min(1).optional(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().optional(),
    costSource: aiUsageCostSourceSchema.optional(),
  })
  .strict()

export const turnUsageReportSchema = z
  .object({
    turnId: idSchema,
    totalCostUsd: z.number().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    reasoningTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    uncachedInputTokens: z.number().int().nonnegative(),
    costSource: aiUsageCostSourceSchema,
    providerBreakdown: z.array(usageBreakdownItemSchema),
    modelBreakdown: z.array(usageBreakdownItemSchema),
    callBreakdown: z.array(usageBreakdownItemSchema),
    compactionBreakdown: z.array(usageBreakdownItemSchema),
    qualityFlags: z.array(z.string().min(1)),
  })
  .strict()

export const conversationCostUsageSchema = z
  .object({
    totalCostUsd: z.number().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    turnCount: z.number().int().nonnegative(),
    costSource: aiUsageCostSourceSchema,
    hasComputedCost: z.boolean(),
    hasUnknownCost: z.boolean(),
  })
  .strict()

export type ProviderId = z.infer<typeof providerIdSchema>
export type ThinkingEffort = z.infer<typeof thinkingEffortSchema>
export type ModelThinkingOption = z.infer<typeof modelThinkingOptionSchema>
export type ModelOption = z.infer<typeof modelOptionSchema>
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>
export type ConversationTokenUsage = z.infer<typeof conversationTokenUsageSchema>
export type ConversationContextUsage = z.infer<typeof conversationContextUsageSchema>
export type AiUsageCostSource = z.infer<typeof aiUsageCostSourceSchema>
export type AiUsageSourceKind = z.infer<typeof aiUsageSourceKindSchema>
export type UsageBreakdownItem = z.infer<typeof usageBreakdownItemSchema>
export type TurnUsageReport = z.infer<typeof turnUsageReportSchema>
export type ConversationCostUsage = z.infer<typeof conversationCostUsageSchema>
