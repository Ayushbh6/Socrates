import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { PageShell } from '../components/layout'
import { Button } from '../components/ui'
import { animation } from '../config/design'

export const Route = createFileRoute('/welcome')({
  component: WelcomePage,
})

function WelcomePage() {
  const navigate = useNavigate()

  return (
    <PageShell>
      <div className="flex flex-col items-center gap-8 px-6 text-center">

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
        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: animation.durationBase, delay: 0.22, ease: 'easeOut' }}
          className="max-w-sm text-[17px] font-light leading-relaxed tracking-wide text-ivory-muted"
        >
          Think clearly. Ask well. Live examined.
        </motion.p>

        {/* Primary CTA */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: animation.durationBase, delay: 0.36, ease: 'easeOut' }}
          className="mt-2"
        >
          <Button
            size="lg"
            onClick={() => navigate({ to: '/onboarding' })}
          >
            Talk to Socrates
            <ArrowRight size={16} />
          </Button>
        </motion.div>

      </div>
    </PageShell>
  )
}
