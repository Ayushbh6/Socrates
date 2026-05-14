import { Button } from "@/components/ui/Button";
import Link from "next/link";

export default function NewProjectPage() {
  return (
    <main className="min-h-screen bg-brand-bg flex items-center justify-center p-6">
      <div className="w-full max-w-2xl">
        <h1 className="text-4xl font-serif text-brand-text-dark mb-10 text-center">Create a personal project</h1>
        
        <form className="flex flex-col gap-8">
          <div className="flex flex-col gap-3">
            <label className="text-base text-brand-text-dark">What are you working on?</label>
            <input 
              type="text" 
              placeholder="Name your project" 
              className="px-4 py-4 bg-white border border-gray-200 rounded-xl outline-none focus:border-brand-teal-dark shadow-sm transition-colors text-base"
            />
          </div>
          
          <div className="flex flex-col gap-3">
            <label className="text-base text-brand-text-dark">What are you trying to achieve?</label>
            <textarea 
              placeholder="Describe your project, goals, subject, etc..." 
              className="px-4 py-4 bg-white border border-gray-200 rounded-xl outline-none focus:border-brand-teal-dark shadow-sm transition-colors text-base resize-none h-40"
            />
          </div>
          
          <div className="flex justify-end gap-3 mt-4">
            <Button asChild variant="ghost" className="rounded-xl px-6 h-12 text-base text-brand-text-dark hover:bg-gray-100">
              <Link href="/projects">
                Cancel
              </Link>
            </Button>
            <Button type="button" className="rounded-xl px-6 h-12 text-base">
              Create project
            </Button>
          </div>
        </form>
      </div>
    </main>
  );
}
