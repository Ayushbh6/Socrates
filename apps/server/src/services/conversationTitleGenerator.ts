import fs from "node:fs"
import type { Message, MessageAttachment, ProviderAuthMode, ProviderId, ThinkingEffort, WorkerModelSettings } from "@socrates/contracts"
import { TitleGeneratorAgent } from "@socrates/core"
import type { ModelMessageContent, ModelMessagePart, ModelProvider, ModelUsage } from "@socrates/providers"

export const conversationTitleProviderId: ProviderId = "openrouter"
export const conversationTitlePrimaryModelId = "meta-llama/llama-4-maverick"
export const conversationTitleFallbackModelId = "qwen/qwen3.5-flash-02-23"

const titleTimeoutMs = 12_000
const maxTitleImages = 3
const maxTitleCharacters = 48

export type ConversationTitleGenerationResult = {
  title: string
  providerId: ProviderId
  modelId: string
  usage?: ModelUsage
}

export const generateConversationTitle = async (input: {
  provider: ModelProvider
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  workspacePath: string
  message: Message
  fallbackTitle: string
  modelSettings?: WorkerModelSettings
  abortSignal?: AbortSignal
}): Promise<ConversationTitleGenerationResult | undefined> => {
  if (input.abortSignal?.aborted) {
    return
  }

  const titleContent = buildTitleContent(input.message)
  const candidates = titleModelCandidates(input.modelSettings)
  for (const candidate of candidates) {
    const result = await runTitleCandidate({
      ...input,
      modelSettings: candidate,
      userContent: titleContent,
    })
    if (result?.title) {
      return result
    }
  }
}

const runTitleCandidate = async (input: {
  provider: ModelProvider
  projectId: string
  conversationId: string
  sessionId: string
  turnId: string
  workspacePath: string
  modelSettings: TitleModelSettings
  userContent: ModelMessageContent
  fallbackTitle: string
  abortSignal?: AbortSignal
}): Promise<ConversationTitleGenerationResult | undefined> => {
  if (input.abortSignal?.aborted) {
    return
  }

  const abortController = new AbortController()
  const timeout = setTimeout(() => abortController.abort(), titleTimeoutMs)
  const abortFromParent = () => abortController.abort()
  input.abortSignal?.addEventListener("abort", abortFromParent, { once: true })

  try {
    const result = await new TitleGeneratorAgent().run({
      provider: input.provider,
      modelSettings: input.modelSettings,
      userContent: input.userContent,
      projectId: input.projectId,
      conversationId: input.conversationId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      workspacePath: input.workspacePath,
      abortSignal: abortController.signal,
    })
    const title = sanitizeGeneratedTitle(result.output.title, input.fallbackTitle)
    const usage = mergeUsages(result.usages)
    return title
      ? {
          title,
          providerId: input.modelSettings.providerId,
          modelId: input.modelSettings.modelId,
          ...(usage ? { usage } : {}),
        }
      : undefined
  } catch {
    return
  } finally {
    clearTimeout(timeout)
    input.abortSignal?.removeEventListener("abort", abortFromParent)
  }
}

export const sanitizeGeneratedTitle = (value: string, fallbackTitle: string): string => {
  const normalized = value
    .trim()
    .replace(/^["'`]+|["'`.]+$/g, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
  const title = normalized || fallbackTitle.trim()
  if (!title) {
    return fallbackTitle
  }
  if (title.length <= maxTitleCharacters) {
    return title
  }
  return `${title.slice(0, maxTitleCharacters - 3).trimEnd()}...`
}

const buildTitleContent = (message: Message): ModelMessageContent => {
  const attachments = (message.attachments ?? []).filter((attachment) => attachment.kind === "image").slice(0, maxTitleImages)
  const text = message.content.trim()
  if (attachments.length === 0) {
    return text || "Create a short title for this new image-only chat."
  }

  const parts: ModelMessagePart[] = [
    {
      type: "text",
      text: [
        text || "The first user message contains only image attachments.",
        "Create a concise personalized chat title from the user's text and attached image content.",
      ].join("\n"),
    },
  ]

  for (const attachment of attachments) {
    const data = readAttachmentDataUrl(attachment)
    if (data) {
      parts.push({ type: "image", mediaType: attachment.mimeType, data, fileName: attachment.fileName })
    }
  }

  return parts
}

const readAttachmentDataUrl = (attachment: MessageAttachment): string | undefined => {
  try {
    const data = fs.readFileSync(attachment.uri)
    return `data:${attachment.mimeType};base64,${data.toString("base64")}`
  } catch {
    return
  }
}

type TitleModelSettings = {
  providerId: ProviderId
  authMode?: ProviderAuthMode
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: ThinkingEffort
}

const titleModelCandidates = (settings: WorkerModelSettings | undefined): TitleModelSettings[] => {
  const primary: TitleModelSettings = settings
    ? {
        providerId: settings.providerId,
        authMode: settings.authMode ?? "api_key",
        modelId: settings.modelId,
        thinkingEnabled: settings.thinkingEnabled,
        ...(settings.thinkingEffort ? { thinkingEffort: settings.thinkingEffort } : {}),
      }
    : {
        providerId: conversationTitleProviderId,
        authMode: "api_key",
        modelId: conversationTitlePrimaryModelId,
        thinkingEnabled: false,
      }
  return uniqueTitleModels([primary])
}

const uniqueTitleModels = (models: TitleModelSettings[]): TitleModelSettings[] => {
  const seen = new Set<string>()
  return models.filter((model) => {
    const key = `${model.providerId}:${model.authMode ?? "api_key"}:${model.modelId}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

const mergeUsages = (usages: ModelUsage[]): ModelUsage | undefined =>
  usages.reduce<ModelUsage | undefined>((merged, usage) => {
    if (!merged) return { ...usage }
    const next: ModelUsage = { ...merged, ...usage }
    for (const key of usageNumberKeys) {
      if (merged[key] !== undefined || usage[key] !== undefined) {
        next[key] = (merged[key] ?? 0) + (usage[key] ?? 0)
      }
    }
    return next
  }, undefined)

const usageNumberKeys = [
  "inputTokens",
  "outputTokens",
  "reasoningTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "uncachedInputTokens",
  "totalTokens",
  "costUsd",
] as const satisfies ReadonlyArray<keyof ModelUsage>
