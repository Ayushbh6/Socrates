import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/projects/$projectId/conversations/$conversationId')({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: '/projects/$projectId/dashboard/conversations/$conversationId',
      params: {
        projectId: params.projectId,
        conversationId: params.conversationId,
      },
      replace: true,
    })
  },
  component: () => null,
})
