import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/utils'

/**
 * Primitive button component with CVA-driven variants.
 *
 * Variants:
 *   solid  — filled teal, high-emphasis actions (primary CTA)
 *   ghost  — teal border + transparent, medium-emphasis
 *   subtle — muted surface, low-emphasis
 *
 * Sizes:
 *   sm — compact inline actions
 *   md — default form / toolbar buttons
 *   lg — hero / page-level CTAs
 */

const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2.5',
    'font-semibold leading-none tracking-wide',
    'transition-all duration-200 ease-out',
    'focus-visible:outline-none',
    'focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-midnight',
    'active:scale-[0.97]',
    'disabled:pointer-events-none disabled:opacity-40',
    'select-none',
  ].join(' '),
  {
    variants: {
      variant: {
        solid: [
          'bg-teal text-midnight',
          'shadow-[0_4px_20px_rgba(12,197,197,0.30)]',
          'hover:bg-teal-bright',
          'hover:shadow-[0_6px_32px_rgba(12,197,197,0.50)]',
        ].join(' '),

        ghost: [
          'border border-teal/30 bg-transparent text-ivory',
          'hover:border-teal/60 hover:bg-teal/10',
        ].join(' '),

        subtle: [
          'bg-midnight-raised text-ivory-muted',
          'hover:bg-midnight-border hover:text-ivory',
        ].join(' '),
      },

      size: {
        sm: 'h-9 rounded-xl px-4 text-sm',
        md: 'h-11 rounded-xl px-5 text-[15px]',
        lg: 'h-14 rounded-2xl px-20 min-w-[280px] text-base',
      },
    },
    defaultVariants: {
      variant: 'solid',
      size:    'md',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /** Shows a spinner and blocks interaction while true */
  isLoading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, isLoading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || isLoading}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    >
      {isLoading ? (
        <span
          aria-label="Loading"
          className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        children
      )}
    </button>
  ),
)

Button.displayName = 'Button'
