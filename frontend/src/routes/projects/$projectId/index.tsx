import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/projects/$projectId/')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/projects/$projectId/dashboard',
      params: { projectId: params.projectId },
      replace: true,
    })
  },
  component: () => null,
})
