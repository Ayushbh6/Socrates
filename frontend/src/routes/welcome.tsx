import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { ArrowRight, LoaderCircle } from 'lucide-react'

import { PageShell } from '@/components/layout'
import { Button } from '@/components/ui/button'
import { animation } from '@/config/design'
import {
  bootstrapQueryOptions,
  getWelcomeDestination,
  hasCompletedOnboarding,
} from '@/lib/bootstrap'

export const Route = createFileRoute('/welcome')({
  component: WelcomePage,
})

function WelcomePage() {
  const navigate = useNavigate()
  const { data, isPending, isError } = useQuery(bootstrapQueryOptions())

  const nextPath = data ? getWelcomeDestination(data) : '/onboarding'
  const isReturningUser = data ? hasCompletedOnboarding(data) : false

  return (
    <PageShell>
      <div className="flex w-full flex-col items-center px-6 text-center">
        <div className="flex max-w-2xl flex-col items-center gap-8">

          {/* Eyebrow */}
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, ease: animation.spring }}
            className="text-xs font-medium uppercase tracking-[0.25em] text-teal"
          >
            Your thinking workspace
          </motion.p>

          {/* Display title */}
          <motion.h1
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationSlow, delay: 0.1, ease: animation.spring }}
            className="font-display text-gradient-teal text-[clamp(80px,13vw,148px)] font-semibold leading-none tracking-tight"
          >
            Socrates
          </motion.h1>

          {/* Tagline */}
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, delay: 0.22, ease: 'easeOut' }}
            className="flex max-w-md flex-col gap-3"
          >
            <p className="text-[17px] font-light leading-relaxed tracking-wide text-ink-soft">
              Think clearly. Ask well. Live examined.
            </p>
            <p className="text-sm text-ink-soft/75">
              {isReturningUser
                ? 'Your workspace is ready. Return directly to your projects.'
                : 'Begin once, and Socrates will remember who you are.'}
            </p>
          </motion.div>

          {/* Primary CTA */}
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, delay: 0.36, ease: 'easeOut' }}
            className="mt-4 flex flex-col items-center gap-4"
          >
            <Button
              size="lg"
              className="h-14 rounded-full bg-forest px-7 text-[15px] font-semibold text-white shadow-[0_14px_38px_rgba(27,53,41,0.18)] hover:bg-forest/92"
              disabled={isPending || isError}
              onClick={() => navigate({ to: nextPath, replace: isReturningUser })}
            >
              {isPending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
              {isReturningUser ? 'Open Workspace' : 'Talk to Socrates'}
              <ArrowRight data-icon="inline-end" />
            </Button>

            {isError ? (
              <p className="text-sm text-red-300">
                Socrates cannot reach the local backend yet. Start the backend first, then refresh.
              </p>
            ) : null}
          </motion.div>

        </div>
      </div>
    </PageShell>
  )
}
