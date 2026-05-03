import { type ReactNode } from 'react'
import { cn } from '../../lib/utils'
import { colors } from '../../config/design'

/**
 * Shared full-screen page wrapper used by every marketing / auth page.
 * Provides: midnight background, centered radial teal glow,
 * dot-grid texture, and a bottom edge vignette.
 *
 * Children are rendered in a relative z-10 layer on top of all decorations.
 */

interface PageShellProps {
  children: ReactNode
  className?: string
}

export function PageShell({ children, className }: PageShellProps) {
  return (
    <div
      className={cn(
        'relative flex min-h-dvh w-full flex-col items-center overflow-x-hidden overflow-y-auto bg-canvas text-ink',
        className,
      )}
    >
      {/* ── Radial sage glow ─────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 70% 55% at 50% 48%,
            rgba(143,196,170,0.18) 0%,
            transparent 68%)`,
        }}
      />

      {/* ── Paper wash ───────────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'linear-gradient(180deg, rgba(255,253,247,0.92) 0%, rgba(244,241,232,0.86) 100%)',
        }}
      />

      {/* ── Dot grid texture ─────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage: `radial-gradient(circle, ${colors.greenTea} 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
        }}
      />

      {/* ── Top highlight ───────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-48"
        style={{
          background:
            'linear-gradient(to bottom, rgba(255,255,255,0.72) 0%, rgba(255,255,255,0) 100%)',
        }}
      />

      {/* ── Page content ─────────────────────────────────────── */}
      <div className="relative z-10 flex min-h-dvh w-full flex-col items-center">
        {children}
      </div>
    </div>
  )
}
