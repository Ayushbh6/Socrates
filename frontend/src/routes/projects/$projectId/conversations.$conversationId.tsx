import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Send, Paperclip, X, Brain } from 'lucide-react'
import { apiFetch } from '../../../lib/api'
import { useAgentStream } from '../../../hooks/useAgentStream'
import type {
  Message,
  Asset,
  SendMessageResponse,
  WsEvent,
  ThinkingLevel,
} from '../../../types/api'

export const Route = createFileRoute('/projects/$projectId/conversations/$conversationId')({
  component: ConversationPage,
})

interface SendForm {
  content_text: string
}

interface OptimisticMessage {
  id: string
  role: 'user' | 'assistant'
  content_text: string | null
  thinking_text: string | null
  status: 'queued' | 'completed' | 'failed' | 'streaming'
  assets: Asset[]
  sequence_no: number
}

function ConversationPage() {
  const { projectId, conversationId } = Route.useParams()
  const qc = useQueryClient()
  const bottomRef = useRef<HTMLDivElement>(null)

  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [pendingAssets, setPendingAssets] = useState<Asset[]>([])
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>('off')
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([])
  const [streamingContent, setStreamingContent] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const { register, handleSubmit, reset, watch, formState: { isSubmitting } } = useForm<SendForm>()
  const inputValue = watch('content_text', '')

  // Fetch persisted message history
  const { data: messages = [] } = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => apiFetch<Message[]>(`/conversations/${conversationId}/messages`),
  })

  // Auto-scroll on new content
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, optimistic, streamingContent])

  // Handle incoming WebSocket events
  const handleWsEvent = useCallback((event: WsEvent) => {
    if (event.type === 'run.content.delta') {
      setStreamingContent((prev) => prev + event.delta)
    } else if (event.type === 'run.thinking.delta') {
      setStreamingThinking((prev) => prev + event.delta)
    } else if (event.type === 'run.message.completed') {
      // Replace optimistic assistant bubble with real message
      setOptimistic((prev) => prev.filter((m) => m.role !== 'assistant'))
      setStreamingContent('')
      setStreamingThinking('')
      qc.invalidateQueries({ queryKey: ['messages', conversationId] })
    } else if (event.type === 'run.completed') {
      setActiveRunId(null)
      qc.invalidateQueries({ queryKey: ['messages', conversationId] })
    } else if (event.type === 'run.failed') {
      setOptimistic((prev) =>
        prev.map((m) =>
          m.role === 'assistant' ? { ...m, status: 'failed', content_text: event.error } : m,
        ),
      )
      setActiveRunId(null)
      setStreamingContent('')
      setStreamingThinking('')
    }
  }, [conversationId, qc])

  useAgentStream({
    runId: activeRunId,
    onEvent: handleWsEvent,
  })

  // Upload image asset
  const uploadAsset = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch(`/api/v1/projects/${projectId}/assets`, { method: 'POST', body: form })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error((body as { detail?: string }).detail ?? `Upload failed`)
      }
      return res.json() as Promise<Asset>
    },
    onSuccess: (asset) => setPendingAssets((prev) => [...prev, asset]),
  })

  // Send message
  const sendMessage = useMutation({
    mutationFn: (data: SendForm) =>
      apiFetch<SendMessageResponse>(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          thinking_level: thinkingLevel,
          input_mode: 'text',
          content_text: data.content_text,
          asset_ids: pendingAssets.map((a) => a.id),
        }),
      }),
    onSuccess: (res) => {
      setActiveRunId(res.agent_run_id)
      // Seed optimistic assistant bubble
      setOptimistic((prev) => [
        ...prev,
        {
          id: `opt-assistant-${res.agent_run_id}`,
          role: 'assistant',
          content_text: null,
          thinking_text: null,
          status: 'streaming',
          assets: [],
          sequence_no: 9999,
        },
      ])
      setPendingAssets([])
      reset()
    },
  })

  const onSubmit = (data: SendForm) => {
    if (!data.content_text.trim() && pendingAssets.length === 0) return
    // Optimistic user message
    setOptimistic((prev) => [
      ...prev,
      {
        id: `opt-user-${Date.now()}`,
        role: 'user',
        content_text: data.content_text,
        thinking_text: null,
        status: 'queued',
        assets: pendingAssets,
        sequence_no: 9998,
      },
    ])
    sendMessage.mutate(data)
  }

  // Merge persisted + optimistic, de-duplicate by id
  const persistedIds = new Set(messages.map((m) => m.id))
  const visibleOptimistic = optimistic.filter((m) => !persistedIds.has(m.id))
  const allMessages = [...messages, ...visibleOptimistic]

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6">
        {allMessages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center pt-16">
            <p className="font-serif text-2xl font-semibold text-[var(--color-accent)] mb-2">Socrates</p>
            <p className="text-sm text-[var(--color-muted)] max-w-xs">
              Ask a question, share an image, or start a line of inquiry.
            </p>
          </div>
        )}

        {allMessages.map((msg) => (
          <MessageBubble
            key={msg.id}
            message={msg}
            streamingContent={msg.role === 'assistant' && (msg as OptimisticMessage).status === 'streaming' ? streamingContent : undefined}
            streamingThinking={msg.role === 'assistant' && (msg as OptimisticMessage).status === 'streaming' ? streamingThinking : undefined}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Pending assets */}
      {pendingAssets.length > 0 && (
        <div className="flex gap-2 px-6 pb-2">
          {pendingAssets.map((asset) => (
            <div key={asset.id} className="relative flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-text)]">
              <Paperclip size={11} className="text-[var(--color-muted)]" />
              <span className="max-w-[120px] truncate">{asset.original_name}</span>
              <button
                onClick={() => setPendingAssets((prev) => prev.filter((a) => a.id !== asset.id))}
                className="ml-1 text-[var(--color-muted)] hover:text-[var(--color-error)]"
              >
                <X size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Composer */}
      <div className="border-t border-[var(--color-border)] bg-[var(--color-base)] px-6 py-4">
        <form onSubmit={handleSubmit(onSubmit)} className="relative flex items-end gap-2">
          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) uploadAsset.mutate(file)
              e.target.value = ''
            }}
          />

          {/* Attach button */}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadAsset.isPending}
            className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-accent)] disabled:opacity-40"
            title="Attach image"
          >
            <Paperclip size={16} />
          </button>

          {/* Thinking toggle */}
          <button
            type="button"
            onClick={() => setThinkingLevel((prev) => prev === 'off' ? 'low' : 'off')}
            className={`mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] transition-colors ${
              thinkingLevel !== 'off'
                ? 'bg-[var(--color-accent-ghost)] text-[var(--color-accent)]'
                : 'text-[var(--color-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-accent)]'
            }`}
            title={thinkingLevel !== 'off' ? 'Thinking on' : 'Thinking off'}
          >
            <Brain size={16} />
          </button>

          {/* Text input */}
          <textarea
            placeholder="Ask Socrates…"
            rows={1}
            className="flex-1 resize-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-placeholder)] outline-none focus:border-[var(--color-accent-mid)] focus:ring-2 focus:ring-[var(--color-accent-ghost)] transition-all max-h-40 overflow-y-auto"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit(onSubmit)()
              }
            }}
            {...register('content_text')}
          />

          {/* Send button */}
          <button
            type="submit"
            disabled={isSubmitting || sendMessage.isPending || (!inputValue?.trim() && pendingAssets.length === 0)}
            className="mb-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--color-accent)] text-white transition-colors hover:bg-[var(--color-accent-mid)] disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Send size={14} />
          </button>
        </form>
      </div>
    </div>
  )
}

// ── Message bubble ─────────────────────────────────────────────────────────────

interface MessageBubbleProps {
  message: Message | OptimisticMessage
  streamingContent?: string
  streamingThinking?: string
}

function MessageBubble({ message, streamingContent, streamingThinking }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isStreaming = (message as OptimisticMessage).status === 'streaming'
  const displayContent = isStreaming ? streamingContent ?? '' : message.content_text ?? ''
  const displayThinking = isStreaming ? streamingThinking ?? '' : message.thinking_text ?? ''

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[75%] ${isUser ? 'max-w-[60%]' : 'max-w-[80%]'}`}>
        {/* Thinking block */}
        {displayThinking && (
          <div className="mb-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-[var(--color-muted)]">
              <Brain size={10} />
              Thinking
            </p>
            <p className="text-xs leading-relaxed text-[var(--color-muted)] whitespace-pre-wrap">{displayThinking}</p>
          </div>
        )}

        {/* Attached assets */}
        {message.assets?.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.assets.map((asset) => (
              <div key={asset.id} className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs text-[var(--color-muted)]">
                <Paperclip size={11} />
                <span className="max-w-[100px] truncate">{asset.original_name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Content bubble */}
        <div
          className={`rounded-[var(--radius-lg)] px-4 py-3 text-sm leading-relaxed ${
            isUser
              ? 'bg-[var(--color-accent)] text-white'
              : 'bg-[var(--color-surface)] text-[var(--color-text)]'
          }`}
        >
          {displayContent ? (
            <p className="whitespace-pre-wrap">{displayContent}</p>
          ) : isStreaming ? (
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-50" />
          ) : (
            <p className="text-[var(--color-muted)] italic text-xs">
              {(message as OptimisticMessage).status === 'failed' ? 'Failed to respond.' : '…'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
