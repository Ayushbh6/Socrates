import { Plus } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function FilesPanel() {
  return (
    <div className="py-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-medium text-brand-text-dark">Files</h3>
        <Button variant="ghost" size="icon" className="size-6 text-brand-text-light hover:text-brand-text-dark hover:bg-gray-100 rounded-full">
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {/* Example File Card */}
        <div className="bg-white border border-gray-200 rounded-xl p-4 shadow-sm flex flex-col justify-between">
          <div>
            <p className="text-sm font-medium text-brand-text-dark truncate">DBS-5.pdf</p>
            <p className="text-xs text-brand-text-light mt-1">2,744 lines</p>
          </div>
          <div className="mt-4">
            <span className="inline-block px-2 py-1 bg-gray-100 text-gray-500 text-[10px] uppercase font-semibold rounded">PDF</span>
          </div>
        </div>
      </div>
    </div>
  );
}
