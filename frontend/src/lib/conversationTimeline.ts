import { attachPersistedAssistantMessage, type AssistantTurnState } from './assistantTurns'
import type { Asset, Message } from '@/types/api'

export interface OptimisticUserMessage {
  id: string
  role: 'user'
  content_text: string | null
  thinking_text: string | null
  status: 'queued' | 'completed'
  assets: Asset[]
  sequence_no: number
  agent_run_id?: string | null
}

export interface ConversationTimelineUserEntry {
  kind: 'user'
  key: string
  message: Message | OptimisticUserMessage
}

export interface ConversationTimelineAssistantEntry {
  kind: 'assistant'
  key: string
  turn: AssistantTurnState
}

export interface ConversationTimelineLegacyAssistantEntry {
  kind: 'legacy-assistant'
  key: string
  message: Message
}

export type ConversationTimelineEntry =
  | ConversationTimelineUserEntry
  | ConversationTimelineAssistantEntry
  | ConversationTimelineLegacyAssistantEntry

function sortBySequence(
  left: Pick<Message, 'sequence_no'> | Pick<OptimisticUserMessage, 'sequence_no'>,
  right: Pick<Message, 'sequence_no'> | Pick<OptimisticUserMessage, 'sequence_no'>,
) {
  return left.sequence_no - right.sequence_no
}

export function buildConversationTimeline(
  messages: Message[],
  optimisticUsers: OptimisticUserMessage[],
  assistantTurns: Record<string, AssistantTurnState>,
): ConversationTimelineEntry[] {
  const persistedAssistantMessagesByRunId = new Map<string, Message>()
  const legacyAssistantMessages: Message[] = []
  const persistedUsers = messages.filter((message) => {
    if (message.metadata?.system_generated === true) {
      return false
    }
    if (message.role === 'assistant') {
      if (message.agent_run_id) {
        persistedAssistantMessagesByRunId.set(message.agent_run_id, message)
      } else {
        legacyAssistantMessages.push(message)
      }
      return false
    }
    return true
  })

  const normalizedTurns: Record<string, AssistantTurnState> = { ...assistantTurns }
  for (const [runId, message] of persistedAssistantMessagesByRunId.entries()) {
    normalizedTurns[runId] = attachPersistedAssistantMessage(normalizedTurns[runId], message)
  }

  const sortedUsers = [...persistedUsers, ...optimisticUsers].sort(sortBySequence)
  const entries: ConversationTimelineEntry[] = []
  const seenRunIds = new Set<string>()

  for (const message of sortedUsers) {
    entries.push({ kind: 'user', key: message.id, message })
    const runId = message.agent_run_id
    if (runId && normalizedTurns[runId] && !seenRunIds.has(runId)) {
      entries.push({
        kind: 'assistant',
        key: `assistant:${runId}`,
        turn: normalizedTurns[runId],
      })
      seenRunIds.add(runId)
    }
  }

  for (const message of legacyAssistantMessages.sort(sortBySequence)) {
    entries.push({
      kind: 'legacy-assistant',
      key: `legacy:${message.id}`,
      message,
    })
  }

  for (const turn of Object.values(normalizedTurns)) {
    if (seenRunIds.has(turn.runId)) {
      continue
    }
    entries.push({
      kind: 'assistant',
      key: `assistant:${turn.runId}`,
      turn,
    })
  }

  return entries
}
