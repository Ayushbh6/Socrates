"use client";

import { ProjectCard } from "@/components/project/ProjectCard";
import { ProjectSearch } from "@/components/project/ProjectSearch";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { formatUpdatedAt } from "@/lib/dates";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import type { ListProjectsResponse } from "@socrates/contracts";
import Link from "next/link";
import { Brain, Settings } from "lucide-react";
import { useEffect, useState } from "react";

export default function ProjectsPage() {
  const { user } = useCurrentUser();
  const [projects, setProjects] = useState<ListProjectsResponse["projects"]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadProjects() {
      setIsLoading(true);
      setError(null);

      try {
        const data = await api.listProjects();
        if (isMounted) {
          setProjects(data.projects);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : "Could not load projects.");
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    void loadProjects();

    return () => {
      isMounted = false;
    };
  }, []);

  const title = user ? `Welcome, ${user.displayName} 😊` : "Projects";
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleProjects = normalizedSearchQuery
    ? projects.filter(({ project }) =>
        [project.name, project.description ?? ""].some((value) =>
          value.toLocaleLowerCase().includes(normalizedSearchQuery),
        ),
      )
    : projects;

  return (
    <main className="flex h-screen min-h-0 overflow-hidden bg-brand-bg text-brand-text-dark">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex-none bg-brand-bg px-4 py-5 sm:px-6 sm:py-6">
          <div className="mx-auto w-full max-w-4xl">
            <PageHeader
              title={title}
              action={
                <div className="flex items-center gap-2">
                  <Button asChild variant="outline" size="icon" className="rounded-full bg-white">
                    <Link href="/memory" aria-label="Memory Center">
                      <Brain className="size-4" />
                    </Link>
                  </Button>
                  <Button asChild variant="outline" size="icon" className="rounded-full bg-white">
                    <Link href="/settings" aria-label="Settings">
                      <Settings className="size-4" />
                    </Link>
                  </Button>
                  <Button asChild className="h-10 rounded-full border border-gray-200 bg-white px-5 text-sm text-brand-text-dark shadow-sm hover:bg-gray-50 hover:text-brand-text-dark">
                    <Link href="/projects/new">New project</Link>
                  </Button>
                </div>
              }
            />
          </div>
        </header>

        <section
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6 sm:py-6"
          data-projects-scroll-region
        >
          <div className="mx-auto w-full max-w-4xl pb-4">
            <ProjectSearch value={searchQuery} onChange={setSearchQuery} />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {isLoading && (
                <div className="col-span-full text-sm text-brand-text-light">Loading projects...</div>
              )}
              {error && (
                <div className="col-span-full text-sm text-red-600">{error}</div>
              )}
              {!isLoading && !error && projects.length === 0 && (
                <div className="col-span-full rounded-xl border border-dashed border-gray-300 bg-white/60 p-8 text-center">
                  <p className="font-medium text-brand-text-dark">No projects yet</p>
                  <p className="mt-2 text-sm text-brand-text-light">Create your first project to start working with Socrates.</p>
                </div>
              )}
              {!isLoading && !error && projects.length > 0 && visibleProjects.length === 0 && (
                <div className="col-span-full rounded-xl border border-dashed border-gray-300 bg-white/60 p-8 text-center">
                  <p className="font-medium text-brand-text-dark">No matching projects</p>
                  <p className="mt-2 text-sm text-brand-text-light">Try a different name or description.</p>
                </div>
              )}
              {visibleProjects.map(({ project }) => (
                <ProjectCard
                  key={project.id}
                  id={project.id}
                  name={project.name}
                  description={project.description ?? ""}
                  updatedAt={formatUpdatedAt(project.updatedAt)}
                />
              ))}
            </div>
          </div>
        </section>

        <footer className="flex-none bg-brand-bg px-4 py-3 sm:px-6">
          <div className="mx-auto flex w-full max-w-4xl items-center justify-end text-xs text-brand-text-light">
            <span className="truncate text-right">Projects</span>
          </div>
        </footer>
      </div>
    </main>
  );
}
