import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import {
  STICK_TO_BOTTOM_THRESHOLD_PX,
  decideOnContentChange,
  isNearBottom,
} from '@/lib/stickToBottom'

export interface UseStickToBottomOptions {
  /** Pixel slack for what counts as "at the bottom". */
  threshold?: number
}

export interface StickToBottomController {
  /**
   * Attach to the scrollable container. Typed as `RefObject<HTMLDivElement | null>`
   * because React 19 initializes ref objects with `null` before the element mounts.
   */
  containerRef: React.RefObject<HTMLDivElement | null>
  /** The user is currently near the bottom (auto-stick engaged). */
  isAtBottom: boolean
  /**
   * New content has arrived while the user was scrolled away. Use this to
   * render the "Jump to latest" affordance.
   */
  hasNewContent: boolean
  /** Imperatively jump to the bottom (e.g. when the user clicks the pill). */
  scrollToBottom: (behavior?: ScrollBehavior) => void
  /**
   * Tell the hook the content just grew. Call this whenever the list of
   * rendered items changes. The hook will either auto-stick or raise the
   * new-content indicator, depending on whether the user was already at the
   * bottom.
   */
  notifyContentChanged: () => void
}

/**
 * Conversation-UX primitive: keeps the viewport pinned to the latest message
 * when the user is reading at the bottom, but yields control the moment they
 * scroll away. Pairs with a "Jump to latest" pill so scrolled-up readers can
 * opt back in without losing their place.
 *
 * The math is delegated to `lib/stickToBottom`, which keeps this hook's
 * responsibilities narrow: observe scroll/resize, translate the current
 * geometry into the pure decision helpers, and apply the resulting state.
 */
export function useStickToBottom(options: UseStickToBottomOptions = {}): StickToBottomController {
  const threshold = options.threshold ?? STICK_TO_BOTTOM_THRESHOLD_PX
  const containerRef = useRef<HTMLDivElement | null>(null)
  const frameRef = useRef<number | null>(null)
  const atBottomRef = useRef(true)
  const [isAtBottom, setIsAtBottom] = useState(true)
  const [hasNewContent, setHasNewContent] = useState(false)

  const readMetrics = useCallback(() => {
    const el = containerRef.current
    if (!el) return null
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }
  }, [])

  const syncAtBottomFromScroll = useCallback(() => {
    const metrics = readMetrics()
    if (!metrics) return
    const atBottom = isNearBottom(metrics, threshold)
    atBottomRef.current = atBottom
    setIsAtBottom((prev) => (prev === atBottom ? prev : atBottom))
    if (atBottom && hasNewContent) {
      setHasNewContent(false)
    }
  }, [hasNewContent, readMetrics, threshold])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = containerRef.current
    if (!el) return
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    el.scrollTo({ top: el.scrollHeight, behavior })
    atBottomRef.current = true
    setIsAtBottom(true)
    setHasNewContent(false)
  }, [])

  const notifyContentChanged = useCallback(() => {
    const metrics = readMetrics()
    if (!metrics) return
    const decision = decideOnContentChange({
      wasAtBottom: atBottomRef.current,
      metrics,
      threshold,
    })
    if (decision.shouldAutoScroll) {
      if (frameRef.current === null) {
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null
          const el = containerRef.current
          if (el) {
            el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
          }
        })
      }
      atBottomRef.current = true
      setIsAtBottom(true)
      setHasNewContent(false)
      return
    }
    atBottomRef.current = decision.nextAtBottom
    setIsAtBottom(decision.nextAtBottom)
    if (decision.shouldShowJumpToLatest) {
      setHasNewContent(true)
    }
  }, [readMetrics, threshold])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => syncAtBottomFromScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
    }
  }, [syncAtBottomFromScroll])

  useEffect(() => () => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
    }
  }, [])

  // Initial sync once layout is known so `isAtBottom` / `hasNewContent` start
  // consistent with the actual geometry (e.g. conversations that hydrate from
  // a cached scroll position should not pop into "new content" on mount).
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncAtBottomFromScroll()
    })
    return () => window.cancelAnimationFrame(frame)
    // Run once on mount; `syncAtBottomFromScroll` is stable enough for this
    // purpose (it would re-run on `hasNewContent` toggles, which is fine --
    // they re-read the current scroll position without side effects).
  }, [syncAtBottomFromScroll])

  return { containerRef, isAtBottom, hasNewContent, scrollToBottom, notifyContentChanged }
}
