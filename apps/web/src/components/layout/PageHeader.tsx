import { ReactNode } from "react";

interface PageHeaderProps {
  title: string;
  action?: ReactNode;
}

export function PageHeader({ title, action }: PageHeaderProps) {
  return (
    <header className="flex items-center justify-between mb-12 shrink-0">
      <h1 className="text-3xl font-serif text-brand-text-dark">{title}</h1>
      {action && <div>{action}</div>}
    </header>
  );
}
