import {
  shouldShowAssistantTurnActivity,
  shouldShowAssistantTurnFailure,
} from './assistantTurns'
import type { ConversationTimelineEntry, OptimisticUserMessage } from './conversationTimeline'
import type { Message } from '@/types/api'

function textLength(value: string | null | undefined): number {
  return value?.length ?? 0
}

function assetSignature(message: Message | OptimisticUserMessage): string {
  return message.assets.map((asset) => `${asset.id}:${asset.original_name.length}`).join(',')
}

function userSignature(entry: Extract<ConversationTimelineEntry, { kind: 'user' }>): string {
  const { message } = entry
  return [
    'user',
    entry.key,
    message.id,
    textLength(message.content_text),
    message.assets.length,
    assetSignature(message),
  ].join(':')
}

function legacyAssistantSignature(
  entry: Extract<ConversationTimelineEntry, { kind: 'legacy-assistant' }>,
): string {
  const { message } = entry
  const hasThinking = Boolean(message.thinking_text?.trim())
  const hasContent = Boolean(message.content_text?.trim())
  return [
    'legacy-assistant',
    entry.key,
    message.id,
    hasThinking ? 1 : 0,
    hasThinking ? textLength(message.thinking_text) : 0,
    hasContent ? 1 : 0,
    hasContent ? textLength(message.content_text) : 0,
    message.assets.length,
    assetSignature(message),
  ].join(':')
}

function assistantSignature(entry: Extract<ConversationTimelineEntry, { kind: 'assistant' }>): string {
  const { turn } = entry
  const isStreaming = turn.status === 'queued' || turn.status === 'running'
  const persistedContent = turn.persistedMessage?.content_text ?? ''
  const persistedThinking = turn.persistedMessage?.thinking_text ?? ''
  const displayContent = persistedContent.trim().length > 0 ? persistedContent : turn.partialContent
  const displayThinking = persistedThinking.trim().length > 0 ? persistedThinking : turn.partialThinking
  const hasContent = displayContent.trim().length > 0
  const hasThinking = displayThinking.trim().length > 0
  const showStreamingStatus = isStreaming && !hasThinking && !hasContent
  const showThinkingPanel = hasThinking || showStreamingStatus
  const showFailure = shouldShowAssistantTurnFailure(turn)
  const showActivityPanel = shouldShowAssistantTurnActivity(turn)

  return [
    'assistant',
    entry.key,
    turn.runId,
    turn.responseMessageId ?? '',
    turn.persistedMessage?.id ?? '',
    showThinkingPanel ? 1 : 0,
    showThinkingPanel && hasThinking ? displayThinking.length : 0,
    hasContent ? 1 : 0,
    hasContent ? displayContent.length : 0,
    showFailure ? 1 : 0,
    showActivityPanel ? 1 : 0,
    turn.persistedMessage?.assets.length ?? 0,
    turn.persistedMessage ? assetSignature(turn.persistedMessage) : '',
  ].join(':')
}

function entrySignature(entry: ConversationTimelineEntry): string {
  if (entry.kind === 'user') {
    return userSignature(entry)
  }
  if (entry.kind === 'legacy-assistant') {
    return legacyAssistantSignature(entry)
  }
  return assistantSignature(entry)
}

export function createConversationScrollSignature(entries: readonly ConversationTimelineEntry[]): string {
  return entries.map(entrySignature).join('\n')
}
