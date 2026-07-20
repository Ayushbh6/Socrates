import { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  action?: ReactNode;
}

export function PageHeader({ title, action }: PageHeaderProps) {
  return (
    <div className="flex shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <h1 className="min-w-0 truncate font-serif text-2xl text-brand-text-dark sm:text-3xl">{title}</h1>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
