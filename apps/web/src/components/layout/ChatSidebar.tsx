interface ChatSidebarProps {
  projectId: string;
}

export function ChatSidebar({ projectId }: ChatSidebarProps) {
  return (
    <aside className="w-64 border-r border-gray-200 bg-brand-bg flex flex-col hidden md:flex">
      <div className="p-4 border-b border-gray-200">
        <a href={`/projects/${projectId}`} className="text-sm text-brand-text-dark hover:text-brand-teal-dark font-medium flex items-center gap-2">
          <span>←</span> Dashboard
        </a>
      </div>
      <div className="flex-1 p-4">
        <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Project History</p>
        <div className="text-sm text-brand-text-dark bg-gray-100 p-2 rounded">Current Chat</div>
      </div>
    </aside>
  );
}
