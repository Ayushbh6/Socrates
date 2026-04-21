import { queryOptions, type QueryClient } from '@tanstack/react-query'

import { ApiError, apiFetch } from '@/lib/api'
import type { BootstrapStatus, User } from '@/types/api'

export function bootstrapQueryOptions() {
  return queryOptions({
    queryKey: ['bootstrap'],
    queryFn: () => apiFetch<BootstrapStatus>('/bootstrap'),
    retry: false,
  })
}

export function meQueryOptions() {
  return queryOptions({
    queryKey: ['me'],
    queryFn: () => apiFetch<User>('/me'),
    retry: false,
  })
}

export function hasCompletedOnboarding(status: BootstrapStatus) {
  return status.has_user && status.onboarding_completed
}

export function getWelcomeDestination(status: BootstrapStatus) {
  return hasCompletedOnboarding(status) ? '/projects' : '/onboarding'
}

export async function ensureBootstrapStatus(queryClient: QueryClient) {
  return queryClient.ensureQueryData(bootstrapQueryOptions())
}

export async function ensureCurrentUser(queryClient: QueryClient) {
  return queryClient.ensureQueryData(meQueryOptions())
}

export function applyBootstrapCompletion(queryClient: QueryClient, user: User) {
  queryClient.setQueryData<BootstrapStatus>(bootstrapQueryOptions().queryKey, {
    has_user: true,
    onboarding_completed: true,
  })
  queryClient.setQueryData<User>(meQueryOptions().queryKey, user)
}

export async function submitBootstrap(displayName: string) {
  try {
    const user = await apiFetch<User>('/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        display_name: displayName.trim(),
        preferences: {},
      }),
    })

    return { user, alreadyOnboarded: false as const }
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const user = await apiFetch<User>('/me')
      return { user, alreadyOnboarded: true as const }
    }

    throw error
  }
}
