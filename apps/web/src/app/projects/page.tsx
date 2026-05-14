import { ProjectCard } from "@/components/project/ProjectCard";
import { ProjectSearch } from "@/components/project/ProjectSearch";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import Link from "next/link";

export default function ProjectsPage() {
  return (
    <main className="min-h-screen bg-brand-bg py-12 px-6 flex justify-center">
      <div className="w-full max-w-4xl">
        <PageHeader 
          title="Projects" 
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
          <ProjectCard 
            id="test-1"
            name="test"
            description=""
            updatedAt="4 weeks ago"
          />
          <ProjectCard 
            id="test-2"
            name="DBMS"
            description="Study with me for my Database management System Course"
            updatedAt="4 weeks ago"
          />
        </div>
      </div>
    </main>
  );
}
