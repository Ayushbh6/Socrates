import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  CheckCircle2,
  Clock3,
  FolderOpen,
  ImageUp,
  MessageSquarePlus,
  MessagesSquare,
  MoreVertical,
  Paperclip,
  Search,
  Trash2,
} from 'lucide-react'

import { getModelOption, getThinkingLabelForModel } from '@/config/models'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'
import type { Asset, Conversation, Project, ProjectWorkspace } from '@/types/api'

const RESOURCE_ACCEPT =
  '.pdf,.docx,.csv,.xlsx,.txt,.md,.png,.jpg'

export const Route = createFileRoute('/projects/$projectId/dashboard')({
  component: ProjectDashboardPage,
})

function ProjectDashboardPage() {
  const { projectId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const setActiveConversation = useAppStore((state) => state.setActiveConversation)
  const setActiveProject = useAppStore((state) => state.setActiveProject)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null)
  const [renameTitle, setRenameTitle] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null)
  const [conversationSearch, setConversationSearch] = useState('')
  const [activeTab, setActiveTab] = useState<'workspace' | 'resources'>('workspace')
  const [workspacePath, setWorkspacePath] = useState('')

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiFetch<Project>(`/projects/${projectId}`),
  })

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => apiFetch<Conversation[]>(`/projects/${projectId}/conversations`),
  })

  const { data: assets = [] } = useQuery({
    queryKey: ['assets', projectId],
    queryFn: () => apiFetch<Asset[]>(`/projects/${projectId}/assets`),
  })

  const { data: workspaces = [] } = useQuery({
    queryKey: ['project-workspaces', projectId],
    queryFn: () => apiFetch<ProjectWorkspace[]>(`/projects/${projectId}/workspaces`),
  })

  const startConversation = useMutation({
    mutationFn: () =>
      apiFetch<Conversation>(`/projects/${projectId}/conversations`, {
        method: 'POST',
        body: JSON.stringify({
          summary: null,
        }),
      }),
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      setActiveConversation(conversation)
      startTransition(() => {
        navigate({
          to: '/projects/$projectId/dashboard/conversations/$conversationId',
          params: { projectId, conversationId: conversation.id },
        })
      })
    },
  })

  const renameConversation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      apiFetch<Conversation>(`/conversations/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title }),
      }),
    onSuccess: (updated) => {
      queryClient.setQueryData<Conversation[]>(['conversations', projectId], (current) =>
        (current ?? []).map((conversation) =>
          conversation.id === updated.id ? updated : conversation,
        ),
      )
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      const { activeConversation } = useAppStore.getState()
      if (activeConversation?.id === updated.id) {
        useAppStore.setState({ activeConversation: updated })
      }
      setRenameTarget(null)
    },
  })

  const deleteConversation = useMutation({
    mutationFn: (id: string) =>
      apiFetch<Conversation>(`/conversations/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, id) => {
      queryClient.setQueryData<Conversation[]>(['conversations', projectId], (current) =>
        (current ?? []).filter((conversation) => conversation.id !== id),
      )
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      queryClient.removeQueries({ queryKey: ['messages', id] })
      const { activeConversation } = useAppStore.getState()
      if (activeConversation?.id === id) {
        useAppStore.setState({ activeConversation: null })
      }
      setDeleteTarget(null)
      startTransition(() => {
        navigate({
          to: '/projects/$projectId/dashboard',
          params: { projectId },
          replace: true,
        })
      })
    },
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assets', projectId] })
    },
  })

  const deleteAsset = useMutation({
    mutationFn: (assetId: string) =>
      apiFetch(`/projects/${projectId}/assets/${assetId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['assets', projectId] })
    },
  })

  const createWorkspace = useMutation({
    mutationFn: (payload: { label: string; relativePath: string | null; isPrimary: boolean }) =>
      apiFetch<ProjectWorkspace>(`/projects/${projectId}/workspaces`, {
        method: 'POST',
        body: JSON.stringify({
          label: payload.label,
          relative_path: payload.relativePath,
          is_primary: payload.isPrimary,
          access_granted: true,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-workspaces', projectId] })
      setWorkspacePath('')
    },
  })

  // We unlink a workspace by setting access_granted to false (or we could delete it, but update works as unlink here)
  const updateWorkspace = useMutation({
    mutationFn: ({
      workspaceId,
      patch,
    }: {
      workspaceId: string
      patch: Partial<Pick<ProjectWorkspace, 'is_primary' | 'access_granted'>>
    }) =>
      apiFetch<ProjectWorkspace>(`/projects/${projectId}/workspaces/${workspaceId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['project-workspaces', projectId] })
    },
  })

  const recentConversations = useMemo(
    () => [...conversations].sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
    [conversations],
  )
  const normalizedConversationSearch = conversationSearch.trim().toLowerCase()
  const filteredConversations = useMemo(() => {
    if (!normalizedConversationSearch) {
      return recentConversations
    }

    return recentConversations.filter((conversation) => {
      const model = getModelOption(conversation.model)
      const searchable = [
        conversation.title,
        conversation.summary ?? '',
        model.label,
        getThinkingLabelForModel(conversation.model, conversation.thinking_level),
      ]
        .join(' ')
        .toLowerCase()

      return searchable.includes(normalizedConversationSearch)
    })
  }, [normalizedConversationSearch, recentConversations])

  useEffect(() => {
    if (project) {
      setActiveProject(project)
    }
  }, [project, setActiveProject])

  useEffect(() => {
    setActiveConversation(null)
  }, [setActiveConversation])

  if (pathname !== `/projects/${projectId}/dashboard`) {
    return <Outlet />
  }

  // Active workspace (we only support one active root in this new UI)
  const activeWorkspace = workspaces.find(w => w.access_granted) || workspaces[0]

  return (
    <>
      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null)
            renameConversation.reset()
          }
        }}
      >
        <DialogContent className="border-sage-strong/60 bg-paper/98 sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle className="font-display text-forest">Rename conversation</DialogTitle>
            <DialogDescription>Choose a short label for this thread.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            className="h-10 rounded-xl border-sage-strong bg-white/90"
            placeholder="Conversation title"
            autoFocus
          />
          {renameConversation.error ? (
            <p className="text-sm text-red-600">
              {renameConversation.error instanceof Error
                ? renameConversation.error.message
                : 'Failed to rename conversation.'}
            </p>
          ) : null}
          <DialogFooter className="mt-2 border-t-0 bg-transparent px-1 pb-1 pt-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-sage-strong"
              onClick={() => {
                setRenameTarget(null)
                renameConversation.reset()
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="rounded-full bg-forest text-white hover:bg-forest/92"
              disabled={
                renameConversation.isPending || !renameTitle.trim() || !renameTarget
              }
              onClick={() => {
                if (!renameTarget || !renameTitle.trim()) {
                  return
                }
                renameConversation.mutate({
                  id: renameTarget.id,
                  title: renameTitle.trim(),
                })
              }}
            >
              {renameConversation.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            deleteConversation.reset()
          }
        }}
      >
        <DialogContent className="border-sage-strong/60 bg-paper/98 sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle className="font-display text-forest">Delete conversation?</DialogTitle>
            <DialogDescription>
              This archives the thread and removes it from the list. Messages remain in your local
              database for traceability.
            </DialogDescription>
          </DialogHeader>
          {deleteConversation.error ? (
            <p className="text-sm text-red-600">
              {deleteConversation.error instanceof Error
                ? deleteConversation.error.message
                : 'Failed to delete conversation.'}
            </p>
          ) : null}
          <DialogFooter className="mt-2 border-t-0 bg-transparent px-1 pb-1 pt-2 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-sage-strong"
              onClick={() => {
                setDeleteTarget(null)
                deleteConversation.reset()
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="rounded-full"
              disabled={deleteConversation.isPending || !deleteTarget}
              onClick={() => {
                if (!deleteTarget) {
                  return
                }
                deleteConversation.mutate(deleteTarget.id)
              }}
            >
              {deleteConversation.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex min-h-0 w-full flex-1 flex-col overflow-y-auto px-3 py-3 sm:px-5 lg:px-8 lg:py-4">
        <div className="mx-auto flex w-full max-w-[118rem] flex-col gap-3 pb-4 sm:gap-4">
          <section className="shrink-0 rounded-[1.35rem] bg-paper/92 px-4 py-3 shadow-[0_18px_44px_rgba(62,92,72,0.07)] sm:px-6 sm:py-4 lg:rounded-[1.65rem]">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div className="flex max-w-3xl flex-col gap-4">
                <Link
                  to="/projects"
                  className="inline-flex w-fit items-center gap-2 text-sm text-ink-soft transition hover:text-forest"
                >
                  <FolderOpen className="size-4" />
                  All projects
                </Link>

                <div className="flex flex-col gap-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-moss">
                    Project dashboard
                  </p>
                  <div className="flex flex-col gap-1.5">
                    <h1 className="font-display text-[clamp(2rem,3.6vw,3.25rem)] leading-none tracking-tight text-forest">
                      {project?.name ?? 'Project'}
                    </h1>
                    <p className="max-w-2xl text-sm leading-5 text-ink-soft sm:text-[15px] sm:leading-6">
                      {project?.description ??
                        'Review past conversations, keep your project resources together, and start a new session whenever a new line of thought begins.'}
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row">
                <Button
                  className="h-11 rounded-full bg-forest px-5 text-sm text-white shadow-[0_16px_40px_rgba(27,53,41,0.18)] hover:bg-forest/92"
                  onClick={() => startConversation.mutate()}
                  disabled={startConversation.isPending}
                >
                  <MessageSquarePlus data-icon="inline-start" />
                  {startConversation.isPending ? 'Opening…' : 'New conversation'}
                </Button>
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={RESOURCE_ACCEPT}
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  uploadAsset.mutate(file)
                }
                event.target.value = ''
              }}
            />
          </section>

          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.9fr)] xl:gap-4">
            <section className="flex min-h-[22rem] flex-col rounded-[1.35rem] bg-white/84 shadow-[0_18px_44px_rgba(62,92,72,0.05)] lg:rounded-[1.65rem] xl:max-h-[calc(100vh-17rem)]">
              <div className="flex shrink-0 flex-col gap-3 px-4 py-3 sm:px-5 sm:py-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.24em] text-moss">
                      Conversations
                    </p>
                    <h2 className="font-display text-2xl tracking-tight text-forest sm:text-3xl">Past sessions</h2>
                  </div>
                  <div className="rounded-full border border-sage-strong bg-paper px-3 py-1 text-sm text-ink-soft">
                    {recentConversations.length}
                  </div>
                </div>

                <div className="flex flex-col gap-3">
                  <label className="relative block">
                    <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-moss/70" />
                    <Input
                      value={conversationSearch}
                      onChange={(event) => setConversationSearch(event.target.value)}
                      placeholder="Search past conversations..."
                      aria-label="Search past conversations"
                      className="h-10 rounded-full border-sage-strong/70 bg-paper/80 pl-11 pr-4 text-sm text-ink placeholder:text-ink-soft focus-visible:border-forest/60 focus-visible:ring-ring/20"
                    />
                  </label>
                  {normalizedConversationSearch ? (
                    <p className="px-1 text-sm text-ink-soft">
                      Showing {filteredConversations.length} of {recentConversations.length} conversations
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="min-h-0 flex-1 px-3 pb-3 sm:px-4 sm:pb-4">
                {recentConversations.length > 0 ? (
                  <div className="h-full min-h-[15rem] overflow-hidden rounded-[1.2rem] border border-sage-strong/45 bg-paper/54 lg:rounded-[1.45rem]">
                    <div className="h-full overflow-y-auto px-3 py-3 sm:px-4 sm:py-4">
                      {filteredConversations.length > 0 ? (
                        <div className="flex flex-col gap-3 pb-2">
                          {filteredConversations.map((conversation) => {
                            const model = getModelOption(conversation.model)

                            const openConversation = () => {
                              setActiveConversation(conversation)
                              startTransition(() => {
                                navigate({
                                  to: '/projects/$projectId/dashboard/conversations/$conversationId',
                                  params: { projectId, conversationId: conversation.id },
                                })
                              })
                            }

                            return (
                              <div
                                key={conversation.id}
                                role="button"
                                tabIndex={0}
                                onClick={openConversation}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault()
                                    openConversation()
                                  }
                                }}
                                className={cn(
                                  'group cursor-pointer rounded-[1.1rem] border border-transparent bg-white/78 px-3 py-3 text-left outline-none transition sm:px-4',
                                  'hover:border-sage-strong hover:bg-paper hover:shadow-[0_16px_36px_rgba(62,92,72,0.08)]',
                                  'focus-visible:ring-3 focus-visible:ring-ring/40',
                                )}
                              >
                                <div className="flex items-start justify-between gap-4">
                                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-moss">
                                      <MessagesSquare className="size-3.5" />
                                      Conversation
                                    </div>
                                    <p className="truncate font-medium text-ink">{conversation.title}</p>
                                    <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                                      <span className="rounded-full bg-white/80 px-2.5 py-1">{model.label}</span>
                                      <span className="rounded-full bg-sage/55 px-2.5 py-1">
                                        Thinking {getThinkingLabelForModel(conversation.model, conversation.thinking_level)}
                                      </span>
                                    </div>
                                  </div>
                                  <div className="flex shrink-0 items-start gap-1">
                                    <DropdownMenu>
                                      <DropdownMenuTrigger asChild>
                                        <Button
                                          type="button"
                                          variant="ghost"
                                          size="icon-sm"
                                          className="size-9 rounded-full text-moss/80 hover:bg-sage/60 hover:text-forest"
                                          aria-label={`Conversation actions for ${conversation.title}`}
                                          onClick={(event) => event.stopPropagation()}
                                        >
                                          <MoreVertical className="size-4" />
                                        </Button>
                                      </DropdownMenuTrigger>
                                      <DropdownMenuContent align="end" className="min-w-[11rem] border-sage-strong/50 bg-paper/98">
                                        <DropdownMenuItem
                                          className="cursor-pointer"
                                          onClick={(event) => {
                                            event.stopPropagation()
                                            setRenameTarget(conversation)
                                            setRenameTitle(conversation.title)
                                          }}
                                        >
                                          Rename conversation
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator className="bg-sage-strong/40" />
                                        <DropdownMenuItem
                                          variant="destructive"
                                          className="cursor-pointer"
                                          onClick={(event) => {
                                            event.stopPropagation()
                                            setDeleteTarget(conversation)
                                          }}
                                        >
                                          Delete conversation
                                        </DropdownMenuItem>
                                      </DropdownMenuContent>
                                    </DropdownMenu>
                                    <ArrowRight className="mt-2 size-4 shrink-0 text-moss/70 transition group-hover:translate-x-0.5 group-hover:text-forest" />
                                  </div>
                                </div>
                                <div className="mt-3 flex items-center gap-2 text-sm text-ink-soft">
                                  <Clock3 className="size-3.5" />
                                  Updated {formatTimestamp(conversation.updated_at)}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      ) : (
                        <div className="flex h-full min-h-[16rem] flex-col items-center justify-center gap-3 rounded-[1.45rem] border border-dashed border-sage-strong/55 bg-white/50 px-6 text-center">
                          <div className="flex size-12 items-center justify-center rounded-full bg-sage/65 text-forest">
                            <Search className="size-5" />
                          </div>
                          <div className="flex max-w-sm flex-col gap-2">
                            <h3 className="font-display text-2xl tracking-tight text-forest">No matches</h3>
                            <p className="text-sm leading-7 text-ink-soft">
                              Try a different title, model, or thinking label.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full min-h-[15rem] flex-col items-center justify-center gap-4 rounded-[1.35rem] border border-dashed border-sage-strong bg-paper/70 px-6 text-center">
                    <div className="flex size-16 items-center justify-center rounded-full bg-sage text-forest">
                      <MessageSquarePlus className="size-6" />
                    </div>
                    <div className="flex max-w-md flex-col gap-3">
                      <h3 className="font-display text-4xl tracking-tight text-forest">No conversations yet</h3>
                      <p className="text-sm leading-7 text-ink-soft">
                        Start the first session inside this project and Socrates will keep each thread
                        organized here.
                      </p>
                    </div>
                    <Button
                      className="h-11 rounded-full bg-forest px-5 text-sm text-white hover:bg-forest/92"
                      onClick={() => startConversation.mutate()}
                      disabled={startConversation.isPending}
                    >
                      <MessageSquarePlus data-icon="inline-start" />
                      Start a conversation
                    </Button>
                  </div>
                )}
              </div>
            </section>

            <div className="flex min-h-0 flex-col gap-3 xl:gap-4">
              <section className="flex min-h-[20rem] flex-col rounded-[1.35rem] bg-paper/88 shadow-[0_18px_44px_rgba(62,92,72,0.05)] lg:rounded-[1.65rem] xl:max-h-[calc(100vh-17rem)]">
                <div className="flex shrink-0 items-center border-b border-sage-strong/40 px-4 pt-4 pb-2 sm:px-5">
                  <div className="flex gap-6">
                    <button
                      type="button"
                      onClick={() => setActiveTab('workspace')}
                      className={cn(
                        "pb-3 text-sm font-medium transition-colors relative outline-none focus-visible:ring-2 focus-visible:ring-forest/50 focus-visible:rounded",
                        activeTab === 'workspace' ? "text-forest" : "text-ink-soft hover:text-ink"
                      )}
                    >
                      Workspace
                      {activeTab === 'workspace' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-forest rounded-t-full" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab('resources')}
                      className={cn(
                        "pb-3 text-sm font-medium transition-colors relative outline-none focus-visible:ring-2 focus-visible:ring-forest/50 focus-visible:rounded",
                        activeTab === 'resources' ? "text-forest" : "text-ink-soft hover:text-ink"
                      )}
                    >
                      Resources
                      <span className="ml-2 rounded-full bg-sage-strong/30 px-2 py-0.5 text-xs text-ink-soft">
                        {assets.length}
                      </span>
                      {activeTab === 'resources' && (
                        <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-forest rounded-t-full" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
                  {activeTab === 'workspace' ? (
                    <div className="flex flex-col gap-4">
                      {activeWorkspace && activeWorkspace.access_granted ? (
                        <div className="rounded-[1.1rem] border border-sage-strong/70 bg-white/88 px-4 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
                              <CheckCircle2 className="size-5" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-ink truncate" title={activeWorkspace.root_path || activeWorkspace.label}>
                                {activeWorkspace.root_path || activeWorkspace.label}
                              </p>
                              <p className="text-xs text-ink-soft mt-1">Linked workspace</p>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              disabled={updateWorkspace.isPending}
                              onClick={() => updateWorkspace.mutate({
                                workspaceId: activeWorkspace.id,
                                patch: { access_granted: false }
                              })}
                            >
                              Unlink
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-4 rounded-[1.1rem] border border-dashed border-sage-strong/70 bg-white/50 p-5 text-center">
                          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-sage/60 text-forest">
                            <FolderOpen className="size-5" />
                          </div>
                          <div>
                            <h3 className="font-medium text-forest">Link a local workspace</h3>
                            <p className="mt-1 text-sm text-ink-soft leading-relaxed">
                              Provide the full absolute path to your local repository.<br />The AI will be able to read and make direct edits here.
                            </p>
                          </div>
                          <div className="mt-2 flex flex-col sm:flex-row items-center gap-2">
                            <Input
                              value={workspacePath}
                              onChange={(e) => setWorkspacePath(e.target.value)}
                              placeholder="/Users/name/projects/my-app"
                              className="h-10 rounded-xl border-sage-strong bg-white/90 focus-visible:border-forest/60 focus-visible:ring-ring/20"
                            />
                            <Button
                              type="button"
                              className="h-10 shrink-0 w-full sm:w-auto rounded-xl bg-forest px-6 text-white hover:bg-forest/92"
                              disabled={createWorkspace.isPending || !workspacePath.trim()}
                              onClick={() => {
                                const path = workspacePath.trim()
                                createWorkspace.mutate({
                                  label: path.split('/').pop() || 'workspace',
                                  relativePath: path,
                                  isPrimary: true,
                                })
                              }}
                            >
                              {createWorkspace.isPending ? 'Linking…' : 'Link'}
                            </Button>
                          </div>
                          {createWorkspace.error ? (
                            <p className="text-sm text-red-600">
                              {createWorkspace.error instanceof Error
                                ? createWorkspace.error.message
                                : 'Failed to link workspace.'}
                            </p>
                          ) : null}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-4 h-full">
                      <div className="flex justify-between items-center shrink-0">
                        <p className="text-sm text-ink-soft">
                          Attach knowledge to this project.
                        </p>
                        <Button
                          type="button"
                          variant="outline"
                          className="h-9 rounded-full border-sage-strong bg-white/80 px-4 text-sm text-ink shadow-none hover:bg-sage"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploadAsset.isPending}
                        >
                          <ImageUp className="size-4 mr-2" />
                          Upload
                        </Button>
                      </div>

                      {assets.length > 0 ? (
                        <div className="flex flex-col gap-3 pb-2">
                          {assets.map((asset) => (
                            <div
                              key={asset.id}
                              className="group flex items-center justify-between gap-3 rounded-[1.1rem] border border-sage-strong/70 bg-white/88 px-3 py-3 transition-colors hover:border-sage-strong sm:px-4"
                            >
                              <div className="min-w-0 flex-1 flex items-center gap-3">
                                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sage/50 text-moss">
                                  <Paperclip className="size-4" />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-sm font-medium text-ink">{asset.original_name}</p>
                                  <div className="flex items-center gap-2 mt-0.5">
                                    <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-moss">{asset.kind}</span>
                                    <span className="text-[10px] text-ink-soft">•</span>
                                    <span className="text-[10px] text-ink-soft">{formatBytes(asset.size_bytes)}</span>
                                  </div>
                                </div>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                className="size-8 text-moss/50 transition-colors hover:text-red-600 hover:bg-red-50"
                                onClick={() => deleteAsset.mutate(asset.id)}
                                disabled={deleteAsset.isPending}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex min-h-[12rem] flex-1 flex-col items-center justify-center gap-4 rounded-[1.1rem] border border-dashed border-sage-strong/60 bg-white/50 p-5 text-center">
                          <div className="flex size-12 items-center justify-center rounded-full bg-sage/60 text-forest">
                            <ImageUp className="size-5" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-forest">No resources yet</p>
                            <p className="mt-1 text-xs text-ink-soft max-w-[200px] mx-auto">
                              Supported files: .pdf, .docx, .csv, .xlsx, .txt, .md, .png, .jpg
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

function formatTimestamp(value: string) {
  return new Date(value).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
