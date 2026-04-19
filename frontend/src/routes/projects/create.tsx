import { startTransition } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useForm, useWatch } from 'react-hook-form'
import { motion } from 'framer-motion'
import { ArrowLeft, FolderPlus, LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { animation } from '@/config/design'
import { apiFetch } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'
import type { Project } from '@/types/api'

export const Route = createFileRoute('/projects/create')({
  component: CreateProjectPage,
})

interface CreateForm {
  name: string
  description: string
}

function CreateProjectPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const setActiveProject = useAppStore((state) => state.setActiveProject)

  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<CreateForm>({
    defaultValues: { name: '', description: '' },
  })

  const name = useWatch({ control, name: 'name', defaultValue: '' })

  const createProject = useMutation({
    mutationFn: (data: CreateForm) =>
      apiFetch<Project>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: data.name.trim(),
          description: data.description.trim() || null,
        }),
      }),
    onSuccess: (project) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      setActiveProject(project)
      startTransition(() => {
        navigate({
          to: '/projects/$projectId/dashboard',
          params: { projectId: project.id },
        })
      })
    },
  })

  return (
    <div className="flex h-full min-h-0 w-full items-start justify-center overflow-y-auto py-10 sm:items-center sm:py-0">
      <div className="w-full max-w-xl px-4">
        <form
          onSubmit={handleSubmit((d) => createProject.mutate(d))}
          className="flex flex-col gap-8"
        >
          {/* ── Back link ─────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationFast, ease: animation.spring }}
          >
            <Link
              to="/projects"
              className="inline-flex items-center gap-2 rounded-full border border-sage-strong bg-white/85 px-4 py-2 text-sm text-ink-soft transition hover:bg-sage hover:text-forest"
            >
              <ArrowLeft className="size-4" />
              All projects
            </Link>
          </motion.div>

          {/* ── Heading ───────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 28 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationSlow, ease: animation.spring }}
            className="flex flex-col gap-3"
          >
            <h1 className="font-display text-[clamp(36px,5.5vw,52px)] font-light leading-[1.1] tracking-tight text-forest">
              Create a project
            </h1>
            <p className="text-[15px] font-light leading-relaxed text-ink-soft">
              Every conversation with Socrates lives inside a project. Give it a name and optionally
              describe what you&rsquo;re working on.
            </p>
          </motion.div>

          {/* ── Form fields ───────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, delay: 0.12, ease: 'easeOut' }}
          >
            <FieldGroup>
              <Field data-invalid={errors.name ? true : undefined}>
                <FieldLabel htmlFor="project-name" className="text-ink-soft">
                  What are you working on?
                </FieldLabel>
                <Input
                  id="project-name"
                  placeholder="Name your project"
                  autoFocus
                  autoComplete="off"
                  aria-invalid={errors.name ? true : undefined}
                  className="h-12 rounded-2xl border-sage-strong bg-white px-4 text-base text-ink placeholder:text-ink-soft/45 focus-visible:border-moss/50 focus-visible:ring-ring/25"
                  {...register('name', {
                    required: 'Project name is required.',
                    validate: (v) => v.trim().length > 0 || 'Project name is required.',
                  })}
                />
                <FieldError errors={[errors.name]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="project-description" className="text-ink-soft">
                  What are you trying to achieve?
                </FieldLabel>
                <Textarea
                  id="project-description"
                  rows={4}
                  placeholder="Describe your project, goals, subject, etc..."
                  className="rounded-2xl border-sage-strong bg-white px-4 py-3 text-base text-ink placeholder:text-ink-soft/45 focus-visible:border-moss/50 focus-visible:ring-ring/25"
                  {...register('description')}
                />
                <FieldDescription className="text-ink-soft/75">
                  Optional — helps Socrates understand your project context.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </motion.div>

          {/* ── API error ─────────────────────────────────────── */}
          {createProject.error ? (
            <p className="text-sm text-destructive">
              {createProject.error instanceof Error
                ? createProject.error.message
                : 'Something went wrong. Please try again.'}
            </p>
          ) : null}

          {/* ── Actions ───────────────────────────────────────── */}
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: animation.durationBase, delay: 0.24, ease: 'easeOut' }}
            className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end"
          >
            <Button
              type="button"
              variant="outline"
              className="h-12 rounded-full border-sage-strong bg-white/80 px-6 text-sm text-ink shadow-none hover:bg-sage"
              onClick={() => startTransition(() => navigate({ to: '/projects' }))}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="h-12 rounded-full bg-forest px-6 text-[15px] font-semibold text-white shadow-[0_14px_38px_rgba(27,53,41,0.18)] hover:bg-forest/92"
              disabled={!name?.trim() || createProject.isPending}
            >
              {createProject.isPending ? (
                <LoaderCircle className="animate-spin" data-icon="inline-start" />
              ) : (
                <FolderPlus data-icon="inline-start" />
              )}
              Create project
            </Button>
          </motion.div>
        </form>
      </div>
    </div>
  )
}
