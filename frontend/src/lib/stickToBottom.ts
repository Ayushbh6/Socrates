/**
 * Pure helpers behind the stick-to-bottom + "Jump to latest" behavior.
 *
 * The hook that wires these into React (`useStickToBottom`) only reads the
 * scroll element's geometry -- it never does math inline. That way the
 * non-trivial decisions (is the user near the bottom? should we auto-stick?)
 * can be exercised under unit tests without a DOM.
 */

export interface ScrollMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

/**
 * Default slack between the user's current scroll position and the true
 * bottom of the container before we consider them "scrolled away". 64px is
 * roughly one line of chat content plus comfortable breathing room for the
 * mild elastic bounce that macOS / iOS apply during inertial scrolling.
 */
export const STICK_TO_BOTTOM_THRESHOLD_PX = 64

export function distanceFromBottom(metrics: ScrollMetrics): number {
  const { scrollTop, scrollHeight, clientHeight } = metrics
  return Math.max(0, scrollHeight - clientHeight - scrollTop)
}

export function isNearBottom(
  metrics: ScrollMetrics,
  threshold: number = STICK_TO_BOTTOM_THRESHOLD_PX,
): boolean {
  return distanceFromBottom(metrics) <= Math.max(0, threshold)
}

export interface StickDecisionInput {
  /** Whether the last observed position was "near the bottom". */
  wasAtBottom: boolean
  /** Current geometry after content grew / user scrolled. */
  metrics: ScrollMetrics
  threshold?: number
}

export interface StickDecisionOutput {
  /** Whether the hook should auto-scroll to the bottom right now. */
  shouldAutoScroll: boolean
  /** Whether the pill prompting the user to jump to the latest content should show. */
  shouldShowJumpToLatest: boolean
  /** Updated `atBottom` flag to store. */
  nextAtBottom: boolean
}

/**
 * Decide the next UI state when the conversation receives new content.
 *
 * - If the user was at the bottom, keep them there (auto-scroll).
 * - If the user had scrolled away, don't yank them back; instead surface the
 *   "Jump to latest" affordance so they can opt in.
 * - After auto-scrolling, we trust the subsequent scroll event to confirm
 *   that `nextAtBottom` is still true.
 */
export function decideOnContentChange(input: StickDecisionInput): StickDecisionOutput {
  const nowAtBottom = isNearBottom(input.metrics, input.threshold)
  if (input.wasAtBottom) {
    return {
      shouldAutoScroll: true,
      shouldShowJumpToLatest: false,
      nextAtBottom: true,
    }
  }
  return {
    shouldAutoScroll: false,
    shouldShowJumpToLatest: !nowAtBottom,
    nextAtBottom: nowAtBottom,
  }
}
