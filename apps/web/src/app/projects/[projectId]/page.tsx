import { BackLink } from "@/components/ui/BackLink";
import { DashboardComposer } from "@/components/dashboard/DashboardComposer";
import { ConversationList } from "@/components/dashboard/ConversationList";
import { InstructionsPanel } from "@/components/dashboard/InstructionsPanel";
import { FilesPanel } from "@/components/dashboard/FilesPanel";

export default function ProjectDashboardPage({ params }: { params: { projectId: string } }) {
  return (
    <main className="min-h-screen bg-brand-bg py-12 px-6 flex justify-center">
      <div className="w-full max-w-5xl">
        <BackLink href="/projects" label="All projects" />
        
        <div className="grid grid-cols-1 md:grid-cols-3 gap-12 mt-4">
          {/* Main Column - Left (2/3 width) */}
          <div className="md:col-span-2">
            <h1 className="text-4xl font-serif text-brand-text-dark mb-2">DBMS</h1>
            <p className="text-brand-text-light text-base">Study with me for my Database management System Course</p>
            
            <DashboardComposer />
            <ConversationList projectId={params.projectId} />
          </div>

          {/* Resources Column - Right (1/3 width) */}
          <div className="md:col-span-1 border border-gray-200 bg-white rounded-3xl px-6 pb-2 shadow-sm self-start">
            <InstructionsPanel />
            <FilesPanel />
          </div>
        </div>
      </div>
    </main>
  );
}
