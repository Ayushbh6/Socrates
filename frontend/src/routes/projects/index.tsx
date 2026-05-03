import { startTransition, useDeferredValue, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { motion } from 'framer-motion'
import { FolderPlus, Search, X } from 'lucide-react'

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
import { Input } from '@/components/ui/input'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupText,
} from '@/components/ui/input-group'
import { Skeleton } from '@/components/ui/skeleton'
import { animation } from '@/config/design'
import { apiFetch } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'
import type { Project } from '@/types/api'

export const Route = createFileRoute('/projects/')({
  component: ProjectsHome,
})

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
  const [renameTarget, setRenameTarget] = useState<Project | null>(null)
  const [renameName, setRenameName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)

  const { data: projects = [], isPending } = useQuery({
    queryKey: ['projects'],
    queryFn: () => apiFetch<Project[]>('/projects'),
  })

  const renameProject = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      apiFetch<Project>(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
    onSuccess: (updated) => {
      // Eagerly update the cache so the renamed project appears instantly
      // when the dialog closes — no waiting on the background refetch.
      queryClient.setQueryData<Project[]>(['projects'], (current) =>
        (current ?? []).map((project) => (project.id === updated.id ? updated : project)),
      )
      queryClient.setQueryData<Project>(['project', updated.id], updated)
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      queryClient.invalidateQueries({ queryKey: ['project', updated.id] })
      const { activeProject } = useAppStore.getState()
      if (activeProject?.id === updated.id) {
        useAppStore.setState({ activeProject: updated })
      }
      setRenameTarget(null)
    },
  })

  const deleteProject = useMutation({
    mutationFn: (id: string) =>
      apiFetch<Project>(`/projects/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: (_, id) => {
      // Eagerly drop the deleted project from the visible list so it
      // disappears the moment the user confirms — refetch is the safety net.
      queryClient.setQueryData<Project[]>(['projects'], (current) =>
        (current ?? []).filter((project) => project.id !== id),
      )
      queryClient.removeQueries({ queryKey: ['project', id] })
      queryClient.removeQueries({ queryKey: ['conversations', id] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      const { activeProject } = useAppStore.getState()
      if (activeProject?.id === id) {
        useAppStore.setState({ activeProject: null, activeConversation: null })
        startTransition(() => navigate({ to: '/projects' }))
      }
      setDeleteTarget(null)
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
      <Dialog
        open={Boolean(renameTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setRenameTarget(null)
            renameProject.reset()
          }
        }}
      >
        <DialogContent className="border-sage-strong/60 bg-paper/98 sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle className="font-display text-forest">Rename project</DialogTitle>
            <DialogDescription>Update how this workspace appears in your list.</DialogDescription>
          </DialogHeader>
          <Input
            value={renameName}
            onChange={(event) => setRenameName(event.target.value)}
            className="h-10 rounded-xl border-sage-strong bg-white/90"
            placeholder="Project name"
            autoFocus
          />
          {renameProject.error ? (
            <p className="text-sm text-red-600">
              {renameProject.error instanceof Error ? renameProject.error.message : 'Failed to rename project.'}
            </p>
          ) : null}
          <DialogFooter className="border-t-0 bg-transparent p-0 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-sage-strong"
              onClick={() => {
                setRenameTarget(null)
                renameProject.reset()
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="rounded-full bg-forest text-white hover:bg-forest/92"
              disabled={
                renameProject.isPending || !renameName.trim() || !renameTarget
              }
              onClick={() => {
                if (!renameTarget || !renameName.trim()) {
                  return
                }
                renameProject.mutate({ id: renameTarget.id, name: renameName.trim() })
              }}
            >
              {renameProject.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(deleteTarget)}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            deleteProject.reset()
          }
        }}
      >
        <DialogContent className="border-sage-strong/60 bg-paper/98 sm:max-w-md" showCloseButton>
          <DialogHeader>
            <DialogTitle className="font-display text-forest">Delete project?</DialogTitle>
            <DialogDescription>
              This archives the project and hides it from your workspace. Data stays in your local
              database for traceability.
            </DialogDescription>
          </DialogHeader>
          {deleteProject.error ? (
            <p className="text-sm text-red-600">
              {deleteProject.error instanceof Error ? deleteProject.error.message : 'Failed to delete project.'}
            </p>
          ) : null}
          <DialogFooter className="border-t-0 bg-transparent p-0 sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="rounded-full border-sage-strong"
              onClick={() => {
                setDeleteTarget(null)
                deleteProject.reset()
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="rounded-full"
              disabled={deleteProject.isPending || !deleteTarget}
              onClick={() => {
                if (!deleteTarget) {
                  return
                }
                deleteProject.mutate(deleteTarget.id)
              }}
            >
              {deleteProject.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex w-full min-w-0 flex-col gap-4 pb-4 sm:gap-5">
        <motion.section
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: animation.durationBase, ease: animation.spring }}
          className="min-w-0 shrink-0 rounded-[1.5rem] border border-sage-strong/70 bg-paper/95 px-5 py-5 shadow-[0_20px_52px_rgba(62,92,72,0.07)] sm:px-7 sm:py-6 lg:rounded-[1.8rem]"
        >
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="flex max-w-2xl flex-col gap-3">
              <p className="text-xs font-semibold uppercase tracking-[0.28em] text-moss">
                {getGreeting()}
              </p>
              <div className="flex flex-col gap-2">
                <h1 className="py-1 font-display text-[clamp(2rem,4.2vw,4rem)] leading-[1.08] tracking-tight text-forest">
                  {displayName}&rsquo;s workspace
                </h1>
                <p className="max-w-2xl text-[15px] leading-6 text-ink-soft sm:leading-7">
                  Your projects are the center of Socrates. Gather a domain of thought, keep
                  every conversation inside it, and return later with the full context intact.
                </p>
              </div>
            </div>

            <div className="flex justify-start lg:justify-end">
              <Button
                className="h-11 rounded-full bg-forest px-5 text-sm text-white shadow-[0_16px_40px_rgba(27,53,41,0.18)] hover:bg-forest/92"
                onClick={() => startTransition(() => navigate({ to: '/projects/create' }))}
              >
                <FolderPlus data-icon="inline-start" />
                New Project
              </Button>
            </div>
          </div>
        </motion.section>

        <section className="flex flex-col gap-4">
          <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
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

          <div>
            {isPending ? (
              <ProjectsLoadingState />
            ) : filteredProjects.length > 0 ? (
              <div className="min-w-0">
                <div className="grid grid-cols-1 gap-4">
                  {filteredProjects.map((project, index) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      index={index}
                      onOpen={() => {
                        setActiveProject(project)
                        startTransition(() => {
                          navigate({
                            to: '/projects/$projectId/dashboard',
                            params: { projectId: project.id },
                          })
                        })
                      }}
                      onRename={(p) => {
                        setRenameTarget(p)
                        setRenameName(p.name)
                      }}
                      onDelete={(p) => setDeleteTarget(p)}
                    />
                  ))}
                </div>
              </div>
            ) : projects.length === 0 ? (
              <EmptyProjectsState onCreateClick={() => startTransition(() => navigate({ to: '/projects/create' }))} />
            ) : (
              <div className="flex h-full items-center justify-center rounded-[1.75rem] border border-dashed border-sage-strong bg-paper/80 px-8 py-14 text-center text-ink-soft">
                No projects match “{search}”.
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  )
}

function ProjectsLoadingState() {
  return (
    <div className="grid grid-cols-1 gap-4">
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
      className="flex min-h-[20rem] flex-col items-center justify-center gap-5 rounded-[2rem] border border-dashed border-sage-strong bg-paper/85 px-8 py-14 text-center shadow-[0_20px_60px_rgba(62,92,72,0.06)]"
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
