import { Search } from "lucide-react";

interface ProjectSearchProps {
  value: string;
  onChange: (value: string) => void;
}

export function ProjectSearch({ value, onChange }: ProjectSearchProps) {
  return (
    <div className="relative mb-6">
      <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
        <Search className="h-5 w-5 text-gray-400" />
      </div>
      <input
        type="text"
        placeholder="Search projects..."
        aria-label="Search projects"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="block w-full rounded-lg border border-gray-200 bg-white py-3 pl-10 pr-3 text-brand-text-dark shadow-sm outline-none transition-colors placeholder:text-gray-400 focus:border-brand-teal-dark"
      />
    </div>
  );
}
