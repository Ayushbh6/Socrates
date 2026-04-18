import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/projects/')({
  component: ProjectsIndex,
})

function ProjectsIndex() {
  return (
    <div className="flex flex-1 items-center justify-center bg-[var(--color-base)]">
      <div className="text-center">
        <p className="font-serif text-3xl font-semibold text-[var(--color-accent)] mb-2">
          Socrates
        </p>
        <p className="text-sm text-[var(--color-muted)]">
          Select a project to begin, or create a new one.
        </p>
      </div>
    </div>
  )
}
