import { createFileRoute, Link, redirect, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useWatch } from 'react-hook-form'
import { motion } from 'framer-motion'
import { ArrowLeft, ArrowRight, LoaderCircle } from 'lucide-react'

import { PageShell } from '@/components/layout'
import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { animation } from '@/config/design'
import {
  applyBootstrapCompletion,
  bootstrapQueryOptions,
  hasCompletedOnboarding,
  submitBootstrap,
} from '@/lib/bootstrap'
import { ApiError } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'

export const Route = createFileRoute('/onboarding')({
  beforeLoad: async ({ context }) => {
    const bootstrap = await context.queryClient.ensureQueryData(bootstrapQueryOptions())

    if (hasCompletedOnboarding(bootstrap)) {
      throw redirect({ to: '/projects', replace: true })
    }
  },
  component: OnboardingPage,
})

interface FormValues {
  display_name: string
}

function OnboardingPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setUser = useAppStore((s) => s.setUser)

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<FormValues>()

  const name = useWatch({ control, name: 'display_name', defaultValue: '' })

  const { mutate, isPending, error } = useMutation({
    mutationFn: (data: FormValues) => submitBootstrap(data.display_name),
    onSuccess: ({ user }) => {
      applyBootstrapCompletion(queryClient, user)
      setUser(user)
      navigate({ to: '/projects', replace: true })
    },
  })

  const errorMessage =
    error instanceof ApiError && error.status === 409
      ? null
      : error instanceof Error
        ? error.message
        : null

  return (
    <PageShell>
      <div className="absolute left-6 top-6">
        <Link
          to="/welcome"
          className="inline-flex items-center gap-2 rounded-full border border-sage-strong bg-white/85 px-4 py-2 text-sm text-ink-soft transition hover:bg-sage hover:text-forest"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>
      </div>

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
            <h1 className="font-display text-[clamp(36px,5.5vw,52px)] font-light leading-[1.1] tracking-tight text-forest">
              What shall I call you?
            </h1>
            <p className="mt-4 text-[15px] font-light leading-relaxed text-ink-soft">
              Socrates will remember your name.
            </p>
          </motion.div>

          {/* ── Name input ────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, delay: 0.15, ease: 'easeOut' }}
          >
            <FieldGroup>
              <Field data-invalid={errors.display_name ? true : undefined}>
                <FieldLabel htmlFor="display_name" className="text-ink-soft">
                  Your name
                </FieldLabel>
                <Input
                  id="display_name"
                  placeholder="Ayush"
                  autoFocus
                  autoComplete="off"
                  aria-invalid={errors.display_name ? true : undefined}
                  className="h-12 rounded-2xl border-sage-strong bg-white px-4 text-base text-ink placeholder:text-ink-soft/45 focus-visible:border-moss/50 focus-visible:ring-ring/25"
                  {...register('display_name', {
                    required: 'Please enter your name.',
                    validate: (v) => v.trim().length > 0 || 'Please enter your name.',
                  })}
                />
                <FieldDescription className="text-ink-soft/75">
                  Socrates uses this to personalize your workspace.
                </FieldDescription>
                <FieldError errors={[errors.display_name]} className="text-red-300" />
              </Field>
            </FieldGroup>
          </motion.div>

          {/* ── API error ─────────────────────────────────────── */}
          {errorMessage ? <p className="text-sm text-red-300">{errorMessage}</p> : null}

          {/* ── Submit ────────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, delay: 0.28, ease: 'easeOut' }}
            className="flex flex-col gap-3"
          >
            <Button
              type="submit"
              size="lg"
              className="h-14 w-full rounded-full bg-forest px-7 text-[15px] font-semibold text-white shadow-[0_14px_38px_rgba(27,53,41,0.18)] hover:bg-forest/92"
              disabled={!name?.trim()}
            >
              {isPending ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
              Begin
              <ArrowRight data-icon="inline-end" />
            </Button>

            <p className="text-center text-sm text-ink-soft/70">
              You only need to do this once.
            </p>
          </motion.div>
        </form>
      </div>
    </PageShell>
  )
}
