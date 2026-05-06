import { createFileRoute, Link, Outlet, redirect, useRouterState } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileSearch, FolderOpen, Home } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  bootstrapQueryOptions,
  hasCompletedOnboarding,
  meQueryOptions,
} from '@/lib/bootstrap'
import { apiFetch } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'
import type { Task } from '@/types/api'

export const Route = createFileRoute('/projects')({
  beforeLoad: async ({ context }) => {
    const bootstrap = await context.queryClient.ensureQueryData(bootstrapQueryOptions())

    if (!hasCompletedOnboarding(bootstrap)) {
      throw redirect({ to: '/welcome', replace: true })
    }

    await context.queryClient.ensureQueryData(meQueryOptions())
  },
  component: ProjectsLayout,
})

function ProjectsLayout() {
  const { data: user } = useQuery(meQueryOptions())
  const setUser = useAppStore((state) => state.setUser)
  const activeProject = useAppStore((state) => state.activeProject)
  const activeConversation = useAppStore((state) => state.activeConversation)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const conversationRouteMatch = pathname.match(/^\/projects\/[^/]+\/dashboard\/conversations\/([^/]+)$/)
  const routeConversationId = conversationRouteMatch?.[1] ?? null

  const isProjectWorkspace = /^\/projects\/[^/]+(?:\/.*)?$/.test(pathname) && pathname !== '/projects/create'
  const isProjectDashboardRoute = /^\/projects\/[^/]+\/dashboard$/.test(pathname)
  const isConversationRoute = /^\/projects\/[^/]+\/dashboard\/conversations\/[^/]+$/.test(pathname)
  const { data: conversationTasks = [] } = useQuery({
    queryKey: ['conversation-tasks', routeConversationId],
    queryFn: () => apiFetch<Task[]>(`/conversations/${routeConversationId}/tasks`),
    enabled: Boolean(routeConversationId),
  })
  const hasArtifactWorkspace = isConversationRoute && conversationTasks.length > 0
  const headerCta = isConversationRoute && activeProject
    ? {
        label: 'Project Dashboard',
        to: `/projects/${activeProject.id}/dashboard`,
        icon: FolderOpen,
      }
    : isProjectWorkspace
    ? {
        label: 'Return to Projects',
        to: '/projects',
        icon: FolderOpen,
      }
    : {
        label: 'Return to Homepage',
        to: '/welcome',
        icon: Home,
      }

  const HeaderIcon = headerCta.icon

  useEffect(() => {
    if (user) {
      setUser(user)
    }
  }, [setUser, user])

  return (
    <div className="relative h-screen overflow-hidden bg-canvas text-ink">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-80 bg-[radial-gradient(circle_at_top,_rgba(143,196,170,0.22),_transparent_62%)]"
      />
      {isConversationRoute ? null : (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              'linear-gradient(to right, rgba(104,128,108,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(104,128,108,0.05) 1px, transparent 1px)',
            backgroundSize: '72px 72px',
          }}
        />
      )}

      <div className="relative z-10 flex h-screen flex-col overflow-hidden">
        <header
          className={isConversationRoute ? 'fixed inset-x-0 top-0 z-30 bg-canvas' : 'shrink-0 bg-paper/72 backdrop-blur-xl'}
        >
          <div
            className={isConversationRoute
              ? 'mx-auto flex h-20 w-full max-w-[1440px] items-center justify-between gap-3 px-4 sm:px-6 lg:px-10'
              : 'mx-auto flex min-h-[72px] w-full max-w-[1440px] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-10'}
          >
            <div className="flex min-w-0 items-center gap-3 sm:gap-4">
              <Link
                to="/welcome"
                className="shrink-0 font-display text-[28px] leading-none tracking-tight text-forest transition hover:text-teal-dim"
              >
                Socrates
              </Link>

              {isConversationRoute ? (
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-forest sm:text-[15px]">
                    {activeProject?.name ?? 'Project'}
                  </p>
                  <p className="truncate text-xs text-ink-soft sm:text-sm">
                    {activeConversation?.title ?? 'Conversation'}
                    <span className="px-2 text-moss/60">•</span>
                    {formatHeaderDate(activeConversation?.updated_at)}
                  </p>
                </div>
              ) : (
                <div className="hidden items-center gap-2 text-sm text-ink-soft md:flex">
                  Calm, project-scoped thinking.
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              {hasArtifactWorkspace && routeConversationId ? (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="size-10 rounded-full border-0 bg-white/74 text-moss shadow-none hover:bg-sage/90 hover:text-forest"
                  aria-label="Toggle artifacts panel"
                  title="Toggle artifacts panel"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('premchat:toggle-artifact-panel', {
                        detail: { conversationId: routeConversationId },
                      }),
                    )
                  }}
                >
                  <FileSearch className="size-4" aria-hidden="true" />
                </Button>
              ) : null}
              <Button
                asChild
                variant="outline"
                className="h-10 rounded-full border-0 bg-white/74 px-3 text-sm text-ink shadow-none hover:bg-sage/90 sm:px-4"
              >
                <Link to={headerCta.to}>
                  <HeaderIcon data-icon="inline-start" />
                  {headerCta.label}
                </Link>
              </Button>
              <div className="hidden rounded-full bg-white/72 px-4 py-2 text-sm text-ink-soft sm:block">
                {user?.display_name ?? 'Workspace'}
              </div>
            </div>
          </div>
        </header>

        <main
          className={isConversationRoute
            ? 'mx-auto flex w-full max-w-[1440px] min-h-0 flex-1 overflow-hidden px-0 pt-20'
            : isProjectDashboardRoute
            ? 'mx-auto flex w-full max-w-[1440px] min-h-0 flex-1 overflow-hidden px-0'
            : 'mx-auto flex w-full max-w-[1440px] min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6 lg:px-10 lg:py-6'}
        >
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function formatHeaderDate(value?: string | null) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(value ? new Date(value) : new Date())
}
