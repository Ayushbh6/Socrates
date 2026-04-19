import { startTransition, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowRight,
  Clock3,
  FolderOpen,
  ImageUp,
  MessageSquarePlus,
  MessagesSquare,
  MoreVertical,
  Paperclip,
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
import type { Asset, Conversation, Project } from '@/types/api'

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
      // Eagerly swap the renamed conversation in the cache so the new title
      // appears the moment the dialog closes — no refetch wait.
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

  const recentConversations = useMemo(
    () => [...conversations].sort((left, right) => right.updated_at.localeCompare(left.updated_at)),
    [conversations],
  )

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

      <div className="flex w-full flex-col gap-4 pb-4 sm:gap-6">
      <section className="shrink-0 rounded-[2rem] bg-paper/92 px-5 py-5 shadow-[0_24px_60px_rgba(62,92,72,0.08)] sm:px-8 sm:py-8">
        <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
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
              <div className="flex flex-col gap-2">
                <h1 className="font-display text-[clamp(2.75rem,5vw,4.75rem)] leading-[0.94] tracking-tight text-forest">
                  {project?.name ?? 'Project'}
                </h1>
                <p className="max-w-2xl text-[15px] leading-7 text-ink-soft">
                  {project?.description ??
                    'Review past conversations, keep your project resources together, and start a new session whenever a new line of thought begins.'}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row">
            <Button
              type="button"
              variant="outline"
              className="h-11 rounded-full border-sage-strong bg-white/80 px-5 text-sm text-ink shadow-none hover:bg-sage"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadAsset.isPending}
            >
              <ImageUp data-icon="inline-start" />
              {uploadAsset.isPending ? 'Uploading…' : 'Upload resource'}
            </Button>
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
          accept="image/*"
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

      <div className="grid gap-4 xl:grid-cols-[1.4fr_0.95fr] xl:gap-6">
        <section className="flex flex-col rounded-[2rem] bg-white/84 shadow-[0_24px_60px_rgba(62,92,72,0.06)]">
          <div className="flex items-center justify-between gap-4 px-7 py-6">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-moss">
                Conversations
              </p>
              <h2 className="font-display text-3xl tracking-tight text-forest">Past sessions</h2>
            </div>
            <div className="rounded-full border border-sage-strong bg-paper px-3 py-1 text-sm text-ink-soft">
              {recentConversations.length}
            </div>
          </div>

          <div className="px-4 pb-4">
            {recentConversations.length > 0 ? (
              <div className="flex flex-col gap-3">
                {recentConversations.map((conversation) => {
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
                        'group cursor-pointer rounded-[1.6rem] border border-transparent bg-paper/70 px-5 py-5 text-left outline-none transition',
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
                      <div className="mt-4 flex items-center gap-2 text-sm text-ink-soft">
                        <Clock3 className="size-3.5" />
                        Updated {formatTimestamp(conversation.updated_at)}
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="flex min-h-[20rem] flex-col items-center justify-center gap-5 rounded-[1.75rem] border border-dashed border-sage-strong bg-paper/70 px-8 text-center">
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

        <section className="flex flex-col rounded-[2rem] bg-paper/88 shadow-[0_24px_60px_rgba(62,92,72,0.06)]">
          <div className="flex items-center justify-between gap-4 px-7 py-6">
            <div className="flex flex-col gap-1">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-moss">
                Resources
              </p>
              <h2 className="font-display text-3xl tracking-tight text-forest">Project assets</h2>
            </div>
            <div className="rounded-full border border-sage-strong bg-white/80 px-3 py-1 text-sm text-ink-soft">
              {assets.length}
            </div>
          </div>

          <div className="px-4 pb-4">
            {assets.length > 0 ? (
              <div className="flex flex-col gap-3">
                {assets.map((asset) => (
                  <div
                    key={asset.id}
                    className="rounded-[1.6rem] border border-sage-strong/70 bg-white/88 px-5 py-4"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-moss">
                          <Paperclip className="size-3.5" />
                          {asset.kind}
                        </div>
                        <p className="mt-2 truncate font-medium text-ink">{asset.original_name}</p>
                      </div>
                      <span className="text-xs text-ink-soft">{formatBytes(asset.size_bytes)}</span>
                    </div>
                    <p className="mt-3 text-sm text-ink-soft">Added {formatTimestamp(asset.created_at)}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex min-h-[20rem] flex-col items-center justify-center gap-5 rounded-[1.75rem] border border-dashed border-sage-strong bg-white/65 px-8 text-center">
                <div className="flex size-16 items-center justify-center rounded-full bg-sage text-forest">
                  <ImageUp className="size-6" />
                </div>
                <div className="flex max-w-md flex-col gap-3">
                  <h3 className="font-display text-4xl tracking-tight text-forest">No resources yet</h3>
                  <p className="text-sm leading-7 text-ink-soft">
                    Keep project files anchored here. The current slice supports image uploads, and
                    this panel is where project resources live.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 rounded-full border-sage-strong bg-white/80 px-5 text-sm text-ink shadow-none hover:bg-sage"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploadAsset.isPending}
                >
                  <ImageUp data-icon="inline-start" />
                  Upload resource
                </Button>
              </div>
            )}
          </div>
        </section>
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