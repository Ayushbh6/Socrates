import { forwardRef, useId } from 'react'
import { cn } from '../../lib/utils'

/**
 * Primitive text input with optional label, hint, and error slots.
 * Implements forwardRef so react-hook-form's register() ref works correctly.
 */

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Optional label rendered above the field */
  label?: string
  /** Helper text rendered below the field when there is no error */
  hint?: string
  /** Error message — replaces hint and applies error styling */
  error?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, label, hint, error, id, ...props }, ref) => {
    const generatedId = useId()
    const inputId = id ?? generatedId

    return (
      <div className="flex w-full flex-col gap-2">
        {label && (
          <label
            htmlFor={inputId}
            className="text-sm font-medium text-ivory-muted"
          >
            {label}
          </label>
        )}

        <input
          id={inputId}
          ref={ref}
          className={cn(
            // Layout & shape — rounded-lg matches shadcn/ui standard (not oval, not sharp)
            'h-12 w-full rounded-lg px-4 py-0',
            // Surface
            'border bg-midnight-card',
            // Typography
            'text-[15px] font-light text-ivory',
            'placeholder:text-ivory-muted/40',
            // Remove browser defaults
            'outline-none appearance-none',
            // Transitions
            'transition-all duration-200',
            // Focus ring — soft teal glow replacing the default outline
            'focus:shadow-[0_0_0_3px_rgba(12,197,197,0.12)]',
            // Border state
            error
              ? 'border-red-500/50 focus:border-red-400/60 focus:shadow-[0_0_0_3px_rgba(239,68,68,0.12)]'
              : 'border-midnight-border focus:border-teal/50',
            className,
          )}
          {...props}
        />

        {hint && !error && (
          <p className="text-xs leading-relaxed text-ivory-muted/60">{hint}</p>
        )}
        {error && (
          <p className="text-xs leading-relaxed text-red-400">{error}</p>
        )}
      </div>
    )
  },
)

Input.displayName = 'Input'
