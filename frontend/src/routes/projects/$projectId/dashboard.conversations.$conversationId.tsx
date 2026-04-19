import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm, useWatch } from 'react-hook-form'
import {
  Brain,
  ChevronDown,
  ChevronRight,
  LoaderCircle,
  Paperclip,
  Send,
  X,
} from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'

import {
  DEFAULT_MODEL_ID,
  DEFAULT_THINKING_LEVEL,
  getModelsForProvider,
  getProviderForModel,
  getThinkingOptionsForModel,
  normalizeThinkingLevelForModel,
  PROVIDER_OPTIONS,
  type ProviderId,
} from '@/config/models'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useAgentStream } from '@/hooks/useAgentStream'
import { apiFetch } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'
import type {
  Asset,
  Conversation,
  Message,
  SendMessageResponse,
  ThinkingLevel,
  WsEvent,
} from '@/types/api'

export const Route = createFileRoute('/projects/$projectId/dashboard/conversations/$conversationId')({
  component: ConversationSessionPage,
})

interface SendForm {
  content_text: string
}

interface ConversationUpdatePayload {
  model: string
  thinking_level: ThinkingLevel
}

interface OptimisticMessage {
  id: string
  role: 'user' | 'assistant'
  content_text: string | null
  thinking_text: string | null
  status: 'queued' | 'completed' | 'failed' | 'streaming'
  assets: Asset[]
  sequence_no: number
  thinking_enabled?: boolean
  agent_run_id?: string | null
}

function deriveInitialConversationTitle(content: string) {
  const trimmed = content.trim()
  if (!trimmed) {
    return 'New conversation'
  }
  const firstWord = trimmed.split(/\s+/)[0] ?? 'New conversation'
  return firstWord.length > 5 ? `${firstWord.slice(0, 5)}...` : firstWord
}

function ConversationSessionPage() {
  const { projectId, conversationId } = Route.useParams()
  const queryClient = useQueryClient()
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectionVersionRef = useRef(0)
  const setActiveConversation = useAppStore((state) => state.setActiveConversation)

  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [pendingAssets, setPendingAssets] = useState<Asset[]>([])
  const [pendingSelection, setPendingSelection] = useState<ConversationUpdatePayload | null>(null)
  const [optimistic, setOptimistic] = useState<OptimisticMessage[]>([])
  const [streamingContent, setStreamingContent] = useState('')
  const [streamingThinking, setStreamingThinking] = useState('')

  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isSubmitting },
  } = useForm<SendForm>({
    defaultValues: {
      content_text: '',
    },
  })

  const inputValue = useWatch({ control, name: 'content_text', defaultValue: '' })

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => apiFetch<Conversation[]>(`/projects/${projectId}/conversations`),
  })

  const { data: messages = [] } = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => apiFetch<Message[]>(`/conversations/${conversationId}/messages`),
  })

  const conversation = useMemo(
    () => conversations.find((entry) => entry.id === conversationId) ?? null,
    [conversationId, conversations],
  )

  const persistedModel = conversation?.model || DEFAULT_MODEL_ID
  const persistedThinking = normalizeThinkingLevelForModel(
    persistedModel,
    conversation?.thinking_level || DEFAULT_THINKING_LEVEL,
  )
  const selectedModel = pendingSelection?.model ?? persistedModel
  const selectedThinking = pendingSelection?.thinking_level ?? persistedThinking
  const selectedProvider = getProviderForModel(selectedModel)

  const syncConversationCache = useCallback(
    (updated: Conversation) => {
      queryClient.setQueryData<Conversation[]>(['conversations', projectId], (current) => {
        if (!current) {
          return [updated]
        }

        return current.map((entry) => (entry.id === updated.id ? updated : entry))
      })
      setActiveConversation(updated)
    },
    [projectId, queryClient, setActiveConversation],
  )

  useEffect(() => {
    setActiveConversation(conversation)
  }, [conversation, setActiveConversation])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, optimistic, streamingContent, streamingThinking])

  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === 'run.content.delta') {
        setStreamingContent((previous) => previous + event.delta)
        return
      }

      if (event.type === 'run.thinking.delta') {
        setStreamingThinking((previous) => previous + event.delta)
        return
      }

      if (event.type === 'run.message.completed') {
        queryClient.setQueryData<Message[]>(['messages', conversationId], (current) => {
          const next = current ? current.filter((message) => message.id !== event.message.id) : []
          return [...next, event.message].sort((left, right) => left.sequence_no - right.sequence_no)
        })
        setOptimistic((previous) => previous.filter((message) => message.role !== 'assistant'))
        setStreamingContent('')
        setStreamingThinking('')
        queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
        return
      }

      if (event.type === 'run.completed') {
        setActiveRunId(null)
        queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
        queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
        return
      }

      if (event.type === 'run.failed') {
        setOptimistic((previous) =>
          previous.map((message) =>
            message.role === 'assistant'
              ? { ...message, status: 'failed', content_text: event.error }
              : message,
          ),
        )
        setActiveRunId(null)
        setStreamingContent('')
        setStreamingThinking('')
      }
    },
    [conversationId, projectId, queryClient],
  )

  useAgentStream({
    runId: activeRunId,
    onEvent: handleWsEvent,
  })

  const uploadAsset = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)

      const response = await fetch(`/api/v1/projects/${projectId}/assets`, {
        method: 'POST',
        body: form,
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}))
        throw new Error((payload as { detail?: string }).detail ?? 'Upload failed.')
      }

      return response.json() as Promise<Asset>
    },
    onSuccess: (asset) => {
      setPendingAssets((previous) => [...previous, asset])
      queryClient.invalidateQueries({ queryKey: ['assets', projectId] })
    },
  })

  const updateConversationPreferences = useMutation({
    mutationFn: (payload: ConversationUpdatePayload) =>
      apiFetch<Conversation>(`/conversations/${conversationId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
  })

  const applyConversationSelection = useCallback(
    (model: string, thinking: ThinkingLevel) => {
      const normalizedThinking = normalizeThinkingLevelForModel(model, thinking)
      const version = selectionVersionRef.current + 1

      selectionVersionRef.current = version
      setPendingSelection({ model, thinking_level: normalizedThinking })

      updateConversationPreferences.mutate(
        { model, thinking_level: normalizedThinking },
        {
          onSuccess: (updated) => {
            if (selectionVersionRef.current !== version) {
              return
            }

            setPendingSelection(null)
            syncConversationCache(updated)
          },
          onError: () => {
            if (selectionVersionRef.current !== version) {
              return
            }

            setPendingSelection(null)
          },
        },
      )
    },
    [syncConversationCache, updateConversationPreferences],
  )

  const sendMessage = useMutation({
    mutationFn: (data: SendForm) =>
      apiFetch<SendMessageResponse>(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          model: selectedModel,
          thinking_level: selectedThinking,
          input_mode: 'text',
          content_text: data.content_text,
          asset_ids: pendingAssets.map((asset) => asset.id),
        }),
      }),
    onSuccess: (response) => {
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      if (conversation?.title === 'New conversation') {
        setActiveConversation({
          ...conversation,
          title: deriveInitialConversationTitle(inputValue),
        })
      }
      setActiveRunId(response.agent_run_id)
      setOptimistic((previous) => [
        ...previous,
        {
          id: `opt-assistant-${response.agent_run_id}`,
          role: 'assistant',
          content_text: null,
          thinking_text: null,
          status: 'streaming',
          assets: [],
          sequence_no: 9999,
          thinking_enabled: selectedThinking !== 'off',
          agent_run_id: response.agent_run_id,
        },
      ])
      setPendingAssets([])
      reset()
    },
  })

  const onSubmit = (data: SendForm) => {
    if (!data.content_text.trim()) {
      return
    }

    const optimisticUserId = `opt-user-${Date.now()}`

    setOptimistic((previous) => [
      ...previous,
      {
        id: optimisticUserId,
        role: 'user',
        content_text: data.content_text,
        thinking_text: null,
        status: 'queued',
        assets: pendingAssets,
        sequence_no: 9998,
      },
    ])

    sendMessage.mutate(data, {
      onSuccess: (response) => {
        setOptimistic((previous) =>
          previous.map((message) =>
            message.id === optimisticUserId
              ? { ...message, id: response.message_id, status: 'completed' }
              : message,
          ),
        )
      },
      onError: () => {
        setOptimistic((previous) => previous.filter((message) => message.id !== optimisticUserId))
      },
    })
  }

  const persistedIds = new Set(messages.map((message) => message.id))
  const visibleOptimistic = optimistic.filter((message) => !persistedIds.has(message.id))
  const allMessages = [...messages, ...visibleOptimistic]
  const hasConversationStarted = allMessages.length > 0 || activeRunId !== null
  const preferenceError =
    updateConversationPreferences.error instanceof Error
      ? updateConversationPreferences.error.message
      : null

  return (
    <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-canvas">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex-1 overflow-y-auto overscroll-contain">
          <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 pb-[8.75rem] pt-4 sm:px-6 sm:pb-[10.5rem] sm:pt-6 lg:px-8">
            {hasConversationStarted ? (
              <div className="flex flex-1 flex-col gap-5 pb-8 pt-2 sm:gap-6">
                {allMessages.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    streamingContent={
                      message.role === 'assistant' &&
                      (message as OptimisticMessage).status === 'streaming'
                        ? streamingContent
                        : undefined
                    }
                    streamingThinking={
                      message.role === 'assistant' &&
                      (message as OptimisticMessage).status === 'streaming'
                        ? streamingThinking
                        : undefined
                    }
                    streamingThinkingEnabled={
                      message.role === 'assistant' &&
                      (message as OptimisticMessage).status === 'streaming'
                        ? Boolean((message as OptimisticMessage).thinking_enabled)
                        : undefined
                    }
                  />
                ))}
                <div ref={bottomRef} className="h-px w-full" />
              </div>
            ) : (
              <div className="flex flex-1 items-center justify-center py-8 sm:py-12">
                <div className="flex max-w-2xl flex-col items-center gap-4 text-center">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.28em] text-moss">
                    New session
                  </p>
                  <h1 className="font-display text-[clamp(2.4rem,7vw,4.5rem)] leading-[0.94] tracking-tight text-forest">
                    Where shall we begin?
                  </h1>
                  <p className="max-w-xl text-sm leading-7 text-ink-soft sm:text-base sm:leading-8">
                    Start with a question, a draft thought, or an image. The conversation stays
                    centered here while the composer remains anchored below.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="pointer-events-none fixed inset-x-0 bottom-0 z-20 bg-canvas px-2 pb-[calc(env(safe-area-inset-bottom)+0.85rem)] pt-3 sm:px-4 sm:pb-5">
          <div className="pointer-events-auto mx-auto w-full max-w-4xl">
            <ConversationComposer
              compact
              register={register}
              handleSubmit={handleSubmit}
              onSubmit={onSubmit}
              inputValue={inputValue}
              isSubmitting={isSubmitting}
              sendPending={sendMessage.isPending}
              uploadPending={uploadAsset.isPending}
              pendingAssets={pendingAssets}
              setPendingAssets={setPendingAssets}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              selectedThinking={selectedThinking}
              onProviderChange={(provider) => {
                const nextModel = getModelsForProvider(provider)[0]?.id ?? DEFAULT_MODEL_ID
                applyConversationSelection(nextModel, selectedThinking)
              }}
              onModelChange={(model) => applyConversationSelection(model, selectedThinking)}
              onThinkingChange={(thinking) => applyConversationSelection(selectedModel, thinking)}
              settingsPending={updateConversationPreferences.isPending}
              settingsError={preferenceError}
              fileInputRef={fileInputRef}
              onFileSelect={(file) => uploadAsset.mutate(file)}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

interface ComposerProps {
  compact?: boolean
  register: ReturnType<typeof useForm<SendForm>>['register']
  handleSubmit: ReturnType<typeof useForm<SendForm>>['handleSubmit']
  onSubmit: (data: SendForm) => void
  inputValue: string
  isSubmitting: boolean
  sendPending: boolean
  uploadPending: boolean
  pendingAssets: Asset[]
  setPendingAssets: Dispatch<SetStateAction<Asset[]>>
  selectedProvider: ProviderId
  selectedModel: string
  selectedThinking: ThinkingLevel
  onProviderChange: (provider: ProviderId) => void
  onModelChange: (model: string) => void
  onThinkingChange: (thinking: ThinkingLevel) => void
  settingsPending: boolean
  settingsError: string | null
  fileInputRef: RefObject<HTMLInputElement | null>
  onFileSelect: (file: File) => void
}

function ConversationComposer({
  compact = false,
  register,
  handleSubmit,
  onSubmit,
  inputValue,
  isSubmitting,
  sendPending,
  uploadPending,
  pendingAssets,
  setPendingAssets,
  selectedProvider,
  selectedModel,
  selectedThinking,
  onProviderChange,
  onModelChange,
  onThinkingChange,
  settingsPending,
  settingsError,
  fileInputRef,
  onFileSelect,
}: ComposerProps) {
  const modelOptions = getModelsForProvider(selectedProvider)
  const thinkingOptions = getThinkingOptionsForModel(selectedModel)

  return (
    <div
      className={compact
        ? 'bg-transparent px-0 py-0 shadow-none sm:px-0 sm:py-0'
        : 'rounded-[1.8rem] bg-paper/94 px-4 py-4 shadow-[0_28px_80px_rgba(62,92,72,0.12)] sm:rounded-[2.25rem] sm:px-5 sm:py-5'}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              onFileSelect(file)
            }
            event.target.value = ''
          }}
        />

        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <ComposerSelect
            compact={compact}
            label="Provider"
            value={selectedProvider}
            onChange={(value) => onProviderChange(value as ProviderId)}
            options={PROVIDER_OPTIONS.map((provider) => ({ value: provider.id, label: provider.label }))}
          />
          <ComposerSelect
            compact={compact}
            label="Model"
            value={selectedModel}
            onChange={onModelChange}
            options={modelOptions.map((model) => ({ value: model.id, label: model.label }))}
          />
          <ComposerSelect
            compact={compact}
            label="Thinking"
            value={selectedThinking}
            onChange={(value) => onThinkingChange(value as ThinkingLevel)}
            options={thinkingOptions.map((option) => ({ value: option.value, label: option.label }))}
          />
          <div className="ml-auto shrink-0 whitespace-nowrap pr-1 text-[11px] text-ink-soft">
            {settingsPending ? 'Saving selection…' : null}
          </div>
        </div>

        {settingsError ? <p className="text-sm text-red-600">{settingsError}</p> : null}

        {pendingAssets.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {pendingAssets.map((asset) => (
              <div
                key={asset.id}
                className="flex items-center gap-1.5 rounded-full bg-white/78 px-3 py-1.5 text-xs text-ink"
              >
                <Paperclip className="size-3.5 text-ink-soft" />
                <span className="max-w-[160px] truncate">{asset.original_name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setPendingAssets((previous) => previous.filter((entry) => entry.id !== asset.id))
                  }
                  className="text-ink-soft transition hover:text-forest"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2 sm:gap-3">
          <Textarea
            rows={1}
            placeholder="Ask Socrates..."
            className={compact
              ? 'field-sizing-fixed min-h-[3rem] max-h-32 flex-1 resize-none rounded-[1.45rem] border-0 bg-white/82 px-4 py-[0.95rem] text-sm text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/20 sm:min-h-[3.2rem] sm:rounded-[1.65rem]'
              : 'field-sizing-fixed min-h-[7.25rem] flex-1 resize-none rounded-[1.5rem] border-0 bg-white/80 px-4 py-3 text-base text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/20 sm:min-h-[9.5rem] sm:rounded-[1.8rem] sm:px-5 sm:py-4'}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                handleSubmit(onSubmit)()
              }
            }}
            {...register('content_text')}
          />

          <div className="flex shrink-0 items-center gap-2 pb-1">
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadPending}
              className="size-10 rounded-full border-0 bg-white/82 text-ink-soft shadow-none hover:bg-sage hover:text-forest sm:size-11"
              title="Attach image"
            >
              {uploadPending ? <LoaderCircle className="animate-spin" /> : <Paperclip />}
            </Button>

            <Button
              type="button"
              size="icon"
              variant={selectedThinking !== 'off' ? 'secondary' : 'outline'}
              onClick={() => onThinkingChange(selectedThinking === 'off' ? 'low' : 'off')}
              className={
                selectedThinking !== 'off'
                  ? 'size-10 rounded-full bg-sage text-forest hover:bg-sage sm:size-11'
                  : 'size-10 rounded-full border-0 bg-white/82 text-ink-soft shadow-none hover:bg-sage hover:text-forest sm:size-11'
              }
              title={selectedThinking !== 'off' ? 'Thinking on' : 'Thinking off'}
            >
              <Brain />
            </Button>

            <Button
              type="submit"
              size="icon"
              disabled={isSubmitting || sendPending || !inputValue?.trim()}
              className="size-10 rounded-full bg-forest text-white hover:bg-forest/92 sm:size-11"
            >
              {sendPending ? <LoaderCircle className="animate-spin" /> : <Send />}
            </Button>
          </div>
        </div>
      </form>
    </div>
  )
}

interface ComposerSelectProps {
  compact?: boolean
  label: string
  value: string
  onChange: (value: string) => void
  options: Array<{ value: string; label: string }>
}

function ComposerSelect({ compact = false, label, value, onChange, options }: ComposerSelectProps) {
  return (
    <label className={compact ? 'relative min-w-[116px] shrink-0' : 'relative w-full sm:min-w-[140px] sm:flex-1 lg:flex-none'}>
      {compact ? null : (
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.22em] text-moss">
          {label}
        </span>
      )}
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={compact
          ? 'h-9 w-full appearance-none rounded-full border-0 bg-white/82 px-3.5 pr-8 text-xs text-ink outline-none transition focus:bg-white'
          : 'h-11 w-full appearance-none rounded-full border border-sage-strong bg-white/86 px-4 pr-10 text-sm text-ink outline-none transition focus:border-forest'}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className={compact
          ? 'pointer-events-none absolute right-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-soft'
          : 'pointer-events-none absolute right-4 top-[2.35rem] size-4 text-ink-soft'}
      />
    </label>
  )
}

const assistantMarkdownComponents: Components = {
  p: ({ children, ...props }) => (
    <p className="mb-3 last:mb-0 leading-7" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-7" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-forest" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      className="font-medium text-teal-dim underline decoration-teal-dim/40 underline-offset-2 transition hover:text-forest"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = Boolean(className?.includes('language-'))
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code
        className="rounded-md bg-sage/45 px-1.5 py-0.5 font-mono text-[0.9em] text-ink"
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ children, ...props }) => (
    <pre
      className="mb-3 overflow-x-auto rounded-[1rem] border border-sage-strong/60 bg-paper/90 p-4 text-[13px] leading-6 last:mb-0"
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="mb-3 border-l-4 border-moss/50 pl-4 text-ink-soft italic last:mb-0"
      {...props}
    >
      {children}
    </blockquote>
  ),
  h1: ({ children, ...props }) => (
    <h3 className="mb-2 font-display text-xl tracking-tight text-forest" {...props}>
      {children}
    </h3>
  ),
  h2: ({ children, ...props }) => (
    <h3 className="mb-2 font-display text-lg tracking-tight text-forest" {...props}>
      {children}
    </h3>
  ),
  h3: ({ children, ...props }) => (
    <h3 className="mb-2 font-display text-base tracking-tight text-forest" {...props}>
      {children}
    </h3>
  ),
  hr: () => <hr className="my-4 border-sage-strong/60" />,
  table: ({ children, ...props }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-left text-[13px]" {...props}>
        {children}
      </table>
    </div>
  ),
  thead: ({ children, ...props }) => <thead className="bg-sage/40" {...props}>{children}</thead>,
  th: ({ children, ...props }) => (
    <th className="border border-sage-strong/60 px-3 py-2 font-semibold text-forest" {...props}>
      {children}
    </th>
  ),
  td: ({ children, ...props }) => (
    <td className="border border-sage-strong/50 px-3 py-2 text-ink-soft" {...props}>
      {children}
    </td>
  ),
}

const thinkingMarkdownComponents: Components = {
  p: ({ children, ...props }) => (
    <p className="mb-2 last:mb-0 leading-6" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-6" {...props}>
      {children}
    </li>
  ),
  strong: ({ children, ...props }) => (
    <strong className="font-semibold text-moss" {...props}>
      {children}
    </strong>
  ),
  em: ({ children, ...props }) => (
    <em className="italic" {...props}>
      {children}
    </em>
  ),
  code: ({ className, children, ...props }) => {
    const isBlock = Boolean(className?.includes('language-'))
    if (isBlock) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }
    return (
      <code
        className="rounded bg-sage/60 px-1 py-0.5 font-mono text-[0.85em] text-ink-soft"
        {...props}
      >
        {children}
      </code>
    )
  },
  pre: ({ children, ...props }) => (
    <pre
      className="mb-2 overflow-x-auto rounded-[0.75rem] border border-sage-strong/40 bg-paper/70 p-3 text-[12px] leading-5 last:mb-0"
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote className="mb-2 border-l-2 border-moss/40 pl-3 italic last:mb-0" {...props}>
      {children}
    </blockquote>
  ),
  h1: ({ children, ...props }) => (
    <h4 className="mb-1.5 font-semibold text-[13px] text-moss" {...props}>
      {children}
    </h4>
  ),
  h2: ({ children, ...props }) => (
    <h4 className="mb-1.5 font-semibold text-[13px] text-moss" {...props}>
      {children}
    </h4>
  ),
  h3: ({ children, ...props }) => (
    <h4 className="mb-1.5 font-semibold text-[13px] text-moss" {...props}>
      {children}
    </h4>
  ),
  hr: () => <hr className="my-3 border-sage-strong/40" />,
  a: ({ children, href, ...props }) => (
    <a
      href={href}
      className="font-medium text-teal-dim underline decoration-teal-dim/40 underline-offset-2 transition hover:text-forest"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
}

const THINKING_COLLAPSE_PREFIX = 'thinking-collapse:run:'

function deriveThinkingStorageKey(message: Message | OptimisticMessage): string | null {
  // Prefer the agent_run_id so the key is stable across the optimistic
  // streaming bubble and the persisted assistant message that replaces it.
  // For a brand-new optimistic bubble that doesn't yet carry a run id,
  // we won't persist (collapse state for that brief window stays in memory
  // via the same key once the run id arrives on the next render).
  const opt = message as OptimisticMessage
  const runId = opt.agent_run_id ?? (message as Message).agent_run_id ?? null
  if (runId) return `${THINKING_COLLAPSE_PREFIX}${runId}`
  return null
}

function readPersistedCollapse(storageKey: string | null): boolean {
  if (!storageKey || typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(storageKey) === '1'
  } catch {
    return false
  }
}

function writePersistedCollapse(storageKey: string | null, collapsed: boolean): void {
  if (!storageKey || typeof window === 'undefined') return
  try {
    if (collapsed) {
      window.localStorage.setItem(storageKey, '1')
    } else {
      window.localStorage.removeItem(storageKey)
    }
  } catch {
    // localStorage may be unavailable (private mode, quota); fail silently.
  }
}

interface ThinkingPanelProps {
  storageKey: string | null
  text: string
  hasThinking: boolean
  isStreaming: boolean
  statusLabel: string
}

function ThinkingPanel({ storageKey, text, hasThinking, isStreaming, statusLabel }: ThinkingPanelProps) {
  // The parent passes `storageKey` as React `key` so this component remounts
  // when the key changes (e.g. an optimistic bubble gets its agent_run_id),
  // letting this initializer read the latest persisted value without an
  // additional effect.
  const [collapsed, setCollapsed] = useState<boolean>(() => readPersistedCollapse(storageKey))

  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current
      writePersistedCollapse(storageKey, next)
      return next
    })
  }, [storageKey])

  const headerLabel = hasThinking && !isStreaming ? 'Reasoning' : 'Thinking'
  const showBody = hasThinking && !collapsed

  return (
    <div className="mb-3 rounded-[1.35rem] bg-sage/50 px-4 py-3.5 shadow-[0_10px_24px_rgba(62,92,72,0.05)]">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand reasoning' : 'Collapse reasoning'}
        className="flex w-full items-center gap-2 text-left transition hover:opacity-90"
      >
        <ThinkingOrb />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-moss">
            {headerLabel}
          </p>
          <p className="text-[11px] text-ink-soft/80">{statusLabel}</p>
        </div>
        <span
          className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-white/40 text-moss transition hover:bg-white/70"
          aria-hidden="true"
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </span>
      </button>
      {showBody ? (
        <div className="mt-3 text-[13px] leading-6 tracking-[0.01em] text-ink-soft assistant-markdown min-w-0">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={thinkingMarkdownComponents}>
            {text}
          </ReactMarkdown>
        </div>
      ) : null}
    </div>
  )
}

interface MessageBubbleProps {
  message: Message | OptimisticMessage
  streamingContent?: string
  streamingThinking?: string
  streamingThinkingEnabled?: boolean
}

function MessageBubble({
  message,
  streamingContent,
  streamingThinking,
  streamingThinkingEnabled,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const isStreaming = (message as OptimisticMessage).status === 'streaming'
  const displayContent = isStreaming ? streamingContent ?? '' : message.content_text ?? ''
  const displayThinking = isStreaming ? streamingThinking ?? '' : message.thinking_text ?? ''
  const hasContent = displayContent.trim().length > 0
  const hasThinking = displayThinking.trim().length > 0
  const showStreamingStatus = isStreaming && !hasThinking && !hasContent
  const showThinkingPanel = !isUser && (hasThinking || showStreamingStatus)
  const statusLabel = streamingThinkingEnabled ? 'Socrates is thinking' : 'Socrates is responding'
  const renderAssistantAnswer = hasContent || (!isStreaming && !hasThinking)
  const thinkingStorageKey = !isUser ? deriveThinkingStorageKey(message) : null

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`w-full ${isUser ? 'sm:max-w-[68%]' : 'sm:max-w-[76%]'}`}>
        {showThinkingPanel ? (
          <ThinkingPanel
            key={thinkingStorageKey ?? message.id}
            storageKey={thinkingStorageKey}
            text={displayThinking}
            hasThinking={hasThinking}
            isStreaming={isStreaming}
            statusLabel={statusLabel}
          />
        ) : null}

        {message.assets?.length > 0 ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {message.assets.map((asset) => (
              <div
                key={asset.id}
                className="flex items-center gap-1.5 rounded-full bg-sage/40 px-3 py-1.5 text-xs text-ink-soft"
              >
                <Paperclip className="size-3.5" />
                <span className="max-w-[120px] truncate">{asset.original_name}</span>
              </div>
            ))}
          </div>
        ) : null}

        {renderAssistantAnswer ? (
          <div
            className={
              isUser
                ? 'rounded-[1.7rem] bg-forest px-5 py-4 text-sm leading-7 text-white shadow-[0_18px_40px_rgba(27,53,41,0.14)]'
                : 'rounded-[1.7rem] bg-white/88 px-5 py-4 text-sm leading-7 text-ink shadow-[0_18px_40px_rgba(62,92,72,0.08)]'
            }
          >
            {hasContent ? (
              isUser ? (
                <p className="whitespace-pre-wrap">{displayContent}</p>
              ) : (
                <div className="assistant-markdown min-w-0 text-[15px] text-ink">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={assistantMarkdownComponents}
                  >
                    {displayContent}
                  </ReactMarkdown>
                </div>
              )
            ) : (
              <p className="text-xs italic text-ink-soft">
                {(message as OptimisticMessage).status === 'failed' ? 'Failed to respond.' : '...'}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ThinkingOrb() {
  return (
    <span className="relative flex size-3 shrink-0 items-center justify-center">
      <span className="absolute size-7 rounded-full bg-[radial-gradient(circle,_rgba(143,196,170,0.72)_0%,_rgba(143,196,170,0)_72%)] blur-[6px]" />
      <span className="absolute size-4 rounded-full bg-sage/55 animate-ping [animation-duration:1.8s]" />
      <span className="relative size-2.5 rounded-full bg-forest shadow-[0_0_16px_rgba(27,53,41,0.42)]" />
    </span>
  )
}
