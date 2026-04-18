import { startTransition, useEffect, useState } from 'react'
import {
  createFileRoute,
  Link,
  Outlet,
  useMatchRoute,
  useNavigate,
} from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { ArrowLeft, ChevronRight, LoaderCircle, MessageSquarePlus, MessagesSquare } from 'lucide-react'

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
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import {
  InputGroup,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Separator } from '@/components/ui/separator'
import { apiFetch } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/stores/appStore'
import type { Conversation, Project } from '@/types/api'

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectWorkspace,
})

function ProjectWorkspace() {
  const { projectId } = Route.useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const matchRoute = useMatchRoute()
  const setActiveConversation = useAppStore((state) => state.setActiveConversation)
  const setActiveProject = useAppStore((state) => state.setActiveProject)
  const [showCreate, setShowCreate] = useState(false)

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiFetch<Project>(`/projects/${projectId}`),
  })

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => apiFetch<Conversation[]>(`/projects/${projectId}/conversations`),
  })

  useEffect(() => {
    if (project) {
      setActiveProject(project)
    }
  }, [project, setActiveProject])

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<{ title: string }>({
    defaultValues: {
      title: '',
    },
  })

  const createConversation = useMutation({
    mutationFn: (data: { title: string }) =>
      apiFetch<Conversation>(`/projects/${projectId}/conversations`, {
        method: 'POST',
        body: JSON.stringify({ title: data.title.trim() }),
      }),
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: ['conversations', projectId] })
      setActiveConversation(conversation)
      setShowCreate(false)
      reset()
      startTransition(() => {
        navigate({
          to: '/projects/$projectId/conversations/$conversationId',
          params: { projectId, conversationId: conversation.id },
        })
      })
    },
  })

  return (
    <>
      <div className="grid h-full min-h-0 w-full flex-1 gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <aside className="flex min-h-0 h-full flex-col rounded-[2rem] border border-sage-strong/80 bg-paper/90 shadow-[0_24px_60px_rgba(62,92,72,0.08)]">
          <div className="flex flex-col gap-5 px-6 py-6">
            <Button
              asChild
              variant="ghost"
              className="h-10 w-fit rounded-full px-0 text-sm text-ink-soft hover:bg-transparent hover:text-forest"
            >
              <Link to="/projects">
                <ArrowLeft data-icon="inline-start" />
                All projects
              </Link>
            </Button>

            <div className="flex flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-moss">
                Project
              </p>
              <div className="flex flex-col gap-2">
                <h1 className="font-display text-4xl leading-none tracking-tight text-forest">
                  {project?.name ?? 'Project'}
                </h1>
                <p className="text-sm leading-6 text-ink-soft">
                  {project?.description ?? 'Select a conversation or begin a new line of inquiry.'}
                </p>
              </div>
            </div>

            <Button
              className="h-11 rounded-full bg-forest px-5 text-sm text-white hover:bg-forest/92"
              onClick={() => setShowCreate(true)}
            >
              <MessageSquarePlus data-icon="inline-start" />
              New conversation
            </Button>
          </div>

          <Separator className="bg-sage-strong/80" />

          <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 py-5">
            <div className="flex items-center justify-between px-2">
              <p className="text-xs font-semibold uppercase tracking-[0.24em] text-moss">
                Conversations
              </p>
              <p className="text-xs text-ink-soft">{conversations.length}</p>
            </div>

            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {conversations.map((conversation) => {
                const isActive = matchRoute({
                  to: '/projects/$projectId/conversations/$conversationId',
                  params: { projectId, conversationId: conversation.id },
                })

                return (
                  <Link
                    key={conversation.id}
                    to="/projects/$projectId/conversations/$conversationId"
                    params={{ projectId, conversationId: conversation.id }}
                    onClick={() => setActiveConversation(conversation)}
                    className={cn(
                      'group flex items-center gap-3 rounded-[1.4rem] border px-4 py-3 text-sm transition',
                      isActive
                        ? 'border-moss/35 bg-sage text-forest shadow-[0_10px_24px_rgba(62,92,72,0.08)]'
                        : 'border-transparent bg-transparent text-ink-soft hover:border-sage-strong hover:bg-white/80 hover:text-forest',
                    )}
                  >
                    <MessagesSquare className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                    <ChevronRight className="size-4 shrink-0 opacity-60 transition group-hover:translate-x-0.5" />
                  </Link>
                )
              })}

              {conversations.length === 0 ? (
                <div className="rounded-[1.5rem] border border-dashed border-sage-strong bg-sage/35 px-5 py-8 text-center text-sm leading-6 text-ink-soft">
                  No conversations yet. Start the first one and Socrates will keep the thread
                  anchored here.
                </div>
              ) : null}
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 h-full flex-col overflow-hidden rounded-[2rem] border border-sage-strong/80 bg-white/82 shadow-[0_28px_70px_rgba(62,92,72,0.08)]">
          <Outlet />
        </section>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="rounded-[1.75rem] border-sage-strong bg-paper p-0 sm:max-w-lg">
          <form onSubmit={handleSubmit((data) => createConversation.mutate(data))}>
            <DialogHeader className="gap-3 border-b border-sage-strong/70 px-6 py-6">
              <DialogTitle className="font-display text-3xl text-forest">
                Start a conversation
              </DialogTitle>
              <DialogDescription className="text-sm leading-6 text-ink-soft">
                Conversations stay scoped to this project. Give this one a clear title so you can
                return to it later.
              </DialogDescription>
            </DialogHeader>

            <div className="px-6 py-6">
              <FieldGroup>
                <Field data-invalid={errors.title ? true : undefined}>
                  <FieldLabel htmlFor="conversation-title">Conversation title</FieldLabel>
                  <InputGroup className="h-12 rounded-2xl border-sage-strong bg-white">
                    <InputGroupInput
                      id="conversation-title"
                      autoFocus
                      aria-invalid={errors.title ? true : undefined}
                      placeholder="Database normalization questions with diagrams"
                      className="text-base text-ink placeholder:text-ink-soft/45"
                      {...register('title', {
                        required: 'Conversation title is required.',
                        validate: (value) =>
                          value.trim().length > 0 || 'Conversation title is required.',
                      })}
                    />
                  </InputGroup>
                  <FieldError errors={[errors.title]} />
                </Field>
              </FieldGroup>
            </div>

            <DialogFooter className="border-t border-sage-strong/70 px-6 py-5">
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-full border-sage-strong bg-white px-5 text-ink shadow-none hover:bg-sage"
                onClick={() => {
                  setShowCreate(false)
                  reset()
                }}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                className="h-11 rounded-full bg-forest px-5 text-white hover:bg-forest/92"
                disabled={createConversation.isPending}
              >
                {createConversation.isPending ? (
                  <LoaderCircle className="animate-spin" data-icon="inline-start" />
                ) : (
                  <MessageSquarePlus data-icon="inline-start" />
                )}
                Create conversation
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
