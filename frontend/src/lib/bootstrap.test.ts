import { QueryClient } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  applyBootstrapCompletion,
  getWelcomeDestination,
  hasCompletedOnboarding,
  bootstrapQueryOptions,
  meQueryOptions,
  submitBootstrap,
} from '@/lib/bootstrap'

const sampleUser = {
  id: 'user-1',
  display_name: 'Ayush',
  preferences: {},
  created_at: '2026-04-18T12:34:56.000000+00:00',
  updated_at: '2026-04-18T12:34:56.000000+00:00',
  onboarding_completed_at: '2026-04-18T12:34:56.000000+00:00',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('bootstrap flow helpers', () => {
  it('sends first-time users from welcome to onboarding', () => {
    expect(
      getWelcomeDestination({
        has_user: false,
        onboarding_completed: false,
      }),
    ).toBe('/onboarding')
  })

  it('sends returning users from welcome to projects', () => {
    expect(
      getWelcomeDestination({
        has_user: true,
        onboarding_completed: true,
      }),
    ).toBe('/projects')
  })

  it('only treats bootstrap as complete when both contract flags are true', () => {
    expect(
      hasCompletedOnboarding({
        has_user: true,
        onboarding_completed: false,
      }),
    ).toBe(false)
  })

  it('returns the created user after a successful bootstrap request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(sampleUser), {
          status: 201,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    await expect(submitBootstrap('Ayush')).resolves.toEqual({
      user: sampleUser,
      alreadyOnboarded: false,
    })
  })

  it('treats POST /bootstrap 409 as already onboarded and recovers via GET /me', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ detail: 'Bootstrap has already been completed.' }),
            {
              status: 409,
              headers: { 'Content-Type': 'application/json' },
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(sampleUser), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
    )

    await expect(submitBootstrap('Ayush')).resolves.toEqual({
      user: sampleUser,
      alreadyOnboarded: true,
    })
  })

  it('updates bootstrap and me caches after onboarding completes', () => {
    const queryClient = new QueryClient()

    applyBootstrapCompletion(queryClient, sampleUser)

    expect(queryClient.getQueryData(bootstrapQueryOptions().queryKey)).toEqual({
      has_user: true,
      onboarding_completed: true,
    })
    expect(queryClient.getQueryData(meQueryOptions().queryKey)).toEqual(sampleUser)
  })
})
