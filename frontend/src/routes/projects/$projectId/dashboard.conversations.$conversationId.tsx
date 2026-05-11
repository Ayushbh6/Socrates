import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm, useWatch } from 'react-hook-form'
import {
  AlertCircle,
  ArrowDown,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileSearch,
  LoaderCircle,
  Paperclip,
  Send,
  Sparkles,
  Square,
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
import {
  ArtifactWorkspacePanel,
  type ArtifactPanelMode,
} from '@/components/conversation/ArtifactWorkspacePanel'
import { WorkerTracePanel } from '@/components/conversation/WorkerTracePanel'
import { Textarea } from '@/components/ui/textarea'
import { useAgentStream, type AgentStreamConnectionState } from '@/hooks/useAgentStream'
import { useStickToBottom } from '@/hooks/useStickToBottom'
import { ApiError, apiFetch } from '@/lib/api'
import {
  decideArtifactRegistrationAutoOpen,
  decidePendingArtifactAutoOpen,
} from '@/lib/artifactAutoOpen'
import { shouldUseArtifactSheet } from '@/lib/artifactPanelLayout'
import {
  applyAssistantTurnEvent,
  attachPersistedAssistantMessage,
  createAssistantTurn,
  hydrateAssistantTurnFromRun,
  replaceAssistantTurnActivity,
  setAssistantTurnActivityHydrating,
  setAssistantTurnConnectionState,
  shouldShowAssistantTurnActivity,
  shouldShowAssistantTurnFailure,
  type AssistantTurnState,
} from '@/lib/assistantTurns'
import {
  buildConversationTimeline,
  type OptimisticUserMessage,
} from '@/lib/conversationTimeline'
import { createConversationScrollSignature } from '@/lib/conversationScroll'
import {
  getRunActivitySummary,
  hydrateRunActivity,
  type RunActivityItem,
} from '@/lib/runActivity'
import {
  applyWorkerTraceEvent,
  createWorkerTraceState,
  getActiveWorkerTraceRun,
  isTerminalWorkerTraceRun,
  isWorkerTraceEvent,
  type WorkerTraceState,
} from '@/lib/workerTrace'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'
import type {
  Asset,
  AgentRun,
  AgentRunEvent,
  Conversation,
  Message,
  SendMessageResponse,
  Task,
  TaskApproval,
  TaskArtifact,
  TaskWorkspaceFilePreview,
  TaskWorkspaceTree,
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

const ARTIFACT_PANEL_TOGGLE_EVENT = 'premchat:toggle-artifact-panel'

function isActiveRunStatus(status: AgentRun['status'] | null | undefined) {
  return status === 'queued' || status === 'running'
}

function deriveInitialConversationTitle(content: string) {
  const trimmed = content.trim()
  if (!trimmed) {
    return 'New conversation'
  }
  const firstWord = trimmed.split(/\s+/)[0] ?? 'New conversation'
  return firstWord.length > 5 ? `${firstWord.slice(0, 5)}...` : firstWord
}

function upsertConversationTask(current: Task[] | undefined, task: Task) {
  const next = [task, ...(current ?? []).filter((entry) => entry.id !== task.id)]
  return next.sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
}

function ConversationSessionPage() {
  const { projectId, conversationId } = Route.useParams()
  return (
    <ConversationSessionContent
      key={conversationId}
      projectId={projectId}
      conversationId={conversationId}
    />
  )
}

interface ConversationSessionContentProps {
  projectId: string
  conversationId: string
}

function ConversationSessionContent({
  projectId,
  conversationId,
}: ConversationSessionContentProps) {
  const queryClient = useQueryClient()
  const {
    containerRef: scrollContainerRef,
    isAtBottom,
    hasNewContent: hasUnseenBottomContent,
    scrollToBottom,
    notifyContentChanged,
  } = useStickToBottom()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const selectionVersionRef = useRef(0)
  const setActiveConversation = useAppStore((state) => state.setActiveConversation)
  const assistantTurnsRef = useRef<Record<string, AssistantTurnState>>({})
  const workerTraceRef = useRef<WorkerTraceState>(createWorkerTraceState())
  const initialArtifactPanelMode = readPersistedPanelMode(`artifact-panel:${conversationId}`, 'collapsed', ['open', 'collapsed'])
  const initialArtifactSheetMode = readArtifactSheetMode()
  const initialMobileArtifactsOpen = initialArtifactSheetMode && initialArtifactPanelMode === 'open'
  const artifactPanelModeRef = useRef<ArtifactPanelMode>(initialArtifactPanelMode)
  const artifactSheetModeRef = useRef(initialArtifactSheetMode)
  const mobileArtifactsOpenRef = useRef(initialMobileArtifactsOpen)
  const pendingAutoOpenArtifactPathRef = useRef<string | null>(null)
  const manualArtifactCollapseAfterPendingRef = useRef(false)

  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [pendingAssets, setPendingAssets] = useState<Asset[]>([])
  const [pendingSelection, setPendingSelection] = useState<ConversationUpdatePayload | null>(null)
  const [optimisticUsers, setOptimisticUsers] = useState<OptimisticUserMessage[]>([])
  const [assistantTurns, setAssistantTurns] = useState<Record<string, AssistantTurnState>>({})
  const [workerTrace, setWorkerTrace] = useState<WorkerTraceState>(() => createWorkerTraceState())
  const [workerPanelMode, setWorkerPanelMode] = useState<'open' | 'collapsed' | 'hidden'>(() =>
    readPersistedPanelMode(`worker-panel:${conversationId}`, 'collapsed', ['open', 'collapsed', 'hidden']),
  )
  const [artifactPanelMode, setArtifactPanelMode] = useState<ArtifactPanelMode>(() =>
    initialArtifactPanelMode,
  )
  const [selectedWorkspacePath, setSelectedWorkspacePath] = useState<string | null>(() =>
    readPersistedString(`artifact-selected-path:${conversationId}`),
  )
  const [artifactSheetMode, setArtifactSheetMode] = useState(initialArtifactSheetMode)
  const [mobileArtifactsOpen, setMobileArtifactsOpen] = useState(initialMobileArtifactsOpen)
  const [pendingAutoOpenArtifactPath, setPendingAutoOpenArtifactPath] = useState<string | null>(null)
  const [recentlyClosedTask, setRecentlyClosedTask] = useState<Task | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

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

  const messagesQueryFn = useCallback(
    () => apiFetch<Message[]>(`/conversations/${conversationId}/messages`),
    [conversationId],
  )

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => apiFetch<Conversation[]>(`/projects/${projectId}/conversations`),
  })

  const { data: messages = [] } = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: messagesQueryFn,
  })

  const { data: activeRun } = useQuery({
    queryKey: ['active-run', conversationId],
    queryFn: () => apiFetch<AgentRun | null>(`/conversations/${conversationId}/active-run`),
  })

  const { data: activeTask } = useQuery({
    queryKey: ['active-task', conversationId],
    queryFn: () => apiFetch<Task | null>(`/conversations/${conversationId}/active-task`),
  })

  const { data: conversationTasks = [] } = useQuery({
    queryKey: ['conversation-tasks', conversationId],
    queryFn: () => apiFetch<Task[]>(`/conversations/${conversationId}/tasks`),
  })

  const taskForSummary = activeTask ?? recentlyClosedTask ?? conversationTasks[0] ?? null

  const { data: taskApprovals = [] } = useQuery({
    queryKey: ['task-approvals', taskForSummary?.id],
    queryFn: () => apiFetch<TaskApproval[]>(`/tasks/${taskForSummary?.id}/approvals`),
    enabled: Boolean(taskForSummary?.id),
  })

  const { data: taskArtifacts = [] } = useQuery({
    queryKey: ['task-artifacts', taskForSummary?.id],
    queryFn: () => apiFetch<TaskArtifact[]>(`/tasks/${taskForSummary?.id}/artifacts`),
    enabled: Boolean(taskForSummary?.id),
  })

  const latestOutputArtifactPath = useMemo(() => {
    const latestOutput = [...taskArtifacts]
      .filter((artifact) => artifact.artifact_role === 'output')
      .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0]
    return latestOutput?.relative_path ?? null
  }, [taskArtifacts])
  const effectiveSelectedWorkspacePath = selectedWorkspacePath ?? latestOutputArtifactPath

  const { data: taskWorkspaceTree = null } = useQuery({
    queryKey: ['task-workspace-tree', taskForSummary?.id],
    queryFn: () => apiFetch<TaskWorkspaceTree>(`/tasks/${taskForSummary?.id}/workspace-tree`),
    enabled: Boolean(taskForSummary?.id),
    retry: false,
  })

  const { data: workspacePreview = null, isFetching: workspacePreviewLoading } = useQuery({
    queryKey: ['task-workspace-file', taskForSummary?.id, effectiveSelectedWorkspacePath],
    queryFn: () =>
      apiFetch<TaskWorkspaceFilePreview>(
        `/tasks/${taskForSummary?.id}/workspace-file?path=${encodeURIComponent(effectiveSelectedWorkspacePath ?? '')}`,
      ),
    enabled: Boolean(taskForSummary?.id && effectiveSelectedWorkspacePath),
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
    writePersistedString(`worker-panel:${conversationId}`, workerPanelMode)
  }, [conversationId, workerPanelMode])

  useEffect(() => {
    writePersistedString(`artifact-panel:${conversationId}`, artifactPanelMode)
  }, [artifactPanelMode, conversationId])

  useEffect(() => {
    writePersistedString(`artifact-selected-path:${conversationId}`, selectedWorkspacePath)
  }, [conversationId, selectedWorkspacePath])

  const isArtifactSheetViewport = useCallback(() => {
    return readArtifactSheetMode()
  }, [])

  const handleArtifactPanelModeChange = useCallback((mode: ArtifactPanelMode) => {
    if (mode === 'collapsed' && pendingAutoOpenArtifactPathRef.current) {
      manualArtifactCollapseAfterPendingRef.current = true
    }
    artifactPanelModeRef.current = mode
    setArtifactPanelMode(mode)
  }, [])

  const handleMobileArtifactsClose = useCallback(() => {
    if (pendingAutoOpenArtifactPathRef.current) {
      manualArtifactCollapseAfterPendingRef.current = true
    }
    mobileArtifactsOpenRef.current = false
    setMobileArtifactsOpen(false)
  }, [])

  useEffect(() => {
    assistantTurnsRef.current = assistantTurns
  }, [assistantTurns])

  useEffect(() => {
    workerTraceRef.current = workerTrace
  }, [workerTrace])

  useEffect(() => {
    artifactPanelModeRef.current = artifactPanelMode
  }, [artifactPanelMode])

  useEffect(() => {
    mobileArtifactsOpenRef.current = mobileArtifactsOpen
  }, [mobileArtifactsOpen])

  useEffect(() => {
    artifactSheetModeRef.current = artifactSheetMode
  }, [artifactSheetMode])

  useEffect(() => {
    pendingAutoOpenArtifactPathRef.current = pendingAutoOpenArtifactPath
  }, [pendingAutoOpenArtifactPath])

  useEffect(() => {
    const handleResize = () => {
      const nextSheetMode = readArtifactSheetMode()
      if (nextSheetMode === artifactSheetModeRef.current) {
        return
      }

      artifactSheetModeRef.current = nextSheetMode
      setArtifactSheetMode(nextSheetMode)

      if (nextSheetMode) {
        if (artifactPanelModeRef.current === 'open') {
          mobileArtifactsOpenRef.current = true
          setMobileArtifactsOpen(true)
        }
        return
      }

      if (mobileArtifactsOpenRef.current) {
        artifactPanelModeRef.current = 'open'
        setArtifactPanelMode('open')
        mobileArtifactsOpenRef.current = false
        setMobileArtifactsOpen(false)
      }
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    const handleArtifactPanelToggle = (event: Event) => {
      const detail = (event as CustomEvent<{ conversationId?: string }>).detail
      if (detail?.conversationId && detail.conversationId !== conversationId) {
        return
      }

      if (isArtifactSheetViewport()) {
        setMobileArtifactsOpen((current) => {
          if (current && pendingAutoOpenArtifactPathRef.current) {
            manualArtifactCollapseAfterPendingRef.current = true
          }
          mobileArtifactsOpenRef.current = !current
          return !current
        })
        return
      }

      handleArtifactPanelModeChange(artifactPanelModeRef.current === 'open' ? 'collapsed' : 'open')
    }

    window.addEventListener(ARTIFACT_PANEL_TOGGLE_EVENT, handleArtifactPanelToggle)
    return () => window.removeEventListener(ARTIFACT_PANEL_TOGGLE_EVENT, handleArtifactPanelToggle)
  }, [conversationId, handleArtifactPanelModeChange, isArtifactSheetViewport])

  useEffect(() => {
    if (!activeRun) {
      return
    }

    // React Query is the external source of truth for run snapshots; this merges it into the incremental stream buffer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAssistantTurns((previous) => ({
      ...previous,
      [activeRun.id]: hydrateAssistantTurnFromRun(activeRun, previous[activeRun.id]),
    }))
    if (isActiveRunStatus(activeRun.status)) {
      setActiveRunId(activeRun.id)
    }
  }, [activeRun])

  useEffect(() => {
    const assistantMessages = messages.filter(
      (message): message is Message => message.role === 'assistant' && Boolean(message.agent_run_id),
    )
    if (assistantMessages.length === 0) {
      return
    }

    // Persisted messages arrive from the query cache and must be attached to the local streaming turn state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAssistantTurns((previous) => {
      let next = previous
      let changed = false

      for (const message of assistantMessages) {
        const runId = message.agent_run_id
        if (!runId) {
          continue
        }
        const merged = attachPersistedAssistantMessage(next[runId], message)
        const current = next[runId]
        if (
          current?.persistedMessage?.id === merged.persistedMessage?.id &&
          current?.status === merged.status &&
          current?.responseMessageId === merged.responseMessageId
        ) {
          continue
        }
        if (!changed) {
          next = { ...next }
          changed = true
        }
        next[runId] = merged
      }

      return changed ? next : previous
    })
  }, [messages])

  const hydrateActivityForRun = useCallback(
    async (runId: string) => {
      const currentTurn = assistantTurnsRef.current[runId]
      if (currentTurn?.activity.hydrated || currentTurn?.activityHydrating) {
        return
      }

      setAssistantTurns((previous) => ({
        ...previous,
        [runId]: setAssistantTurnActivityHydrating(previous[runId], {
          runId,
          conversationId,
          hydrating: true,
        }),
      }))
      try {
        const events = await queryClient.fetchQuery({
          queryKey: ['run-events', runId],
          queryFn: () => apiFetch<AgentRunEvent[]>(`/agent-runs/${runId}/events`),
        })
        setAssistantTurns((previous) => ({
          ...previous,
          [runId]: replaceAssistantTurnActivity(previous[runId], {
            runId,
            conversationId,
            activity: hydrateRunActivity(runId, events, previous[runId]?.activity),
          }),
        }))
      } finally {
        setAssistantTurns((previous) => ({
          ...previous,
          [runId]: setAssistantTurnActivityHydrating(previous[runId], {
            runId,
            conversationId,
            hydrating: false,
          }),
        }))
      }
    },
    [conversationId, queryClient],
  )

  const handleWsEvent = useCallback(
    (event: WsEvent) => {
      if (event.type === 'run.heartbeat') {
        return
      }

      if ('run_id' in event) {
        setAssistantTurns((previous) => ({
          ...previous,
          [event.run_id]: applyAssistantTurnEvent(previous[event.run_id], event, conversationId),
        }))
      }

      if (isWorkerTraceEvent(event)) {
        setWorkerTrace((previous) => {
          const next = applyWorkerTraceEvent(previous, event)
          workerTraceRef.current = next
          return next
        })
        if (
          'task_id' in event &&
          (
            event.type === 'task.worker.tool.result' ||
            event.type === 'task.worker.todo.updated' ||
            event.type === 'task.worker.completed'
          )
        ) {
          queryClient.invalidateQueries({ queryKey: ['task-workspace-tree', event.task_id] })
          queryClient.invalidateQueries({ queryKey: ['task-artifacts', event.task_id] })
        }
      }

      if (event.type === 'run.message.completed') {
        queryClient.setQueryData<Message[]>(['messages', conversationId], (current) => {
          const next = current ? current.filter((message) => message.id !== event.message.id) : []
          return [...next, event.message].sort((left, right) => left.sequence_no - right.sequence_no)
        })
        queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
        return
      }

      if (event.type === 'run.snapshot') {
        if (event.status === 'completed') {
          queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
        }
        if (!isActiveRunStatus(event.status)) {
          queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
          setActiveRunId((current) => (current === event.run_id ? null : current))
        }
        return
      }

      if (event.type === 'task.created') {
        setRecentlyClosedTask(null)
        queryClient.setQueryData(['active-task', conversationId], event.task)
        queryClient.setQueryData<Task[]>(['conversation-tasks', conversationId], (current) =>
          upsertConversationTask(current, event.task),
        )
        queryClient.invalidateQueries({ queryKey: ['task-approvals', event.task.id] })
        queryClient.invalidateQueries({ queryKey: ['task-artifacts', event.task.id] })
        queryClient.invalidateQueries({ queryKey: ['task-workspace-tree', event.task.id] })
        return
      }

      if (event.type === 'task.approval.requested' || event.type === 'task.approval.resolved') {
        queryClient.invalidateQueries({ queryKey: ['task-approvals', event.task_id] })
        queryClient.invalidateQueries({ queryKey: ['active-task', conversationId] })
        queryClient.invalidateQueries({ queryKey: ['conversation-tasks', conversationId] })
        return
      }

      if (event.type === 'task.artifact.registered') {
        queryClient.invalidateQueries({ queryKey: ['task-artifacts', event.task_id] })
        queryClient.invalidateQueries({ queryKey: ['task-workspace-tree', event.task_id] })
        queryClient.invalidateQueries({ queryKey: ['assets', projectId] })
        const worker = getActiveWorkerTraceRun(workerTraceRef.current)
        const decision = decideArtifactRegistrationAutoOpen({
          artifactPath: event.artifact.relative_path,
          artifactPanelMode: artifactPanelModeRef.current,
          mobileArtifactsOpen: mobileArtifactsOpenRef.current,
          workerStatus: worker?.status,
          isMobileViewport: isArtifactSheetViewport(),
        })
        manualArtifactCollapseAfterPendingRef.current = false
        artifactPanelModeRef.current = decision.artifactPanelMode
        mobileArtifactsOpenRef.current = decision.mobileArtifactsOpen
        pendingAutoOpenArtifactPathRef.current = decision.pendingArtifactPath
        setSelectedWorkspacePath(decision.selectedPath)
        setArtifactPanelMode(decision.artifactPanelMode)
        setMobileArtifactsOpen(decision.mobileArtifactsOpen)
        setPendingAutoOpenArtifactPath(decision.pendingArtifactPath)
        return
      }

      if (event.type === 'task.status.updated') {
        if (event.task.status === 'completed' || event.task.status === 'failed') {
          setRecentlyClosedTask(event.task)
          queryClient.setQueryData(['active-task', conversationId], null)
        } else {
          queryClient.setQueryData(['active-task', conversationId], event.task)
        }
        queryClient.setQueryData<Task[]>(['conversation-tasks', conversationId], (current) =>
          upsertConversationTask(current, event.task),
        )
        queryClient.invalidateQueries({ queryKey: ['task-approvals', event.task_id] })
        queryClient.invalidateQueries({ queryKey: ['task-artifacts', event.task_id] })
        queryClient.invalidateQueries({ queryKey: ['task-workspace-tree', event.task_id] })
        return
      }

      if (event.type === 'run.completed') {
        setActiveRunId(null)
        const turn = assistantTurnsRef.current[event.run_id]
        if (!turn?.persistedMessage) {
          queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
        }
        queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
        queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
        return
      }

      if (event.type === 'run.failed') {
        setActiveRunId(null)
        queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
      }

      if (event.type === 'run.cancelled' || event.type === 'run.stalled') {
        setActiveRunId(null)
        queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
      }
    },
    [conversationId, isArtifactSheetViewport, projectId, queryClient],
  )

  const handleStreamConnectionChange = useCallback(
    (connectionState: AgentStreamConnectionState) => {
      if (!activeRunId) {
        return
      }

      const runId = activeRunId
      setAssistantTurns((previous) => ({
        ...previous,
        [runId]: setAssistantTurnConnectionState(previous[runId], {
          runId,
          conversationId,
          connectionState,
        }),
      }))
    },
    [activeRunId, conversationId],
  )

  useAgentStream({
    runId: activeRunId,
    afterSeq: activeRunId ? assistantTurns[activeRunId]?.lastSeq ?? 0 : 0,
    onEvent: handleWsEvent,
    onConnectionChange: handleStreamConnectionChange,
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

  const resolveApproval = useMutation({
    mutationFn: ({ approvalId, approved, autoResume }: { approvalId: string; approved: boolean; autoResume?: boolean }) =>
      apiFetch<TaskApproval>(`/task-approvals/${approvalId}`, {
        method: 'POST',
        body: JSON.stringify({ approved, auto_resume: Boolean(autoResume) }),
      }),
    onSuccess: (approval) => {
      queryClient.invalidateQueries({ queryKey: ['active-task', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['task-approvals', taskForSummary?.id] })
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
      if (approval.resume_agent_run_id) {
        setActiveRunId(approval.resume_agent_run_id)
        setAssistantTurns((previous) => ({
          ...previous,
          [approval.resume_agent_run_id!]:
            previous[approval.resume_agent_run_id!] ??
            createAssistantTurn({
              runId: approval.resume_agent_run_id!,
              conversationId,
              status: approval.resume_status ?? 'queued',
              thinkingEnabled: selectedThinking !== 'off',
            }),
        }))
      }
    },
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
      setSendError(null)
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
      if (conversation?.title === 'New conversation') {
        setActiveConversation({
          ...conversation,
          title: deriveInitialConversationTitle(inputValue),
        })
      }
      setActiveRunId(response.agent_run_id)
      setAssistantTurns((previous) => ({
        ...previous,
        [response.agent_run_id]:
          previous[response.agent_run_id] ??
          createAssistantTurn({
            runId: response.agent_run_id,
            conversationId,
            triggerMessageId: response.message_id,
            status: response.status,
            thinkingEnabled: selectedThinking !== 'off',
          }),
      }))
      setPendingAssets([])
      reset()
    },
  })

  const onSubmit = (data: SendForm) => {
    if (!data.content_text.trim()) {
      return
    }

    if (isTerminalWorkerTraceRun(getActiveWorkerTraceRun(workerTraceRef.current))) {
      setWorkerPanelMode('hidden')
    }

    const shouldRevealLatestTurn = isAtBottom
    const optimisticUserId = `opt-user-${Date.now()}`

    setSendError(null)
    setOptimisticUsers((previous) => [
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
    if (shouldRevealLatestTurn) {
      window.requestAnimationFrame(() => scrollToBottom('auto'))
    }

    sendMessage.mutate(data, {
      onSuccess: (response) => {
        setOptimisticUsers((previous) =>
          previous.map((message) =>
            message.id === optimisticUserId
              ? { ...message, id: response.message_id, status: 'completed', agent_run_id: response.agent_run_id }
              : message,
          ),
        )
      },
      onError: (error) => {
        setOptimisticUsers((previous) => previous.filter((message) => message.id !== optimisticUserId))

        if (error instanceof ApiError && error.status === 409 && error.code === 'conversation_run_in_progress') {
          const runId =
            typeof (error.data as { detail?: { run_id?: unknown } })?.detail?.run_id === 'string'
              ? (error.data as { detail?: { run_id?: string } }).detail?.run_id
              : null
          if (runId) {
            setActiveRunId(runId)
            queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
          }
          setSendError(error.detail ?? 'Socrates is still responding to the previous message.')
          return
        }

        setSendError(error instanceof Error ? error.message : 'Unable to send the message.')
      },
    })
  }

  const cancelRun = useMutation({
    mutationFn: (runId: string) =>
      apiFetch<AgentRun>(`/agent-runs/${runId}/cancel`, {
        method: 'POST',
      }),
    onSuccess: (run) => {
      setSendError(null)
      setActiveRunId((current) => (current === run.id ? null : current))
      queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
    },
    onError: (error) => {
      setSendError(error instanceof Error ? error.message : 'Unable to stop the current run.')
      queryClient.invalidateQueries({ queryKey: ['active-run', conversationId] })
    },
  })

  const persistedIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages])
  const visibleOptimisticUsers = useMemo(
    () => optimisticUsers.filter((message) => !persistedIds.has(message.id)),
    [optimisticUsers, persistedIds],
  )
  const timelineEntries = useMemo(
    () => buildConversationTimeline(messages, visibleOptimisticUsers, assistantTurns),
    [assistantTurns, messages, visibleOptimisticUsers],
  )
  const conversationScrollSignature = useMemo(
    () => createConversationScrollSignature(timelineEntries),
    [timelineEntries],
  )
  useEffect(() => {
    notifyContentChanged()
  }, [conversationScrollSignature, notifyContentChanged])
  const activeAssistantTurn = activeRunId ? assistantTurns[activeRunId] : null
  const activeWorkerTrace = useMemo(() => getActiveWorkerTraceRun(workerTrace), [workerTrace])
  useEffect(() => {
    const decision = decidePendingArtifactAutoOpen({
      pendingArtifactPath: pendingAutoOpenArtifactPath,
      artifactPanelMode,
      mobileArtifactsOpen,
      workerStatus: activeWorkerTrace?.status,
      manualCollapseAfterPending: manualArtifactCollapseAfterPendingRef.current,
      isMobileViewport: isArtifactSheetViewport(),
    })

    if (!decision) {
      return
    }

    setSelectedWorkspacePath(decision.selectedPath)
    artifactPanelModeRef.current = decision.artifactPanelMode
    mobileArtifactsOpenRef.current = decision.mobileArtifactsOpen
    pendingAutoOpenArtifactPathRef.current = decision.pendingArtifactPath
    setArtifactPanelMode(decision.artifactPanelMode)
    setMobileArtifactsOpen(decision.mobileArtifactsOpen)
    setPendingAutoOpenArtifactPath(decision.pendingArtifactPath)
    manualArtifactCollapseAfterPendingRef.current = false
  }, [
    activeWorkerTrace?.status,
    artifactPanelMode,
    isArtifactSheetViewport,
    mobileArtifactsOpen,
    pendingAutoOpenArtifactPath,
  ])
  const pendingTaskApprovals = useMemo(
    () =>
      taskForSummary && taskForSummary.status !== 'completed' && taskForSummary.status !== 'failed'
        ? taskApprovals.filter((approval) => approval.status === 'pending')
        : [],
    [taskApprovals, taskForSummary],
  )
  const hasPendingPlanApproval = Boolean(
    taskForSummary &&
      taskForSummary.status !== 'completed' &&
      taskForSummary.status !== 'failed' &&
      pendingTaskApprovals.some(
        (approval) => approval.status === 'pending' && approval.approval_type.toLowerCase().includes('plan'),
      ),
  )
  const hasPendingTaskApproval = pendingTaskApprovals.length > 0
  const activeRunIsActive = isActiveRunStatus(activeRun?.status)
  const isConversationLocked =
    activeRunIsActive ||
    hasPendingTaskApproval ||
    resolveApproval.isPending ||
    (activeAssistantTurn ? isActiveRunStatus(activeAssistantTurn.status) : false)
  const hasConversationStarted = timelineEntries.length > 0 || activeRunId !== null
  const preferenceError =
    updateConversationPreferences.error instanceof Error
      ? updateConversationPreferences.error.message
      : null

  return (
    <div className="relative flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-canvas">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <section className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {taskForSummary ? <ActiveTaskBar task={taskForSummary} /> : null}
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overscroll-contain">
            <div className="mx-auto flex min-h-full w-full max-w-5xl flex-col px-4 pb-8 pt-4 sm:px-6 sm:pt-6 lg:px-8">
              {hasConversationStarted ? (
                <div className="flex flex-1 flex-col gap-5 pb-8 pt-2 sm:gap-6">
                  {taskForSummary ? (
                    <TaskSummaryCard
                      task={taskForSummary}
                      approvals={taskApprovals}
                      artifacts={taskArtifacts}
                      approvalPending={resolveApproval.isPending}
                      onResolveApproval={(approvalId, approved, autoResume) => resolveApproval.mutate({ approvalId, approved, autoResume })}
                    />
                  ) : null}
                  {timelineEntries.map((entry) => {
                    if (entry.kind === 'assistant') {
                      return (
                        <AssistantTurnBubble
                          key={entry.key}
                          turn={entry.turn}
                          onHydrateActivity={hydrateActivityForRun}
                        />
                      )
                    }

                    return (
                      <MessageBubble
                        key={entry.key}
                        message={entry.message}
                      />
                    )
                  })}
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

          <ConversationBottomDock>
            {(hasUnseenBottomContent || taskForSummary) ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                {hasUnseenBottomContent ? (
                  <button
                    type="button"
                    onClick={() => scrollToBottom('smooth')}
                    className="inline-flex items-center gap-2 rounded-full border border-forest/20 bg-forest px-4 py-2 text-xs font-medium text-canvas shadow-sm shadow-forest/10 transition hover:bg-forest/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-forest/40"
                    aria-label="Jump to latest message"
                  >
                    <ArrowDown className="size-3.5" aria-hidden="true" />
                    <span>Jump to latest</span>
                  </button>
                ) : (
                  <span />
                )}
                {taskForSummary ? (
                  <button
                    type="button"
                    onClick={() => {
                      handleArtifactPanelModeChange('open')
                      mobileArtifactsOpenRef.current = true
                      setMobileArtifactsOpen(true)
                    }}
                    className="inline-flex items-center rounded-full border border-forest/12 bg-paper/94 px-3 py-2 text-xs font-semibold text-forest shadow-sm xl:hidden"
                  >
                    Artifacts
                  </button>
                ) : null}
              </div>
            ) : null}

            {pendingTaskApprovals.length > 0 ? (
              <PendingApprovalDock
                approvals={pendingTaskApprovals}
                approvalPending={resolveApproval.isPending}
                onResolveApproval={(approvalId, approved, autoResume) => resolveApproval.mutate({ approvalId, approved, autoResume })}
              />
            ) : null}

            <WorkerTracePanel
              worker={activeWorkerTrace}
              mode={workerPanelMode}
              onModeChange={setWorkerPanelMode}
            />

            <ConversationComposer
              compact
              register={register}
              handleSubmit={handleSubmit}
              onSubmit={onSubmit}
              inputValue={inputValue}
              isSubmitting={isSubmitting}
              sendPending={sendMessage.isPending}
              activeRunId={activeRunIsActive ? activeRun?.id ?? activeRunId : activeRunId}
              activeRunPending={activeRunIsActive || Boolean(activeAssistantTurn && isActiveRunStatus(activeAssistantTurn.status))}
              cancelPending={cancelRun.isPending}
              onCancelRun={(runId) => cancelRun.mutate(runId)}
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
              sendError={sendError}
              disabledReason={
                hasPendingPlanApproval
                  ? 'Approve the plan or reject it to suggest changes.'
                  : hasPendingTaskApproval
                    ? 'Resolve the pending task approval to continue.'
                  : null
              }
              disabled={isConversationLocked}
              fileInputRef={fileInputRef}
              onFileSelect={(file) => uploadAsset.mutate(file)}
            />
          </ConversationBottomDock>
          {mobileArtifactsOpen && taskForSummary ? (
            <ArtifactWorkspacePanel
              mobile
              taskId={taskForSummary.id}
              tree={taskWorkspaceTree}
              preview={workspacePreview}
              artifacts={taskArtifacts}
              workspaceRoot={taskForSummary.workspace_host_root ?? taskForSummary.workspace_root}
              selectedPath={effectiveSelectedWorkspacePath}
              mode="open"
              loadingPreview={workspacePreviewLoading}
              onSelectPath={setSelectedWorkspacePath}
              onModeChange={handleArtifactPanelModeChange}
              onCloseMobile={handleMobileArtifactsClose}
            />
          ) : null}
        </section>
        <ArtifactWorkspacePanel
          taskId={taskForSummary?.id ?? null}
          tree={taskWorkspaceTree}
          preview={workspacePreview}
          artifacts={taskArtifacts}
          workspaceRoot={taskForSummary?.workspace_host_root ?? taskForSummary?.workspace_root ?? null}
          selectedPath={effectiveSelectedWorkspacePath}
          mode={artifactPanelMode}
          loadingPreview={workspacePreviewLoading}
          onSelectPath={setSelectedWorkspacePath}
          onModeChange={handleArtifactPanelModeChange}
        />
      </div>
    </div>
  )
}

function ConversationBottomDock({ children }: { children: ReactNode }) {
  return (
    <div className="shrink-0 border-t border-forest/10 bg-canvas/96 px-2 pb-[calc(env(safe-area-inset-bottom)+0.85rem)] pt-3 shadow-[0_-16px_40px_rgba(62,92,72,0.06)] backdrop-blur sm:px-4 sm:pb-5">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-2.5">
        {children}
      </div>
    </div>
  )
}

function ActiveTaskBar({ task }: { task: Task }) {
  const taskLabel =
    task.status === 'completed'
      ? 'Completed task'
      : task.status === 'failed'
        ? 'Failed task'
        : 'Active task'

  return (
    <div className="z-20 shrink-0 border-b border-forest/10 bg-canvas/92 px-4 py-2 backdrop-blur sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-moss">{taskLabel}</p>
          <p className="truncate text-sm font-semibold text-forest">{task.title}</p>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.14em]',
            task.status === 'completed'
              ? 'bg-sage/60 text-forest'
              : task.status === 'failed'
                ? 'bg-red-100 text-red-700'
                : 'bg-paper text-moss',
          )}
        >
          {task.status.replace('_', ' ')}
        </span>
      </div>
    </div>
  )
}

interface TaskSummaryCardProps {
  task: Task
  approvals: TaskApproval[]
  artifacts: TaskArtifact[]
  approvalPending: boolean
  onResolveApproval: (approvalId: string, approved: boolean, autoResume?: boolean) => void
}

function TaskSummaryCard({
  task,
  approvals,
  artifacts,
  approvalPending,
  onResolveApproval,
}: TaskSummaryCardProps) {
  const isTerminalTask = task.status === 'completed' || task.status === 'failed'
  const pendingApprovals = isTerminalTask ? [] : approvals.filter((approval) => approval.status === 'pending')
  const planApprovals = pendingApprovals.filter((a) => a.approval_type.toLowerCase().includes('plan'))
  const completionApprovals = pendingApprovals.filter((a) => a.approval_type === 'task_completion')
  const commandApprovals = pendingApprovals.filter((a) => !a.approval_type.toLowerCase().includes('plan') && a.approval_type !== 'task_completion')
  const outputArtifacts = artifacts.filter((artifact) => artifact.artifact_role === 'output')
  const taskLabel =
    task.status === 'completed'
      ? 'Completed task'
      : task.status === 'failed'
        ? 'Failed task'
        : 'Active task'

  return (
    <section className="rounded-[1.4rem] border border-forest/10 bg-paper/90 p-4 shadow-[0_18px_40px_rgba(62,92,72,0.08)]">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-forest/5 pb-4">
        <div className="space-y-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-moss">{taskLabel}</p>
          <h2 className="font-display text-xl tracking-tight text-forest">{task.title}</h2>
          <p className="max-w-2xl text-sm leading-6 text-ink-soft">{task.goal_text}</p>
        </div>
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]',
              task.status === 'completed'
                ? 'bg-sage/60 text-forest'
                : task.status === 'failed'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-canvas text-moss',
            )}
          >
            {task.status.replace('_', ' ')}
          </div>
        </div>
      </div>

      {isTerminalTask && task.result_summary ? (
        <div className="mt-4 rounded-[1rem] border border-forest/10 bg-canvas/70 px-4 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-moss">Result Summary</p>
          <p className="mt-1 text-sm leading-6 text-ink-soft">{task.result_summary}</p>
        </div>
      ) : null}

      {planApprovals.length > 0 ? (
        <div className="mt-4 space-y-3 rounded-[1rem] border border-forest/15 bg-sage/10 p-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-moss" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-moss">Plan Review Required</p>
          </div>
          <p className="text-sm text-ink-soft">Socrates has formulated a strategy and is waiting for your review before creating a todo list and beginning work.</p>
          {planApprovals.map((approval) => (
            <div key={approval.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[0.9rem] bg-white/90 px-4 py-4 shadow-sm">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-forest">Execution Plan</p>
                <p className="max-w-2xl text-xs leading-5 text-ink-soft">
                  Review the proposed `plan.md` in the chat history or task files.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="border-forest/20 text-ink-soft hover:bg-red-50 hover:text-red-700 hover:border-red-200"
                  disabled={approvalPending}
                  onClick={() => onResolveApproval(approval.id, false)}
                >
                  Reject and suggest changes
                </Button>
                <Button
                  type="button"
                  className="bg-forest text-white hover:bg-forest/90 shadow-md shadow-forest/10"
                  disabled={approvalPending}
                  onClick={() => onResolveApproval(approval.id, true, true)}
                >
                  Approve Plan
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {commandApprovals.length > 0 ? (
        <div className="mt-4 space-y-3 rounded-[1rem] border border-amber-200 bg-amber-50/80 p-3">
          <div className="flex items-center gap-2">
            <AlertCircle className="size-3.5 text-amber-700" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-800">Action Approvals</p>
          </div>
          {commandApprovals.map((approval) => (
            <div key={approval.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[0.9rem] bg-white/80 px-3 py-3">
              <div className="space-y-1">
                <p className="text-sm font-semibold text-amber-900">{approval.approval_type.replaceAll('_', ' ')}</p>
                <p className="max-w-2xl text-xs leading-5 text-ink-soft">
                  {JSON.stringify(approval.request_json)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="border-amber-200 bg-transparent text-amber-800 hover:bg-amber-100"
                  disabled={approvalPending}
                  onClick={() => onResolveApproval(approval.id, false)}
                >
                  Deny
                </Button>
                <Button
                  type="button"
                  className="bg-amber-600 text-white hover:bg-amber-700"
                  disabled={approvalPending}
                  onClick={() => onResolveApproval(approval.id, true)}
                >
                  Confirm
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {completionApprovals.length > 0 ? (
        <div className="mt-4 space-y-3 rounded-[1rem] border border-emerald-200 bg-emerald-50/80 p-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-3.5 text-emerald-700" />
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-800">Completion Approval</p>
          </div>
          {completionApprovals.map((approval) => (
            <div key={approval.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[0.9rem] bg-white/86 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-emerald-950">Socrates wants to mark this task completed.</p>
                <p className="mt-1 max-w-2xl text-xs leading-5 text-ink-soft">
                  {typeof approval.request_json.result_summary === 'string'
                    ? approval.request_json.result_summary
                    : 'Approve only if the delivered work is accepted.'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="border-emerald-200 bg-transparent text-emerald-900 hover:bg-white"
                  disabled={approvalPending}
                  onClick={() => onResolveApproval(approval.id, false, true)}
                >
                  No
                </Button>
                <Button
                  type="button"
                  className="bg-emerald-700 text-white hover:bg-emerald-800"
                  disabled={approvalPending}
                  onClick={() => onResolveApproval(approval.id, true)}
                >
                  Yes
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {artifacts.length > 0 ? (
        <div className="mt-4 rounded-[1rem] border border-forest/10 bg-canvas/70 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-moss">Task Package & Artifacts</p>
            <span className="text-[10px] text-ink-soft/60">Rigorous Workspace</span>
          </div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {artifacts.slice(0, 10).map((artifact) => (
              <div
                key={artifact.id}
                className="flex items-center justify-between gap-2 rounded-[0.95rem] border border-forest/10 bg-paper px-3 py-2 shadow-sm"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-forest">{artifact.display_name}</p>
                  <p className="text-[10px] uppercase tracking-[0.14em] text-moss/70">{artifact.artifact_role}</p>
                </div>
                {artifact.artifact_role === 'output' ? (
                  <span className="rounded-full bg-sage/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-forest">
                    Output
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {!artifacts.length && !pendingApprovals.length ? (
        <div className="mt-4 flex items-center justify-center rounded-[1rem] border border-dashed border-forest/20 py-8">
          <p className="text-xs text-ink-soft italic">
            {isTerminalTask ? 'This task is closed.' : 'No artifacts or approvals yet. Socrates is formulating the task package...'}
          </p>
        </div>
      ) : null}

      {outputArtifacts.length > 0 ? (
        <p className="mt-3 text-[11px] leading-5 text-ink-soft italic">
          Final deliverables are tracked in <span className="font-semibold text-forest">outputs/</span> and can be opened from the workspace panel.
        </p>
      ) : null}
    </section>
  )
}

interface PendingApprovalDockProps {
  approvals: TaskApproval[]
  approvalPending: boolean
  onResolveApproval: (approvalId: string, approved: boolean, autoResume?: boolean) => void
}

function PendingApprovalDock({
  approvals,
  approvalPending,
  onResolveApproval,
}: PendingApprovalDockProps) {
  const approval = approvals[0]
  if (!approval) {
    return null
  }

  const isPlan = approval.approval_type.toLowerCase().includes('plan')
  const isCompletion = approval.approval_type === 'task_completion'
  const summary =
    typeof approval.request_json.result_summary === 'string'
      ? approval.request_json.result_summary
      : isPlan
        ? 'Review the proposed plan before Socrates starts work.'
        : isCompletion
          ? 'Approve only if the delivered work is accepted.'
          : JSON.stringify(approval.request_json)

  return (
    <div className="flex w-full flex-col gap-3 rounded-[1rem] border border-forest/12 bg-paper/96 px-3 py-2.5 shadow-sm md:flex-row md:items-center md:justify-between">
      <div className="flex min-w-0 items-center gap-3">
        <div
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-full',
            isCompletion ? 'bg-emerald-100 text-emerald-700' : isPlan ? 'bg-sage/60 text-moss' : 'bg-amber-100 text-amber-700',
          )}
        >
          {isCompletion ? (
            <CheckCircle2 className="size-4" aria-hidden="true" />
          ) : isPlan ? (
            <Sparkles className="size-4" aria-hidden="true" />
          ) : (
            <AlertCircle className="size-4" aria-hidden="true" />
          )}
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-moss">
            {isCompletion ? 'Completion approval' : isPlan ? 'Plan approval' : 'Action approval'}
          </p>
          <p className="mt-0.5 line-clamp-1 text-xs leading-5 text-ink-soft sm:text-sm">{summary}</p>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          className="h-8 border-forest/20 bg-transparent px-3 text-xs text-ink-soft hover:bg-red-50 hover:text-red-700 hover:border-red-200"
          disabled={approvalPending}
          onClick={() => onResolveApproval(approval.id, false, isCompletion)}
        >
          {isCompletion ? 'No' : isPlan ? 'Reject' : 'Deny'}
        </Button>
        <Button
          type="button"
          className={cn(
            'h-8 px-3 text-xs text-white shadow-sm',
            isCompletion
              ? 'bg-emerald-700 hover:bg-emerald-800 shadow-emerald-900/10'
              : isPlan
                ? 'bg-forest hover:bg-forest/90 shadow-forest/10'
                : 'bg-amber-600 hover:bg-amber-700 shadow-amber-900/10',
          )}
          disabled={approvalPending}
          onClick={() => onResolveApproval(approval.id, true, isPlan)}
        >
          {isCompletion ? 'Yes' : isPlan ? 'Approve plan' : 'Confirm'}
        </Button>
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
  activeRunId: string | null
  activeRunPending: boolean
  cancelPending: boolean
  onCancelRun: (runId: string) => void
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
  sendError: string | null
  disabledReason: string | null
  disabled: boolean
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
  activeRunId,
  activeRunPending,
  cancelPending,
  onCancelRun,
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
  sendError,
  disabledReason,
  disabled,
  fileInputRef,
  onFileSelect,
}: ComposerProps) {
  const modelOptions = getModelsForProvider(selectedProvider)
  const thinkingOptions = getThinkingOptionsForModel(selectedModel)
  const stopDisabled = !activeRunId || cancelPending

  return (
    <div
      className={compact
        ? 'bg-transparent px-0 py-0 shadow-none sm:px-0 sm:py-0'
        : 'rounded-[1.8rem] bg-paper/94 px-4 py-4 shadow-[0_28px_80px_rgba(62,92,72,0.12)] sm:rounded-[2.25rem] sm:px-5 sm:py-5'}
    >
      <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-2.5">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.pdf,.txt,.md,.csv,.tsv,.json,.sqlite,.db,.py,.js,.ts,.tsx"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) {
              onFileSelect(file)
            }
            event.target.value = ''
          }}
          disabled={disabled}
        />

        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          <ComposerSelect
            compact={compact}
            label="Provider"
            value={selectedProvider}
            onChange={(value) => onProviderChange(value as ProviderId)}
            options={PROVIDER_OPTIONS.map((provider) => ({ value: provider.id, label: provider.label }))}
            disabled={disabled}
          />
          <ComposerSelect
            compact={compact}
            label="Model"
            value={selectedModel}
            onChange={onModelChange}
            options={modelOptions.map((model) => ({ value: model.id, label: model.label }))}
            disabled={disabled}
          />
          <ComposerSelect
            compact={compact}
            label="Thinking"
            value={selectedThinking}
            onChange={(value) => onThinkingChange(value as ThinkingLevel)}
            options={thinkingOptions.map((option) => ({ value: option.value, label: option.label }))}
            disabled={disabled}
          />
          <div className="ml-auto shrink-0 whitespace-nowrap pr-1 text-[11px] text-ink-soft">
            {settingsPending ? 'Saving selection…' : null}
          </div>
        </div>

        {settingsError ? <p className="text-sm text-red-600">{settingsError}</p> : null}
        {sendError ? <p className="text-sm text-red-600">{sendError}</p> : null}
        {disabledReason ? <p className="text-sm text-ink-soft">{disabledReason}</p> : null}

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
                  disabled={disabled}
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
              ? 'field-sizing-fixed min-h-11 max-h-32 flex-1 resize-none rounded-[1.35rem] border-0 bg-white/82 px-4 py-3 text-sm leading-6 text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/20 sm:min-h-12 sm:rounded-[1.5rem]'
              : 'field-sizing-fixed min-h-29 flex-1 resize-none rounded-[1.5rem] border-0 bg-white/80 px-4 py-3 text-base text-ink outline-none focus-visible:ring-3 focus-visible:ring-ring/20 sm:min-h-38 sm:rounded-[1.8rem] sm:px-5 sm:py-4'}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                handleSubmit(onSubmit)()
              }
            }}
            disabled={disabled}
            {...register('content_text')}
          />

          <div className="flex shrink-0 items-center gap-2 pb-1">
            <Button
              type="button"
              size="icon"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadPending || disabled}
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
              disabled={disabled}
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
              type={activeRunPending ? 'button' : 'submit'}
              size="icon"
              disabled={activeRunPending ? stopDisabled : disabled || isSubmitting || sendPending || !inputValue?.trim()}
              onClick={activeRunPending && activeRunId ? () => onCancelRun(activeRunId) : undefined}
              className={cn(
                'size-10 rounded-full text-white sm:size-11',
                activeRunPending ? 'bg-red-600 hover:bg-red-700' : 'bg-forest hover:bg-forest/92',
              )}
              title={activeRunPending ? 'Stop current run' : 'Send message'}
            >
              {activeRunPending
                ? cancelPending
                  ? <LoaderCircle className="animate-spin" />
                  : <Square className="size-4 fill-current" />
                : sendPending
                  ? <LoaderCircle className="animate-spin" />
                  : <Send />}
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
  disabled?: boolean
}

function ComposerSelect({ compact = false, label, value, onChange, options, disabled = false }: ComposerSelectProps) {
  const compactWidthClass =
    label === 'Model'
      ? 'min-w-[13rem] flex-[1_1_13rem]'
      : label === 'Provider'
        ? 'min-w-[7.5rem] flex-[0_0_7.5rem]'
        : 'min-w-[7rem] flex-[0_0_7rem]'

  return (
    <label className={compact ? cn('relative shrink-0', compactWidthClass) : 'relative w-full sm:min-w-[140px] sm:flex-1 lg:flex-none'}>
      {compact ? null : (
        <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.22em] text-moss">
          {label}
        </span>
      )}
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
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
    <p className="mb-2.5 last:mb-0 leading-6" {...props}>
      {children}
    </p>
  ),
  ul: ({ children, ...props }) => (
    <ul className="mb-2.5 list-disc space-y-0.5 pl-5 last:mb-0" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }) => (
    <ol className="mb-2.5 list-decimal space-y-0.5 pl-5 last:mb-0" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }) => (
    <li className="leading-6" {...props}>
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
      className="mb-2.5 max-w-full overflow-x-auto rounded-[0.9rem] border border-sage-strong/60 bg-paper/90 p-3 text-[12.5px] leading-5 last:mb-0"
      {...props}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children, ...props }) => (
    <blockquote
      className="mb-2.5 border-l-4 border-moss/50 pl-3.5 text-ink-soft italic last:mb-0"
      {...props}
    >
      {children}
    </blockquote>
  ),
  h1: ({ children, ...props }) => (
    <h3 className="mb-2 font-display text-lg tracking-tight text-forest" {...props}>
      {children}
    </h3>
  ),
  h2: ({ children, ...props }) => (
    <h3 className="mb-2 font-display text-base tracking-tight text-forest" {...props}>
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
    <div className="mb-2.5 max-w-full overflow-x-auto last:mb-0">
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

function deriveThinkingStorageKey(message: { agent_run_id?: string | null }): string | null {
  const runId = message.agent_run_id ?? null
  if (runId) return `${THINKING_COLLAPSE_PREFIX}${runId}`
  return null
}

function readPersistedString(storageKey: string): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(storageKey)
    return value?.trim() ? value : null
  } catch {
    return null
  }
}

function writePersistedString(storageKey: string, value: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (value?.trim()) {
      window.localStorage.setItem(storageKey, value)
    } else {
      window.localStorage.removeItem(storageKey)
    }
  } catch {
    // localStorage may be unavailable; panel state can safely degrade.
  }
}

function readPersistedPanelMode<T extends string>(storageKey: string, fallback: T, allowed: readonly T[]): T {
  const value = readPersistedString(storageKey)
  return allowed.includes(value as T) ? (value as T) : fallback
}

function readArtifactSheetMode(): boolean {
  if (typeof window === 'undefined') return false
  return shouldUseArtifactSheet(window.innerWidth)
}

function readPersistedCollapse(storageKey: string | null): boolean {
  if (!storageKey || typeof window === 'undefined') return true
  try {
    const persisted = window.localStorage.getItem(storageKey)
    if (persisted === null) return true
    return persisted === '1'
  } catch {
    return true
  }
}

function writePersistedCollapse(storageKey: string | null, collapsed: boolean): void {
  if (!storageKey || typeof window === 'undefined') return
  try {
    if (collapsed) {
      window.localStorage.setItem(storageKey, '1')
    } else {
      window.localStorage.setItem(storageKey, '0')
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
    <div className="mb-3 min-h-[4.75rem] rounded-[1.35rem] bg-sage/50 px-4 py-3.5 shadow-[0_10px_24px_rgba(62,92,72,0.05)]">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand reasoning' : 'Collapse reasoning'}
        className="flex min-h-10 w-full items-center gap-2 text-left transition hover:opacity-90"
      >
        <ThinkingOrb />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-moss">
            {headerLabel}
          </p>
          <p className="line-clamp-1 min-h-4 text-[11px] text-ink-soft/80">{statusLabel}</p>
        </div>
        <span
          className="ml-auto inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-white/40 text-moss transition hover:bg-white/70"
          aria-hidden="true"
        >
          {collapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </span>
      </button>
      {showBody ? (
        <div className="assistant-markdown mt-3 max-h-[min(28vh,18rem)] min-w-0 overflow-y-auto pr-1 text-[13px] leading-6 tracking-[0.01em] text-ink-soft">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={thinkingMarkdownComponents}>
            {text}
          </ReactMarkdown>
        </div>
      ) : null}
    </div>
  )
}

interface MessageBubbleProps {
  message: Message | OptimisticUserMessage
}

function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === 'user'
  const displayContent = message.content_text ?? ''
  const displayThinking = message.thinking_text ?? ''
  const hasContent = displayContent.trim().length > 0
  const hasThinking = displayThinking.trim().length > 0
  const showThinkingPanel = !isUser && hasThinking
  const thinkingStorageKey = !isUser ? deriveThinkingStorageKey(message) : null

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`min-w-0 max-w-full ${isUser ? 'w-full sm:max-w-[76%]' : 'w-full sm:max-w-[88%]'}`}>
        {showThinkingPanel ? (
          <ThinkingPanel
            key={thinkingStorageKey ?? message.id}
            storageKey={thinkingStorageKey}
            text={displayThinking}
            hasThinking={hasThinking}
            isStreaming={false}
            statusLabel="Reasoning"
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

        <div
          className={
            isUser
              ? 'rounded-[1.45rem] bg-forest px-4 py-3 text-sm leading-6 text-white shadow-[0_18px_40px_rgba(27,53,41,0.12)] sm:py-3.5'
              : 'rounded-[1.45rem] bg-white/88 px-4 py-3 text-sm leading-6 text-ink shadow-[0_18px_40px_rgba(62,92,72,0.07)] sm:py-3.5'
          }
        >
          {hasContent ? (
            isUser ? (
              <p className="whitespace-pre-wrap break-words">{displayContent}</p>
            ) : (
              <div className="assistant-markdown min-w-0 max-w-full break-words text-sm leading-6 text-ink">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={assistantMarkdownComponents}
                >
                  {displayContent}
                </ReactMarkdown>
              </div>
            )
          ) : (
            <p className="text-xs italic text-ink-soft">...</p>
          )}
        </div>
      </div>
    </div>
  )
}

interface AssistantTurnBubbleProps {
  turn: AssistantTurnState
  onHydrateActivity?: (runId: string) => void
}

function AssistantTurnBubble({ turn, onHydrateActivity }: AssistantTurnBubbleProps) {
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
  const terminalNotice =
    !hasContent && turn.status === 'cancelled'
      ? 'Stopped by user.'
      : !hasContent && turn.status === 'stalled'
        ? 'Run stalled with no progress.'
        : null
  const thinkingStorageKey = deriveThinkingStorageKey({ agent_run_id: turn.runId })
  const showActivityPanel = shouldShowAssistantTurnActivity(turn)
  const statusLabel =
    turn.connectionState === 'reconnecting'
      ? 'Reconnecting to live stream'
      : turn.thinkingEnabled
        ? 'Socrates is thinking'
        : 'Socrates is responding'

  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-full w-full sm:max-w-[88%]">
        {showThinkingPanel ? (
          <ThinkingPanel
            key={thinkingStorageKey ?? turn.runId}
            storageKey={thinkingStorageKey}
            text={displayThinking}
            hasThinking={hasThinking}
            isStreaming={isStreaming}
            statusLabel={statusLabel}
          />
        ) : null}

        {showActivityPanel ? (
          <RunActivityPanel
            key={turn.runId}
            runId={turn.runId}
            activity={turn.activity}
            isStreaming={isStreaming}
            isLoading={turn.activityHydrating}
            connectionState={turn.connectionState}
            onHydrate={onHydrateActivity}
          />
        ) : null}

        {turn.persistedMessage?.assets?.length ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {turn.persistedMessage.assets.map((asset) => (
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

        {hasContent || showFailure || terminalNotice ? (
          <div className="rounded-[1.45rem] bg-white/88 px-4 py-3 text-sm leading-6 text-ink shadow-[0_18px_40px_rgba(62,92,72,0.07)] sm:py-3.5">
            {hasContent ? (
              <div className="assistant-markdown min-w-0 max-w-full break-words text-sm leading-6 text-ink">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={assistantMarkdownComponents}
                >
                  {displayContent}
                </ReactMarkdown>
              </div>
            ) : terminalNotice ? (
              <p className="text-xs italic text-ink-soft">{terminalNotice}</p>
            ) : (
              <p className="text-xs italic text-ink-soft">Failed to respond.</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

interface RunActivityPanelProps {
  runId: string
  activity: AssistantTurnState['activity']
  isStreaming: boolean
  isLoading: boolean
  connectionState: AssistantTurnState['connectionState']
  onHydrate?: (runId: string) => void
}

function RunActivityPanel({
  runId,
  activity,
  isStreaming,
  isLoading,
  connectionState,
  onHydrate,
}: RunActivityPanelProps) {
  const [expandedState, setExpandedState] = useState(() => ({ runId, expanded: false }))
  const expanded = expandedState.runId === runId ? expandedState.expanded : false
  const summary =
    connectionState === 'reconnecting'
      ? 'Reconnecting to live activity…'
      : !isStreaming && !isLoading && !activity.items.length && !activity.hydrated
        ? 'Open to load recorded activity.'
      : getRunActivitySummary(activity)
  const statusLabel = isStreaming ? 'Live activity' : 'Run trace'

  const toggleExpanded = useCallback(() => {
    const next = !expanded
    setExpandedState({ runId, expanded: next })
    if (next && !isStreaming && !activity?.hydrated) {
      onHydrate?.(runId)
    }
  }, [activity?.hydrated, expanded, isStreaming, onHydrate, runId])

  return (
    <div className="mb-3 min-h-[5.75rem] rounded-[1.4rem] bg-paper/88 px-4 py-3.5 shadow-[0_14px_32px_rgba(62,92,72,0.07)]">
      <button
        type="button"
        onClick={toggleExpanded}
        aria-expanded={expanded}
        className="flex min-h-[4.25rem] w-full items-start gap-3 text-left transition hover:opacity-95"
      >
        <RunActivityOrb live={isStreaming} failed={activity?.failed ?? false} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-moss">
              {statusLabel}
            </p>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em]',
                isStreaming
                  ? 'bg-sage/70 text-forest'
                  : activity?.failed
                    ? 'bg-red-100 text-red-700'
                    : 'bg-white/80 text-moss',
              )}
            >
              {isStreaming ? 'Streaming' : activity?.failed ? 'Failed' : 'Captured'}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 min-h-12 text-sm leading-6 text-ink-soft">{summary}</p>
        </div>
        <span
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-white/50 text-moss"
          aria-hidden="true"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </span>
      </button>

      {expanded ? (
        <div className="mt-3 max-h-[min(36vh,24rem)] space-y-2.5 overflow-y-auto pr-1">
          {activity?.items.length ? (
            activity.items.map((item) =>
              item.kind === 'narration' ? (
                <RunNarrationRow key={`narration:${item.seq}`} item={item} />
              ) : item.kind === 'worker' ? (
                <RunWorkerRow key={`worker:${item.workerRunId}`} item={item} />
              ) : (
                <RunToolRow key={`tool:${item.toolCallId}`} item={item} />
              ),
            )
          ) : (
            <div className="rounded-[1rem] bg-canvas/70 px-3.5 py-3 text-sm leading-6 text-ink-soft">
              {isLoading ? 'Loading recorded activity…' : 'Socrates is preparing the next step.'}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function RunNarrationRow({ item }: { item: Extract<RunActivityItem, { kind: 'narration' }> }) {
  return (
    <div className="rounded-[1.05rem] bg-canvas/78 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-moss">
        <Sparkles className="size-3.5" />
        <span>Socrates note</span>
      </div>
      <p className="mt-1.5 text-sm leading-6 text-ink">{item.text}</p>
    </div>
  )
}

function RunWorkerRow({ item }: { item: Extract<RunActivityItem, { kind: 'worker' }> }) {
  const statusText =
    item.status === 'running'
      ? 'Running'
      : item.status === 'blocked'
        ? 'Blocked'
        : item.status === 'failed'
          ? 'Failed'
          : item.status === 'cancelled'
            ? 'Stopped'
            : item.status === 'stalled'
              ? 'Stalled'
              : 'Completed'

  return (
    <div className="rounded-[1.05rem] border border-forest/10 bg-sage/35 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <WorkerStatusIcon status={item.status} />
            <p className="min-w-0 truncate text-sm font-semibold text-forest">Worker handoff</p>
          </div>
          <p className="mt-1 line-clamp-2 pl-6 text-xs leading-5 text-ink-soft">{item.summary}</p>
          {item.progressLabel ? (
            <p className="mt-0.5 line-clamp-1 pl-6 text-[11px] font-medium text-moss">{item.progressLabel}</p>
          ) : null}
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]',
            item.status === 'running'
              ? 'bg-white/80 text-forest'
              : item.status === 'failed' || item.status === 'blocked' || item.status === 'stalled'
                ? 'bg-red-100 text-red-700'
                : 'bg-white/80 text-moss',
          )}
        >
          {statusText}
        </span>
      </div>
    </div>
  )
}

function RunToolRow({ item }: { item: Extract<RunActivityItem, { kind: 'tool' }> }) {
  const statusText =
    item.status === 'running' ? 'Running' : item.status === 'failed' ? 'Failed' : 'Done'

  return (
    <div className="rounded-[1.05rem] bg-canvas/78 px-3.5 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <ToolStatusIcon status={item.status} />
            <p className="min-w-0 truncate text-sm font-medium text-forest">{item.label}</p>
          </div>
          {item.resultSummary ? (
            <p className="mt-1 line-clamp-2 pl-6 text-xs leading-5 text-ink-soft">{item.resultSummary}</p>
          ) : null}
        </div>
        <span
          className={cn(
            'rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em]',
            item.status === 'running'
              ? 'bg-sage/75 text-forest'
              : item.status === 'failed'
                ? 'bg-red-100 text-red-700'
                : 'bg-white/80 text-moss',
          )}
        >
          {statusText}
        </span>
      </div>

      {item.arguments || item.rawResult ? (
        <details className="mt-2.5 group rounded-[0.95rem] bg-white/72 px-3 py-2.5">
          <summary className="cursor-pointer list-none text-[11px] font-semibold uppercase tracking-[0.18em] text-moss">
            Raw detail
          </summary>
          <div className="mt-2 space-y-2">
            {item.arguments ? (
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft">
                  Arguments
                </p>
                <pre className="overflow-x-auto rounded-[0.8rem] bg-canvas/80 p-3 text-[12px] leading-5 text-ink-soft">
                  {formatActivityDetail(item.arguments)}
                </pre>
              </div>
            ) : null}
            {item.rawResult ? (
              <div>
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-ink-soft">
                  Result
                </p>
                <pre className="overflow-x-auto rounded-[0.8rem] bg-canvas/80 p-3 text-[12px] leading-5 text-ink-soft">
                  {formatActivityDetail(item.rawResult)}
                </pre>
              </div>
            ) : null}
          </div>
        </details>
      ) : null}
    </div>
  )
}

function WorkerStatusIcon({ status }: { status: Extract<RunActivityItem, { kind: 'worker' }>['status'] }) {
  if (status === 'running') {
    return <LoaderCircle className="size-4 shrink-0 animate-spin text-moss" />
  }
  if (status === 'failed' || status === 'blocked' || status === 'stalled') {
    return <AlertCircle className="size-4 shrink-0 text-red-600" />
  }
  return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
}

function ToolStatusIcon({ status }: { status: Extract<RunActivityItem, { kind: 'tool' }>['status'] }) {
  if (status === 'running') {
    return <LoaderCircle className="size-4 shrink-0 animate-spin text-moss" />
  }
  if (status === 'failed') {
    return <AlertCircle className="size-4 shrink-0 text-red-600" />
  }
  return <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
}

function formatActivityDetail(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function RunActivityOrb({ live, failed }: { live: boolean; failed: boolean }) {
  if (failed) {
    return (
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
        <AlertCircle className="size-4" />
      </span>
    )
  }

  if (live) {
    return (
      <span className="relative mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-sage/55">
        <span className="absolute size-8 rounded-full bg-[radial-gradient(circle,rgba(143,196,170,0.78)_0%,rgba(143,196,170,0)_72%)] blur-[6px]" />
        <FileSearch className="relative size-4 text-forest" />
      </span>
    )
  }

  return (
    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-white/75 text-moss">
      <FileSearch className="size-4" />
    </span>
  )
}

function ThinkingOrb() {
  return (
    <span className="relative flex size-3 shrink-0 items-center justify-center">
      <span className="absolute size-7 rounded-full bg-[radial-gradient(circle,rgba(143,196,170,0.72)_0%,rgba(143,196,170,0)_72%)] blur-[6px]" />
      <span className="absolute size-4 rounded-full bg-sage/55 animate-ping animation-duration-[1.8s]" />
      <span className="relative size-2.5 rounded-full bg-forest shadow-[0_0_16px_rgba(27,53,41,0.42)]" />
    </span>
  )
}
