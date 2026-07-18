import type { ReactNode } from "react";

interface WorkspaceTopbarProps {
  isSidebarCollapsed: boolean;
  children: ReactNode;
}

export function WorkspaceTopbar({ isSidebarCollapsed, children }: WorkspaceTopbarProps) {
  return (
    <header
      className={`flex h-14 min-w-0 shrink-0 items-center border-b border-gray-200 bg-white ${
        isSidebarCollapsed ? "pl-16 pr-6" : "px-6"
      }`}
    >
      {children}
    </header>
  );
}
