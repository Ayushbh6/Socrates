import { Search } from "lucide-react";

export function ProjectSearch() {
  return (
    <div className="relative mb-6">
      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
        <Search className="h-5 w-5 text-gray-400" />
      </div>
      <input
        type="text"
        placeholder="Search projects..."
        className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-lg outline-none focus:border-brand-teal-dark bg-white shadow-sm transition-colors text-brand-text-dark placeholder:text-gray-400"
      />
    </div>
  );
}
