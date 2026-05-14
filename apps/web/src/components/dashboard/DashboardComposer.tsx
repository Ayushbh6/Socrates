import { Plus, ArrowUp } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function DashboardComposer() {
  return (
    <div className="relative mt-12 mb-6">
      <textarea
        placeholder="Type / for skills"
        className="w-full bg-white border border-gray-200 rounded-2xl p-4 pr-14 pb-14 outline-none focus:border-brand-teal-dark shadow-sm resize-none h-32"
      />
      <div className="absolute bottom-3 left-3 flex items-center gap-2">
        <Button variant="ghost" size="icon" className="size-8 rounded-full text-brand-text-light hover:text-brand-text-dark hover:bg-gray-100">
          <Plus className="size-5" />
        </Button>
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-2">
        <Button size="icon" className="size-8 rounded-full">
          <ArrowUp className="size-4" />
        </Button>
      </div>
    </div>
  );
}
