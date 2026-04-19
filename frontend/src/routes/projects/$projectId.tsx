import { useEffect } from 'react'
import { createFileRoute, Outlet } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { apiFetch } from '@/lib/api'
import { useAppStore } from '@/stores/appStore'
import type { Project } from '@/types/api'

export const Route = createFileRoute('/projects/$projectId')({
  component: ProjectWorkspace,
})

function ProjectWorkspace() {
  const { projectId } = Route.useParams()
  const setActiveProject = useAppStore((state) => state.setActiveProject)

  const { data: project } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => apiFetch<Project>(`/projects/${projectId}`),
  })

  useEffect(() => {
    if (project) {
      setActiveProject(project)
    }
  }, [project, setActiveProject])

  return <Outlet />
}
