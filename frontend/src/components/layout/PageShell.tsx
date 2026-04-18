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
        'relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-midnight',
        className,
      )}
    >
      {/* ── Radial teal glow ─────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 70% 55% at 50% 48%,
            rgba(12,197,197,0.065) 0%,
            transparent 68%)`,
        }}
      />

      {/* ── Dot grid texture ─────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.038]"
        style={{
          backgroundImage: `radial-gradient(circle, ${colors.greenTea} 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
        }}
      />

      {/* ── Bottom vignette ──────────────────────────────────── */}
      <div
        aria-hidden
        className="pointer-events-none absolute bottom-0 left-0 right-0 h-48"
        style={{
          background: `linear-gradient(to top, ${colors.midnight} 0%, transparent 100%)`,
        }}
      />

      {/* ── Page content ─────────────────────────────────────── */}
      <div className="relative z-10 flex w-full flex-col items-center">
        {children}
      </div>
    </div>
  )
}
