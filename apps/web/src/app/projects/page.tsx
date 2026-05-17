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
import { useEffect, useState } from "react";

export default function ProjectsPage() {
  const { user } = useCurrentUser();
  const [projects, setProjects] = useState<ListProjectsResponse["projects"]>([]);
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

  return (
    <main className="min-h-screen bg-brand-bg py-12 px-6 flex justify-center">
      <div className="w-full max-w-4xl">
        <PageHeader
          title={title}
          action={
            <Button asChild className="rounded-full px-5 h-10 text-sm bg-white text-brand-text-dark border border-gray-200 hover:bg-gray-50 hover:text-brand-text-dark shadow-sm">
              <Link href="/projects/new">
                New project
              </Link>
            </Button>
          } 
        />
        
        <ProjectSearch />
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {isLoading && (
            <div className="col-span-full text-sm text-brand-text-light">Loading projects...</div>
          )}
          {error && (
            <div className="col-span-full text-sm text-red-600">{error}</div>
          )}
          {!isLoading && !error && projects.length === 0 && (
            <div className="col-span-full rounded-xl border border-dashed border-gray-300 bg-white/60 p-8 text-center">
              <p className="text-brand-text-dark font-medium">No projects yet</p>
              <p className="text-sm text-brand-text-light mt-2">Create your first project to start working with Socrates.</p>
            </div>
          )}
          {projects.map(({ project }) => (
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
    </main>
  );
}
