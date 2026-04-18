import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { animation } from '@/config/design'
import type { Project } from '@/types/api'

interface ProjectCardProps {
  project: Project
  /** Stagger index for entrance animation */
  index: number
  onClick: () => void
}

export function ProjectCard({ project, index, onClick }: ProjectCardProps) {
  const updatedAt = new Date(project.updated_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <motion.button
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: animation.durationBase, delay: index * 0.06, ease: animation.spring }}
      onClick={onClick}
      className={cn(
        'group relative w-full text-left',
        'rounded-[1.6rem] border border-sage-strong/70 bg-paper/95 px-6 py-5 shadow-[0_16px_36px_rgba(62,92,72,0.06)] transition-all duration-200 ease-out',
        'hover:-translate-y-0.5 hover:border-moss/40 hover:shadow-[0_22px_50px_rgba(62,92,72,0.11)]',
        'focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-moss">
            Project
          </div>
          <p className="pr-6 font-display text-[1.8rem] leading-none tracking-tight text-forest">
            {project.name}
          </p>
        </div>
        <ArrowRight className="mt-1 text-moss/70 transition-all duration-200 group-hover:translate-x-1 group-hover:text-forest" />
      </div>

      {project.description && (
        <p className="mt-4 line-clamp-2 text-sm leading-7 text-ink-soft">
          {project.description}
        </p>
      )}

      <div className="mt-5 flex items-center justify-between border-t border-sage-strong/60 pt-3">
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-ink-soft/70">
          Updated
        </span>
        <span className="text-sm text-ink-soft">{updatedAt}</span>
      </div>
    </motion.button>
  )
}
