/**
 * Design tokens — single source of truth for the Socrates design system.
 * Mirrors the CSS @theme block in index.css. Import these in components
 * instead of hardcoding hex values or class strings.
 */

export const colors = {
  midnight:       '#08101E',
  midnightCard:   '#0D1929',
  midnightRaised: '#112236',
  midnightBorder: '#1C3050',
  teal:           '#0CC5C5',
  tealDim:        '#0A9E9E',
  tealBright:     '#2DEDED',
  greenTea:       '#8FC4AA',
  greenTeaDim:    '#6BA88C',
  ivory:          '#EDF2EE',
  ivoryMuted:     '#9BBCB0',
} as const

export const fonts = {
  display: "'Fraunces', Georgia, serif",
  body:    "'Inter', system-ui, -apple-system, sans-serif",
} as const

/**
 * Reusable easing curves for Framer Motion transitions.
 * `spring` is a cubic-bezier that produces a fast, confident feel.
 */
export const animation = {
  spring:       [0.16, 1, 0.3, 1] as [number, number, number, number],
  durationFast: 0.35,
  durationBase: 0.55,
  durationSlow: 0.75,
} as const
