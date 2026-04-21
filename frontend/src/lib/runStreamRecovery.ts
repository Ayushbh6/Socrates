import type { QueryClient } from '@tanstack/react-query'

import { apiFetch } from './api'
import type { AgentRun, Message } from '@/types/api'

interface ReconcileRunMessagesOptions {
  conversationId: string
  runId: string
  queryClient: QueryClient
  fetchMessages?: (conversationId: string) => Promise<Message[]>
}

interface RecoverClosedRunOptions extends ReconcileRunMessagesOptions {
  attempts?: number
  delayMs?: number
  fetchRun?: (runId: string) => Promise<AgentRun>
  sleep?: (ms: number) => Promise<void>
}

export interface RunStreamRecoveryResult {
  run: AgentRun | null
  messages: Message[]
  persistedAssistant: Message | null
}

const DEFAULT_RECOVERY_ATTEMPTS = 5
const DEFAULT_RECOVERY_DELAY_MS = 250

function sortMessages(messages: Message[]) {
  return [...messages].sort((left, right) => left.sequence_no - right.sequence_no)
}

async function defaultFetchMessages(conversationId: string) {
  return apiFetch<Message[]>(`/conversations/${conversationId}/messages`)
}

async function defaultFetchRun(runId: string) {
  return apiFetch<AgentRun>(`/agent-runs/${runId}`)
}

async function defaultSleep(ms: number) {
  await new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function findPersistedAssistantMessageForRun(messages: Message[], runId: string) {
  return messages.find((message) => message.role === 'assistant' && message.agent_run_id === runId) ?? null
}

export async function reconcileRunMessagesFromServer({
  conversationId,
  runId,
  queryClient,
  fetchMessages = defaultFetchMessages,
}: ReconcileRunMessagesOptions): Promise<RunStreamRecoveryResult> {
  const messages = sortMessages(await fetchMessages(conversationId))
  queryClient.setQueryData<Message[]>(['messages', conversationId], messages)

  return {
    run: null,
    messages,
    persistedAssistant: findPersistedAssistantMessageForRun(messages, runId),
  }
}

export async function recoverClosedRun({
  conversationId,
  runId,
  queryClient,
  attempts = DEFAULT_RECOVERY_ATTEMPTS,
  delayMs = DEFAULT_RECOVERY_DELAY_MS,
  fetchMessages = defaultFetchMessages,
  fetchRun = defaultFetchRun,
  sleep = defaultSleep,
}: RecoverClosedRunOptions): Promise<RunStreamRecoveryResult> {
  let latestRun: AgentRun | null = null
  let latestMessages: Message[] = []
  let persistedAssistant: Message | null = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    latestRun = await fetchRun(runId).catch(() => latestRun)

    const reconciliation = await reconcileRunMessagesFromServer({
      conversationId,
      runId,
      queryClient,
      fetchMessages,
    }).catch(() => null)

    if (reconciliation) {
      latestMessages = reconciliation.messages
      persistedAssistant = reconciliation.persistedAssistant
    }

    if (persistedAssistant) {
      return { run: latestRun, messages: latestMessages, persistedAssistant }
    }

    if (latestRun?.status === 'failed') {
      return { run: latestRun, messages: latestMessages, persistedAssistant: null }
    }

    if (attempt < attempts - 1) {
      await sleep(delayMs)
    }
  }

  return {
    run: latestRun,
    messages: latestMessages,
    persistedAssistant,
  }
}
