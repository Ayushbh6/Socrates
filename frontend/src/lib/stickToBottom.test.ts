import { describe, expect, it } from 'vitest'

import {
  STICK_TO_BOTTOM_THRESHOLD_PX,
  decideOnContentChange,
  distanceFromBottom,
  isNearBottom,
} from './stickToBottom'

describe('stickToBottom helpers', () => {
  it('measures distance from the true bottom including overflow slack', () => {
    expect(
      distanceFromBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }),
    ).toBe(0)
    expect(
      distanceFromBottom({ scrollTop: 800, scrollHeight: 1000, clientHeight: 100 }),
    ).toBe(100)
    expect(
      distanceFromBottom({ scrollTop: 1500, scrollHeight: 1000, clientHeight: 100 }),
    ).toBe(0)
  })

  it('treats inertial overshoot within the threshold as "at the bottom"', () => {
    expect(
      isNearBottom({ scrollTop: 900 - STICK_TO_BOTTOM_THRESHOLD_PX, scrollHeight: 1000, clientHeight: 100 }),
    ).toBe(true)
    expect(
      isNearBottom({ scrollTop: 900 - STICK_TO_BOTTOM_THRESHOLD_PX - 1, scrollHeight: 1000, clientHeight: 100 }),
    ).toBe(false)
  })

  it('auto-sticks when the user was already at the bottom', () => {
    const decision = decideOnContentChange({
      wasAtBottom: true,
      metrics: { scrollTop: 400, scrollHeight: 2000, clientHeight: 500 },
    })
    expect(decision).toEqual({
      shouldAutoScroll: true,
      shouldShowJumpToLatest: false,
      nextAtBottom: true,
    })
  })

  it('shows the Jump to latest pill when the user has scrolled away', () => {
    const decision = decideOnContentChange({
      wasAtBottom: false,
      metrics: { scrollTop: 100, scrollHeight: 2000, clientHeight: 500 },
    })
    expect(decision).toEqual({
      shouldAutoScroll: false,
      shouldShowJumpToLatest: true,
      nextAtBottom: false,
    })
  })

  it('does not show the pill if the user happens to be near the bottom even without prior stickiness', () => {
    const decision = decideOnContentChange({
      wasAtBottom: false,
      metrics: { scrollTop: 1450, scrollHeight: 2000, clientHeight: 500 },
    })
    expect(decision).toEqual({
      shouldAutoScroll: false,
      shouldShowJumpToLatest: false,
      nextAtBottom: true,
    })
  })

  it('accepts a custom threshold when the caller wants tighter/looser stickiness', () => {
    const metrics = { scrollTop: 1480, scrollHeight: 2000, clientHeight: 500 }
    expect(isNearBottom(metrics, 10)).toBe(false)
    expect(isNearBottom(metrics, 40)).toBe(true)
  })
})
