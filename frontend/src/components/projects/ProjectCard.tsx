import { motion } from 'framer-motion'
import { ArrowRight, MoreVertical } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { animation } from '@/config/design'
import type { Project } from '@/types/api'

interface ProjectCardProps {
  project: Project
  /** Stagger index for entrance animation */
  index: number
  onOpen: () => void
  onRename: (project: Project) => void
  onDelete: (project: Project) => void
}

export function ProjectCard({ project, index, onOpen, onRename, onDelete }: ProjectCardProps) {
  const updatedAt = new Date(project.updated_at).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <motion.article
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: animation.durationBase, delay: index * 0.06, ease: animation.spring }}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        'group relative w-full cursor-pointer text-left outline-none',
        'rounded-[1.6rem] border border-sage-strong/70 bg-paper/95 px-6 py-5 shadow-[0_16px_36px_rgba(62,92,72,0.06)] transition-all duration-200 ease-out',
        'hover:-translate-y-0.5 hover:border-moss/40 hover:shadow-[0_22px_50px_rgba(62,92,72,0.11)]',
        'focus-visible:ring-3 focus-visible:ring-ring/40',
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 flex-col gap-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.24em] text-moss">
            Project
          </div>
          <p className="pr-2 font-display text-[1.8rem] leading-none tracking-tight text-forest">
            {project.name}
          </p>
        </div>

        <div className="flex shrink-0 items-start gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="size-9 rounded-full text-moss/80 hover:bg-sage/60 hover:text-forest"
                aria-label={`Project actions for ${project.name}`}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[11rem] border-sage-strong/50 bg-paper/98">
              <DropdownMenuItem
                className="cursor-pointer"
                onClick={(event) => {
                  event.stopPropagation()
                  onRename(project)
                }}
              >
                Rename project
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-sage-strong/40" />
              <DropdownMenuItem
                variant="destructive"
                className="cursor-pointer"
                onClick={(event) => {
                  event.stopPropagation()
                  onDelete(project)
                }}
              >
                Delete project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <ArrowRight className="mt-2 text-moss/70 transition-all duration-200 group-hover:translate-x-1 group-hover:text-forest" />
        </div>
      </div>

      {project.description && (
        <p className="mt-4 line-clamp-2 text-sm leading-7 text-ink-soft">{project.description}</p>
      )}

      <div className="mt-5 flex items-center justify-between border-t border-sage-strong/60 pt-3">
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-ink-soft/70">
          Updated
        </span>
        <span className="text-sm text-ink-soft">{updatedAt}</span>
      </div>
    </motion.article>
  )
}
