import { createFileRoute, Link, Outlet, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Home, Sparkles } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import {
  bootstrapQueryOptions,
  hasCompletedOnboarding,
  meQueryOptions,
} from '@/lib/bootstrap'
import { useAppStore } from '@/stores/appStore'

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
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          backgroundImage:
            'linear-gradient(to right, rgba(104,128,108,0.05) 1px, transparent 1px), linear-gradient(to bottom, rgba(104,128,108,0.05) 1px, transparent 1px)',
          backgroundSize: '72px 72px',
        }}
      />

      <div className="relative z-10 flex h-screen flex-col overflow-hidden">
        <header className="shrink-0 border-b border-sage-strong/80 bg-paper/80 backdrop-blur-xl">
          <div className="mx-auto flex h-[72px] w-full max-w-[1440px] items-center justify-between gap-4 px-6 py-4 lg:px-10">
            <div className="flex items-center gap-4">
              <Link
                to="/welcome"
                className="font-display text-[28px] leading-none tracking-tight text-forest transition hover:text-teal-dim"
              >
                Socrates
              </Link>
              <Separator orientation="vertical" className="hidden h-6 bg-sage-strong md:block" />
              <div className="hidden items-center gap-2 text-sm text-ink-soft md:flex">
                <Sparkles className="size-4 text-moss" />
                Calm, project-scoped thinking.
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Button
                asChild
                variant="outline"
                className="h-10 rounded-full border-sage-strong bg-paper px-4 text-sm text-ink shadow-none hover:bg-sage"
              >
                <Link to="/welcome">
                  <Home data-icon="inline-start" />
                  Welcome
                </Link>
              </Button>
              <div className="hidden rounded-full border border-sage-strong bg-white/80 px-4 py-2 text-sm text-ink-soft sm:block">
                {user?.display_name ?? 'Workspace'}
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto flex w-full max-w-[1440px] min-h-0 flex-1 overflow-hidden px-4 py-4 sm:px-6 lg:px-10 lg:py-6">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
