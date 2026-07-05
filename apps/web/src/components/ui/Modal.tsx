"use client";

import type { ReactNode } from "react";

export function Modal({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 px-6 py-8">
      <div className="flex max-h-[calc(100vh-4rem)] w-full max-w-2xl flex-col rounded-3xl border border-gray-200 bg-white p-6 shadow-2xl">
        <div className="mb-5 shrink-0">
          <h2 className="text-2xl font-semibold text-brand-text-dark">{title}</h2>
          {description && <p className="mt-2 text-sm leading-6 text-brand-text-light">{description}</p>}
        </div>
        <div className="min-h-0 overflow-y-auto pr-1">{children}</div>
        <div className="mt-6 flex shrink-0 justify-end gap-3">{footer}</div>
      </div>
    </div>
  );
}
