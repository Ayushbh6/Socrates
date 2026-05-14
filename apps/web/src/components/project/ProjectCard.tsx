import Link from "next/link";

interface ProjectCardProps {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
}

export function ProjectCard({ id, name, description, updatedAt }: ProjectCardProps) {
  return (
    <Link 
      href={`/projects/${id}`}
      className="block bg-white p-6 rounded-xl shadow-sm border border-gray-200 hover:border-brand-teal-dark hover:shadow-md transition-all cursor-pointer h-full flex flex-col justify-between"
    >
      <div>
        <h3 className="text-lg font-medium text-brand-text-dark mb-2">{name}</h3>
        {description && <p className="text-sm text-brand-text-light">{description}</p>}
      </div>
      <div className="mt-6 pt-4 border-t border-gray-100">
        <p className="text-xs text-gray-400">Updated {updatedAt}</p>
      </div>
    </Link>
  );
}
