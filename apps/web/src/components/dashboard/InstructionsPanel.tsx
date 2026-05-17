import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { GetProjectResponse } from "@socrates/contracts";

export function InstructionsPanel({ instructions }: { instructions?: GetProjectResponse["instructions"] }) {
  return (
    <div className="border-b border-gray-200 py-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-medium text-brand-text-dark">Instructions</h3>
        <Button variant="ghost" size="icon" className="size-6 text-brand-text-light hover:text-brand-text-dark hover:bg-gray-100 rounded-full">
          <Plus className="size-4" />
        </Button>
      </div>
      <p className="text-sm text-brand-text-light">
        {instructions?.content ?? "Add instructions to tailor Socrates's responses"}
      </p>
    </div>
  );
}
