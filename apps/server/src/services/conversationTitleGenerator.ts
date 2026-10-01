import fs from "node:fs"
import type { Message, MessageAttachment, ProviderId, RuntimeConfig, WorkerModelSettings } from "@socrates/contracts"
import type { ModelMessage, ModelMessagePart, ModelProvider, ModelUsage } from "@socrates/providers"

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
  message: Message
  fallbackTitle: string
  modelSettings?: WorkerModelSettings
  abortSignal?: AbortSignal
}): Promise<ConversationTitleGenerationResult | undefined> => {
  if (input.abortSignal?.aborted) {
    return
  }

  const titleMessage = buildTitleMessage(input.message)
  const candidates = titleModelCandidates(input.modelSettings)
  for (const candidate of candidates) {
    const result = await streamTitleCandidate({
      ...input,
      modelSettings: candidate,
      message: titleMessage,
    })
    if (result?.title) {
      return result
    }
  }
}

const streamTitleCandidate = async (input: {
  provider: ModelProvider
  projectId: string
  conversationId: string
  modelSettings: TitleModelSettings
  message: ModelMessage
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
    let answer = ""
    let latestUsage: ModelUsage | undefined
    for await (const event of input.provider.stream({
      providerId: input.modelSettings.providerId,
      modelId: input.modelSettings.modelId,
      sessionId: input.conversationId,
      cacheKey: `project:${input.projectId}:conversation:${input.conversationId}:title`,
      system: titleSystemPrompt,
      messages: [input.message],
      providerRouting: { omitReasoning: true },
      runtimeConfig: titleRuntimeConfig(input.modelSettings),
      tools: [],
      abortSignal: abortController.signal,
    })) {
      if (event.type === "model.answer.delta") {
        answer += event.text
      }
      if (event.type === "model.usage") {
        latestUsage = event.usage
      }
      if (event.type === "model.completed" && event.usage) {
        latestUsage = event.usage
      }
      if (event.type === "model.failed") {
        return
      }
    }

    if (!answer.trim()) {
      return
    }
    const title = sanitizeGeneratedTitle(answer, input.fallbackTitle)
    return title
      ? {
          title,
          providerId: input.modelSettings.providerId,
          modelId: input.modelSettings.modelId,
          ...(latestUsage ? { usage: latestUsage } : {}),
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

const buildTitleMessage = (message: Message): ModelMessage => {
  const attachments = (message.attachments ?? []).filter((attachment) => attachment.kind === "image").slice(0, maxTitleImages)
  const text = message.content.trim()
  if (attachments.length === 0) {
    return {
      role: "user",
      content: text || "Create a short title for this new image-only chat.",
    }
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

  return {
    role: "user",
    content: parts,
  }
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
  authMode?: RuntimeConfig["authMode"]
  modelId: string
  thinkingEnabled: boolean
  thinkingEffort?: RuntimeConfig["thinkingEffort"]
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

const titleRuntimeConfig = (settings: TitleModelSettings): RuntimeConfig => ({
  providerId: settings.providerId,
  authMode: settings.authMode ?? "api_key",
  modelId: settings.modelId,
  thinkingEnabled: settings.thinkingEnabled,
  ...(settings.thinkingEffort ? { thinkingEffort: settings.thinkingEffort } : {}),
  approvalMode: "read_only_auto",
  sandboxMode: "read_only",
})

const titleSystemPrompt = [
  "Generate a short title for a new chat conversation.",
  "Return only the title.",
  "Use 2 to 6 words when possible.",
  "Do not wrap the title in quotes.",
  "Use the user's language if obvious.",
  "For image-only messages, infer the subject from the image.",
].join("\n")
