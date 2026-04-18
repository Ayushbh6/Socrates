import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useWatch } from 'react-hook-form'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Brain, LoaderCircle, Paperclip, Send, Sparkles, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { apiFetch } from '@/lib/api'
import { useAgentStream } from '@/hooks/useAgentStream'
import type {
  Asset,
  Message,
  SendMessageResponse,
  ThinkingLevel,
  WsEvent,
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

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isSubmitting },
  } = useForm<SendForm>()
  const inputValue = useWatch({ control, name: 'content_text', defaultValue: '' })

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
      <div className="border-b border-sage-strong/80 bg-paper/70 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-moss">
              Conversation
            </p>
            <h2 className="font-display text-3xl leading-none tracking-tight text-forest">
              Socratic exchange
            </h2>
          </div>
          <div className="hidden items-center gap-2 rounded-full border border-sage-strong bg-white/80 px-4 py-2 text-sm text-ink-soft md:flex">
            <Sparkles className="size-4 text-moss" />
            Streaming answers stay grounded in this project.
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-6 overflow-y-auto px-6 py-6">
        {allMessages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 pt-16 text-center">
            <p className="font-display text-4xl text-forest">Socrates</p>
            <p className="max-w-xs text-sm leading-6 text-ink-soft">
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

      {pendingAssets.length > 0 && (
        <div className="flex flex-wrap gap-2 px-6 pb-2">
          {pendingAssets.map((asset) => (
            <div
              key={asset.id}
              className="relative flex items-center gap-1.5 rounded-full border border-sage-strong bg-sage/50 px-3 py-1.5 text-xs text-ink"
            >
              <Paperclip className="size-3.5 text-ink-soft" />
              <span className="max-w-[120px] truncate">{asset.original_name}</span>
              <button
                onClick={() => setPendingAssets((prev) => prev.filter((a) => a.id !== asset.id))}
                className="ml-1 text-ink-soft transition hover:text-forest"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-sage-strong/80 bg-paper/85 px-6 py-4">
        <form onSubmit={handleSubmit(onSubmit)} className="flex items-end gap-3">
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

          <Button
            type="button"
            size="icon"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadAsset.isPending}
            className="size-11 shrink-0 rounded-full border-sage-strong bg-white text-ink-soft shadow-none hover:bg-sage hover:text-forest"
            title="Attach image"
          >
            {uploadAsset.isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <Paperclip />
            )}
          </Button>

          <Button
            type="button"
            size="icon"
            variant={thinkingLevel !== 'off' ? 'secondary' : 'outline'}
            onClick={() => setThinkingLevel((prev) => prev === 'off' ? 'low' : 'off')}
            className={thinkingLevel !== 'off'
              ? 'size-11 shrink-0 rounded-full bg-sage text-forest hover:bg-sage'
              : 'size-11 shrink-0 rounded-full border-sage-strong bg-white text-ink-soft shadow-none hover:bg-sage hover:text-forest'}
            title={thinkingLevel !== 'off' ? 'Thinking on' : 'Thinking off'}
          >
            <Brain />
          </Button>

          <Textarea
            placeholder="Ask Socrates…"
            rows={1}
            className="min-h-[3.25rem] max-h-40 flex-1 resize-none rounded-[1.5rem] border border-sage-strong bg-white px-4 py-3 text-sm text-ink outline-none transition focus:border-moss/50 focus:ring-3 focus:ring-ring/20"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSubmit(onSubmit)()
              }
            }}
            {...register('content_text')}
          />

          <Button
            type="submit"
            size="icon"
            disabled={isSubmitting || sendMessage.isPending || (!inputValue?.trim() && pendingAssets.length === 0)}
            className="size-11 shrink-0 rounded-full bg-forest text-white hover:bg-forest/92"
          >
            {sendMessage.isPending ? <LoaderCircle className="animate-spin" /> : <Send />}
          </Button>
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
        {displayThinking && (
          <div className="mb-2 rounded-[1.25rem] border border-sage-strong bg-sage/45 px-4 py-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.24em] text-moss">
              <Brain className="size-3" />
              Thinking
            </p>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
              {displayThinking}
            </p>
          </div>
        )}

        {message.assets?.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {message.assets.map((asset) => (
              <div
                key={asset.id}
                className="flex items-center gap-1.5 rounded-full border border-sage-strong bg-sage/45 px-3 py-1.5 text-xs text-ink-soft"
              >
                <Paperclip className="size-3.5" />
                <span className="max-w-[100px] truncate">{asset.original_name}</span>
              </div>
            ))}
          </div>
        )}

        <div
          className={`rounded-[1.5rem] px-4 py-3 text-sm leading-7 shadow-[0_12px_30px_rgba(62,92,72,0.05)] ${
            isUser
              ? 'bg-forest text-white'
              : 'border border-sage-strong/80 bg-paper text-ink'
          }`}
        >
          {displayContent ? (
            <p className="whitespace-pre-wrap">{displayContent}</p>
          ) : isStreaming ? (
            <span className="inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-50" />
          ) : (
            <p className="text-xs italic text-ink-soft">
              {(message as OptimisticMessage).status === 'failed' ? 'Failed to respond.' : '…'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
