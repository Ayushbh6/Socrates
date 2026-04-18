import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '../lib/api'
import type { BootstrapStatus } from '../types/api'
import { useEffect } from 'react'

export const Route = createFileRoute('/')({
  component: IndexPage,
})

function IndexPage() {
  const navigate = useNavigate()

  const { data, isLoading } = useQuery({
    queryKey: ['bootstrap'],
    queryFn: () => apiFetch<BootstrapStatus>('/bootstrap'),
    retry: false,
  })

  useEffect(() => {
    if (!data) return
    if (!data.has_user) {
      navigate({ to: '/welcome' })
    } else {
      navigate({ to: '/projects' })
    }
  }, [data, navigate])

  // API down or loading → go to welcome anyway so user sees the UI
  useEffect(() => {
    if (!isLoading && !data) {
      navigate({ to: '/welcome' })
    }
  }, [isLoading, data, navigate])

  return (
    <div className="flex h-full items-center justify-center bg-midnight">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-midnight-border border-t-teal" />
    </div>
  )
}

