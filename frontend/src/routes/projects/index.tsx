import { startTransition, useDeferredValue, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useForm } from 'react-hook-form'
import { motion } from 'framer-motion'
import { FolderPlus, LoaderCircle, Search, Sparkles, X } from 'lucide-react'

import { ProjectCard } from '@/components/projects/ProjectCard'
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
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { animation } from '@/config/design'
import { apiFetch } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'
import type { Project } from '@/types/api'

export const Route = createFileRoute('/projects/')({
  component: ProjectsHome,
})

interface CreateForm {
  name: string
  description: string
}

function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

function ProjectsHome() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const user = useAppStore((state) => state.user)
  const setActiveProject = useAppStore((state) => state.setActiveProject)
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)
  const [showCreate, setShowCreate] = useState(false)

  const { data: projects = [], isPending } = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiFetch<Project[]>('/projects'),
  })

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateForm>({
    defaultValues: {
      name: '',
      description: '',
    },
  })

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
      setShowCreate(false)
      reset()
      startTransition(() => {
        navigate({
          to: '/projects/$projectId',
          params: { projectId: project.id },
        })
      })
    },
  })

  const filteredProjects = useMemo(() => {
    const term = deferredSearch.trim().toLowerCase()

    if (!term) {
      return projects
    }

    return projects.filter((project) => {
      return (
        project.name.toLowerCase().includes(term) ||
        (project.description ?? '').toLowerCase().includes(term)
      )
    })
  }, [deferredSearch, projects])

  const displayName = user?.display_name ?? 'Your'

  return (
    <>
      <div className="flex h-full min-h-0 w-full flex-col gap-5 overflow-hidden">
        <motion.section
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: animation.durationBase, ease: animation.spring }}
          className="shrink-0 rounded-[2rem] border border-sage-strong/70 bg-paper/95 px-6 py-6 shadow-[0_24px_60px_rgba(62,92,72,0.08)] sm:px-8 sm:py-7"
        >
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex max-w-2xl flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-moss">
                {getGreeting()}
              </p>
              <div className="flex flex-col gap-2">
                <h1 className="font-display text-[clamp(2.45rem,4.6vw,4.25rem)] leading-[0.96] tracking-tight text-forest">
                  {displayName}&rsquo;s workspace
                </h1>
                <p className="max-w-2xl text-[15px] leading-7 text-ink-soft">
                  Your projects are the center of Socrates. Gather a domain of thought, keep
                  every conversation inside it, and return later with the full context intact.
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                variant="outline"
                className="h-11 rounded-full border-sage-strong bg-white/80 px-5 text-sm text-ink shadow-none hover:bg-sage"
                onClick={() => startTransition(() => navigate({ to: '/welcome' }))}
              >
                Return to Welcome
              </Button>
              <Button
                className="h-11 rounded-full bg-forest px-5 text-sm text-white shadow-[0_16px_40px_rgba(27,53,41,0.18)] hover:bg-forest/92"
                onClick={() => setShowCreate(true)}
              >
                <FolderPlus data-icon="inline-start" />
                New Project
              </Button>
            </div>
          </div>
        </motion.section>

        <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
          <div className="shrink-0 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-sm text-ink-soft">
              <Sparkles className="size-4 text-moss" />
              Keep everything project-scoped. No global chat, no lost context.
            </div>

            <div className="w-full sm:max-w-md">
              <InputGroup className="h-11 rounded-full border-sage-strong bg-paper shadow-[0_10px_30px_rgba(62,92,72,0.05)]">
                <InputGroupAddon>
                  <InputGroupText>
                    <Search />
                  </InputGroupText>
                </InputGroupAddon>
                <InputGroupInput
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search projects"
                  className="text-sm text-ink placeholder:text-ink-soft/55"
                />
                {search ? (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => setSearch('')}
                      className="rounded-full"
                    >
                      <X />
                    </InputGroupButton>
                  </InputGroupAddon>
                ) : null}
              </InputGroup>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {isPending ? (
              <ProjectsLoadingState />
            ) : filteredProjects.length > 0 ? (
              <div
                className={`h-full overflow-y-auto pr-2 ${
                  filteredProjects.length > 5 ? 'max-h-[45rem]' : ''
                }`}
              >
                <div className="grid grid-cols-1 gap-4">
                  {filteredProjects.map((project, index) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      index={index}
                      onClick={() => {
                        setActiveProject(project)
                        startTransition(() => {
                          navigate({
                            to: '/projects/$projectId',
                            params: { projectId: project.id },
                          })
                        })
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : projects.length === 0 ? (
              <EmptyProjectsState onCreateClick={() => setShowCreate(true)} />
            ) : (
              <div className="flex h-full items-center justify-center rounded-[1.75rem] border border-dashed border-sage-strong bg-paper/80 px-8 py-14 text-center text-ink-soft">
                No projects match “{search}”.
              </div>
            )}
          </div>
        </section>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="rounded-[1.75rem] border-sage-strong bg-paper p-0 sm:max-w-xl">
          <form onSubmit={handleSubmit((data) => createProject.mutate(data))}>
            <DialogHeader className="gap-3 border-b border-sage-strong/70 px-6 py-6 sm:px-7">
              <DialogTitle className="font-display text-3xl text-forest">
                Create a project
              </DialogTitle>
              <DialogDescription className="text-sm leading-6 text-ink-soft">
                Every conversation with Socrates lives inside a project. Start with a clear name
                and a short description to give the workspace shape.
              </DialogDescription>
            </DialogHeader>

            <div className="px-6 py-6 sm:px-7">
              <FieldGroup>
                <Field data-invalid={errors.name ? true : undefined}>
                  <FieldLabel htmlFor="project-name">Project name</FieldLabel>
                  <InputGroup className="h-12 rounded-2xl border-sage-strong bg-white">
                    <InputGroupInput
                      id="project-name"
                      autoFocus
                      aria-invalid={errors.name ? true : undefined}
                      placeholder="DBMS"
                      className="text-base text-ink placeholder:text-ink-soft/45"
                      {...register('name', {
                        required: 'Project name is required.',
                        validate: (value) =>
                          value.trim().length > 0 || 'Project name is required.',
                      })}
                    />
                  </InputGroup>
                  <FieldError errors={[errors.name]} />
                </Field>

                <Field>
                  <FieldLabel htmlFor="project-description">Description</FieldLabel>
                  <Textarea
                    id="project-description"
                    rows={4}
                    placeholder="Study with me for my Database Management System course."
                    className="rounded-3xl border-sage-strong bg-white px-4 py-3 text-base text-ink placeholder:text-ink-soft/45"
                    {...register('description')}
                  />
                </Field>
              </FieldGroup>
            </div>

            <DialogFooter className="border-t border-sage-strong/70 px-6 py-5 sm:px-7">
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
                disabled={createProject.isPending}
              >
                {createProject.isPending ? (
                  <LoaderCircle className="animate-spin" data-icon="inline-start" />
                ) : (
                  <FolderPlus data-icon="inline-start" />
                )}
                Create project
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}

function ProjectsLoadingState() {
  return (
    <div className="grid h-full grid-cols-1 gap-4 overflow-hidden">
      {Array.from({ length: 4 }).map((_, index) => (
        <div
          key={index}
          className="flex min-h-[128px] flex-col gap-4 rounded-[1.75rem] border border-sage-strong/70 bg-paper/90 p-6"
        >
          <Skeleton className="h-6 w-40 rounded-full bg-sage-strong/70" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full rounded-full bg-sage/70" />
            <Skeleton className="h-4 w-3/4 rounded-full bg-sage/70" />
          </div>
          <Skeleton className="mt-6 h-4 w-28 rounded-full bg-sage/70" />
        </div>
      ))}
    </div>
  )
}

function EmptyProjectsState({ onCreateClick }: { onCreateClick: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: animation.spring }}
      className="flex h-full min-h-0 flex-col items-center justify-center gap-5 rounded-[2rem] border border-dashed border-sage-strong bg-paper/85 px-8 py-14 text-center shadow-[0_20px_60px_rgba(62,92,72,0.06)]"
    >
      <div className="flex size-16 items-center justify-center rounded-full bg-sage text-forest">
        <FolderPlus className="size-6" />
      </div>
      <div className="flex max-w-md flex-col gap-3">
        <h2 className="font-display text-4xl leading-tight text-forest">No projects yet</h2>
        <p className="text-base leading-7 text-ink-soft">
          Start your first workspace and keep every file, prompt, and conversation grounded in one
          calm place.
        </p>
      </div>
      <Button
        className="h-11 rounded-full bg-forest px-5 text-sm text-white hover:bg-forest/92"
        onClick={onCreateClick}
      >
        <FolderPlus data-icon="inline-start" />
        Create your first project
      </Button>
    </motion.div>
  )
}
