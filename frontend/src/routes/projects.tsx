import { createFileRoute, Outlet, useNavigate, Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { useState, useEffect } from 'react'
import { Plus, MessageSquare } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useAppStore } from '../stores/appStore'
import type { Project, User } from '../types/api'

export const Route = createFileRoute('/projects')({
  component: ProjectsShell,
})

function ProjectsShell() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { setActiveProject, user, setUser } = useAppStore()
  const [showNewProject, setShowNewProject] = useState(false)

  // Fetch user if not already in store
  const { data: fetchedUser } = useQuery({
    queryKey: ['me'],
    queryFn: () => apiFetch<User>('/me'),
    enabled: !user,
  })
  useEffect(() => {
    if (fetchedUser) setUser(fetchedUser)
  }, [fetchedUser, setUser])

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiFetch<Project[]>('/projects'),
  })

  const { register, handleSubmit, reset, formState: { errors } } = useForm<{ name: string; description: string }>()

  const createProject = useMutation({
    mutationFn: (data: { name: string; description: string }) =>
      apiFetch<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    onSuccess: (p) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      setActiveProject(p)
      setShowNewProject(false)
      reset()
      navigate({ to: '/projects/$projectId', params: { projectId: p.id } })
    },
  })

  return (
    <div className="flex h-full bg-[var(--color-base)]">
      {/* Left Rail */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-[var(--color-border)] bg-[var(--color-surface)] py-6">
        {/* Brand */}
        <div className="px-5 mb-8">
          <span className="font-serif text-xl font-semibold text-[var(--color-accent)]">
            PremChat
          </span>
        </div>

        {/* Projects list */}
        <div className="flex-1 overflow-y-auto px-3">
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-[var(--color-muted)]">
              Projects
            </span>
            <button
              onClick={() => setShowNewProject(true)}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--color-muted)] transition-colors hover:bg-[var(--color-border)] hover:text-[var(--color-accent)]"
              title="New project"
            >
              <Plus size={13} />
            </button>
          </div>

          <nav className="space-y-0.5">
            {projects.map((p) => (
              <Link
                key={p.id}
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                onClick={() => setActiveProject(p)}
                className="flex items-center gap-2.5 rounded-[var(--radius-sm)] px-2 py-2 text-sm text-[var(--color-text)] transition-colors hover:bg-[var(--color-surface-raised)] [&.active]:bg-[var(--color-accent-ghost)] [&.active]:text-[var(--color-accent)]"
              >
                <MessageSquare size={14} className="shrink-0 text-[var(--color-muted)]" />
                <span className="truncate">{p.name}</span>
              </Link>
            ))}

            {projects.length === 0 && !showNewProject && (
              <p className="px-2 py-3 text-xs text-[var(--color-muted)]">
                No projects yet. Create one to start.
              </p>
            )}
          </nav>
        </div>

        {/* User footer */}
        {user && (
          <div className="mt-auto px-5 pt-4 border-t border-[var(--color-border)]">
            <p className="text-xs font-medium text-[var(--color-text)] truncate">{user.display_name}</p>
            <p className="text-[10px] text-[var(--color-muted)]">Local workspace</p>
          </div>
        )}
      </aside>

      {/* Main workspace */}
      <main className="flex flex-1 flex-col overflow-hidden">
        {showNewProject ? (
          <NewProjectForm
            onClose={() => { setShowNewProject(false); reset() }}
            register={register}
            handleSubmit={handleSubmit}
            errors={errors}
            isPending={createProject.isPending}
            onSubmit={(d) => createProject.mutate(d)}
          />
        ) : (
          <Outlet />
        )}
      </main>
    </div>
  )
}

function NewProjectForm({
  onClose,
  register,
  handleSubmit,
  errors,
  isPending,
  onSubmit,
}: {
  onClose: () => void
  register: ReturnType<typeof useForm<{ name: string; description: string }>>['register']
  handleSubmit: ReturnType<typeof useForm<{ name: string; description: string }>>['handleSubmit']
  errors: ReturnType<typeof useForm<{ name: string; description: string }>>['formState']['errors']
  isPending: boolean
  onSubmit: (d: { name: string; description: string }) => void
}) {
  return (
    <div className="flex flex-1 items-center justify-center bg-[var(--color-base)] px-6">
      <div className="w-full max-w-md">
        <h2 className="mb-1 font-serif text-2xl font-semibold text-[var(--color-text)]">
          New project
        </h2>
        <p className="mb-8 text-sm text-[var(--color-muted)]">
          Every conversation with Socrates lives inside a project.
        </p>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wider text-[var(--color-muted)] mb-1.5">
              Project name
            </label>
            <input
              type="text"
              autoFocus
              placeholder="e.g. Quant Research"
              className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-placeholder)] outline-none focus:border-[var(--color-accent-mid)] focus:ring-2 focus:ring-[var(--color-accent-ghost)] transition-all"
              {...register('name', { required: 'Project name is required' })}
            />
            {errors.name && (
              <p className="mt-1 text-xs text-[var(--color-error)]">{errors.name.message}</p>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium uppercase tracking-wider text-[var(--color-muted)] mb-1.5">
              Description <span className="normal-case font-normal">(optional)</span>
            </label>
            <textarea
              placeholder="What is this project about?"
              rows={3}
              className="w-full resize-none rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-4 py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-placeholder)] outline-none focus:border-[var(--color-accent-mid)] focus:ring-2 focus:ring-[var(--color-accent-ghost)] transition-all"
              {...register('description')}
            />
          </div>

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={isPending}
              className="flex-1 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-white hover:bg-[var(--color-accent-mid)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isPending ? 'Creating…' : 'Create project'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-2.5 text-sm font-medium text-[var(--color-muted)] hover:bg-[var(--color-surface)] transition-colors"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
