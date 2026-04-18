import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useState, useEffect } from 'react'
import { MessageSquare, Plus, ChevronRight } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import { useAppStore } from '../../stores/appStore'
import type { Project, Conversation } from '../../types/api'

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectDetailPage,
})

function ProjectDetailPage() {
  const { projectId } = Route.useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const setActiveConversation = useAppStore((s) => s.setActiveConversation)
  const setActiveProject = useAppStore((s) => s.setActiveProject)
  const [showNew, setShowNew] = useState(false)

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiFetch<Project>(`/projects/${projectId}`),
  })

  useEffect(() => {
    if (project) setActiveProject(project)
  }, [project, setActiveProject])

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', projectId],
    queryFn: () => apiFetch<Conversation[]>(`/projects/${projectId}/conversations`),
  })

  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ title: string }>()

  const createConversation = useMutation({
    mutationFn: (data: { title: string }) =>
      apiFetch<Conversation>(`/projects/${projectId}/conversations`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: (conv) => {
      qc.invalidateQueries({ queryKey: ['conversations', projectId] })
      setActiveConversation(conv)
      setShowNew(false)
      reset()
      navigate({ to: '/projects/$projectId/conversations/$conversationId', params: { projectId, conversationId: conv.id } })
    },
  })

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Project header */}
      <div className="border-b border-[var(--color-border)] px-8 py-5">
        <h1 className="font-serif text-xl font-semibold text-[var(--color-text)]">
          {project?.name ?? '…'}
        </h1>
        {project?.description && (
          <p className="mt-0.5 text-sm text-[var(--color-muted)]">{project.description}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--color-muted)]">
            Conversations
          </h2>
          <button
            onClick={() => setShowNew(true)}
            className="flex items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
          >
            <Plus size={12} />
            New
          </button>
        </div>

        {/* New conversation inline form */}
        {showNew && (
          <form
            onSubmit={handleSubmit((d) => createConversation.mutate(d))}
            className="mb-3 rounded-[var(--radius-md)] border border-[var(--color-accent-soft)] bg-[var(--color-accent-ghost)] p-4"
          >
            <input
              type="text"
              autoFocus
              placeholder="Conversation title…"
              className="w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-white px-3 py-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-placeholder)] outline-none focus:border-[var(--color-accent-mid)] focus:ring-2 focus:ring-[var(--color-accent-ghost)] transition-all"
              {...register('title', { required: true })}
            />
            {errors.title && (
              <p className="mt-1 text-xs text-[var(--color-error)]">Title is required</p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                type="submit"
                disabled={createConversation.isPending}
                className="rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-accent-mid)] disabled:opacity-50 transition-colors"
              >
                {createConversation.isPending ? 'Creating…' : 'Create'}
              </button>
              <button
                type="button"
                onClick={() => { setShowNew(false); reset() }}
                className="rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium text-[var(--color-muted)] hover:bg-[var(--color-surface)] transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        {/* Conversation list */}
        <div className="space-y-1">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => {
                setActiveConversation(conv)
                navigate({ to: '/projects/$projectId/conversations/$conversationId', params: { projectId, conversationId: conv.id } })
              }}
              className="group flex w-full items-center gap-3 rounded-[var(--radius-md)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-surface-raised)]"
            >
              <MessageSquare size={15} className="shrink-0 text-[var(--color-muted)] group-hover:text-[var(--color-accent-mid)]" />
              <span className="flex-1 truncate text-sm text-[var(--color-text)]">{conv.title}</span>
              <ChevronRight size={13} className="shrink-0 text-[var(--color-border-strong)] group-hover:text-[var(--color-muted)]" />
            </button>
          ))}

          {conversations.length === 0 && !showNew && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm text-[var(--color-muted)]">No conversations yet.</p>
              <button
                onClick={() => setShowNew(true)}
                className="mt-3 text-sm font-medium text-[var(--color-accent)] underline-offset-2 hover:underline"
              >
                Start the first one
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
