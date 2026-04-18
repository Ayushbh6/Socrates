import { createFileRoute } from '@tanstack/react-router'
import { Compass, MessageSquarePlus } from 'lucide-react'

import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/projects/$projectId/')({
  component: ProjectOverviewPage,
})

function ProjectOverviewPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-12">
      <div className="flex max-w-lg flex-col items-center gap-6 text-center">
        <div className="flex size-18 items-center justify-center rounded-full bg-sage text-forest">
          <Compass className="size-7" />
        </div>
        <div className="flex flex-col gap-3">
          <h2 className="font-display text-5xl leading-none tracking-tight text-forest">
            Project ready
          </h2>
          <p className="text-base leading-7 text-ink-soft">
            Open an existing conversation from the left rail or create a new one to begin working
            with Socrates inside this project.
          </p>
        </div>
        <Button
          variant="outline"
          disabled
          className="h-11 rounded-full border-sage-strong bg-white px-5 text-ink shadow-none hover:bg-sage"
        >
          <MessageSquarePlus data-icon="inline-start" />
          Create from the sidebar
        </Button>
      </div>
    </div>
  )
}
