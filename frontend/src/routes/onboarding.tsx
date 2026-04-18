import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { apiFetch } from '../lib/api'
import { useAppStore } from '../stores/appStore'
import { PageShell } from '../components/layout'
import { Button, Input } from '../components/ui'
import { animation } from '../config/design'
import type { User } from '../types/api'

export const Route = createFileRoute('/onboarding')({
  component: OnboardingPage,
})

interface FormValues {
  display_name: string
}

function OnboardingPage() {
  const navigate  = useNavigate()
  const setUser   = useAppStore((s) => s.setUser)

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<FormValues>()

  const name = watch('display_name', '')

  const { mutate, isPending, error } = useMutation({
    mutationFn: (data: FormValues) =>
      apiFetch<User>('/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          display_name: data.display_name.trim(),
          preferences: {},
        }),
      }),
    onSuccess: (user) => {
      setUser(user)
      navigate({ to: '/projects' })
    },
  })

  return (
    <PageShell>
      <div className="w-full max-w-md px-6">
        <form
          onSubmit={handleSubmit((d) => mutate(d))}
          className="flex flex-col gap-10"
        >

          {/* ── Heading ───────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationSlow, ease: animation.spring }}
          >
            <h1 className="font-display text-[clamp(36px,5.5vw,52px)] font-light leading-[1.1] tracking-tight text-ivory">
              What shall I call you?
            </h1>
            <p className="mt-4 text-[15px] font-light leading-relaxed text-ivory-muted">
              Socrates will remember your name.
            </p>
          </motion.div>

          {/* ── Name input ────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, delay: 0.15, ease: 'easeOut' }}
          >
            <Input
              placeholder="Your name"
              autoFocus
              autoComplete="off"
              error={errors.display_name ? 'Please enter your name.' : undefined}
              {...register('display_name', {
                required: true,
                validate: (v) => v.trim().length > 0,
              })}
            />
          </motion.div>

          {/* ── API error ─────────────────────────────────────── */}
          {error && (
            <p className="text-sm text-red-400">{error.message}</p>
          )}

          {/* ── Submit ────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, delay: 0.28, ease: 'easeOut' }}
          >
            <Button
              type="submit"
              size="lg"
              className="w-full"
              disabled={!name?.trim()}
              isLoading={isPending}
            >
              Begin
              <ArrowRight size={16} />
            </Button>
          </motion.div>

        </form>
      </div>
    </PageShell>
  )
}
