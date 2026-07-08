import { z } from "zod"
import { idSchema } from "./entities"

export const providerIdSchema = z.enum(["openai", "google", "openrouter", "deepseek", "ollama"])
export const providerAuthModeSchema = z.enum(["api_key", "chatgpt_subscription"])
export const defaultProviderAuthMode = "api_key" as const

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
    authMode: providerAuthModeSchema.default(defaultProviderAuthMode),
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
        authMode: providerAuthModeSchema.default(defaultProviderAuthMode),
        modelId: z.string().min(1),
        thinkingOptionId: z.string().min(1),
      })
      .strict()
      .nullable(),
  })
  .strict()

export const modelSelectionSchema = z
  .object({
    providerId: providerIdSchema,
    authMode: providerAuthModeSchema.optional(),
    modelId: z.string().min(1),
  })
  .strict()
export type ModelSelection = z.infer<typeof modelSelectionSchema>

export const resolvedModelSelectionStatusSchema = z.enum(["selected", "resolved_fallback", "unavailable"])

export const modelSettingsSelectionSchema = z
  .object({
    providerId: providerIdSchema,
    authMode: providerAuthModeSchema.optional(),
    modelId: z.string().min(1),
    thinkingEnabled: z.boolean(),
    thinkingEffort: thinkingEffortSchema.optional(),
  })
  .strict()
export type ModelSettingsSelection = z.infer<typeof modelSettingsSelectionSchema>

export const modelSettingsResolutionSchema = z
  .object({
    status: resolvedModelSelectionStatusSchema,
    reason: z.string().min(1).optional(),
    saved: modelSettingsSelectionSchema,
    effective: modelSettingsSelectionSchema.optional(),
  })
  .strict()
export type ModelSettingsResolution = z.infer<typeof modelSettingsResolutionSchema>

export const workerModelRoleSchema = z.enum(["skill_writer", "context_compactor", "title_generator", "memory_router"])
export type WorkerModelRole = z.infer<typeof workerModelRoleSchema>

export const workerModelSettingsSchema = z
  .object({
    workerId: workerModelRoleSchema,
    providerId: providerIdSchema,
    authMode: providerAuthModeSchema.optional(),
    modelId: z.string().min(1),
    thinkingEnabled: z.boolean(),
    thinkingEffort: thinkingEffortSchema.optional(),
    updatedAt: z.string().min(1),
  })
  .strict()
export type WorkerModelSettings = z.infer<typeof workerModelSettingsSchema>

export const resolvedWorkerModelSettingsSchema = workerModelSettingsSchema.extend({
  resolution: modelSettingsResolutionSchema,
})
export type ResolvedWorkerModelSettings = z.infer<typeof resolvedWorkerModelSettingsSchema>

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

export const aiUsageSourceKindSchema = z.enum(["main_model_call", "context_compaction", "conversation_title", "memory_router"])

export const usageBreakdownItemSchema = z
  .object({
    key: z.string().min(1),
    providerId: providerIdSchema.optional(),
    modelId: z.string().min(1).optional(),
    sourceKind: aiUsageSourceKindSchema.optional(),
    sourceId: idSchema.optional(),
    status: z.string().min(1).optional(),
    routedProvider: z.string().min(1).optional(),
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
export type ProviderAuthMode = z.infer<typeof providerAuthModeSchema>
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
