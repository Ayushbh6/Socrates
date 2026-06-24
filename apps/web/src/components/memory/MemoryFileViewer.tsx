"use client";

import { useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { Check, Copy, FileText, X } from "lucide-react";
import type { MemoryAgentFileSummary } from "@socrates/contracts";
import { Button } from "@/components/ui/Button";

export function MemoryFileViewer({
  file,
  content,
  isLoading,
  copied,
  onCopyPath,
  onClose,
}: {
  file: MemoryAgentFileSummary | null;
  content: string;
  isLoading: boolean;
  copied: boolean;
  onCopyPath: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!file) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [file, onClose]);

  if (!file) {
    return null;
  }

  const displayContent = formatReadableMemoryMarkdown(content);

  return (
    <>
      <button
        type="button"
        data-memory-file-backdrop
        aria-label="Close file viewer backdrop"
        className="fixed inset-0 z-30 bg-slate-950/20 backdrop-blur-[1px]"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-file-viewer-title"
        className="fixed inset-x-0 bottom-0 top-12 z-40 flex flex-col overflow-hidden rounded-t-lg border border-slate-200 bg-white shadow-2xl shadow-slate-300/70 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-full sm:max-w-2xl sm:rounded-none sm:border-y-0 sm:border-r-0"
      >
        <div className="border-b border-slate-100 px-4 py-4 sm:px-6 sm:py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-teal-700">
                <FileText className="size-4" />
                {file.kind.replace("_", " ")}
              </div>
              <h2 id="memory-file-viewer-title" className="mt-2 truncate text-xl font-semibold text-slate-950">
                {file.name}
              </h2>
            </div>
            <Button type="button" variant="ghost" size="icon" onClick={onClose} aria-label="Close file viewer">
              <X className="size-5" />
            </Button>
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <code className="min-w-0 flex-1 truncate text-xs text-slate-600">{file.absolutePath}</code>
            <Button type="button" variant="ghost" size="icon" onClick={onCopyPath} aria-label="Copy absolute path">
              {copied ? <Check className="size-4 text-teal-700" /> : <Copy className="size-4" />}
            </Button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6 sm:py-6">
          {isLoading ? (
            <p className="text-sm text-slate-500">Loading file...</p>
          ) : (
            <ReactMarkdown
              components={{
                h1: ({ children }) => <h1 className="mb-4 mt-0 text-2xl font-semibold text-slate-950">{children}</h1>,
                h2: ({ children }) => <h2 className="mb-3 mt-7 text-lg font-semibold text-slate-900">{children}</h2>,
                h3: ({ children }) => <h3 className="mb-2 mt-5 text-base font-semibold text-slate-900">{children}</h3>,
                p: ({ children }) => <p className="mb-4 text-sm leading-7 text-slate-700">{children}</p>,
                ul: ({ children }) => <ul className="mb-4 list-disc space-y-2 pl-5 text-sm leading-7 text-slate-700">{children}</ul>,
                ol: ({ children }) => <ol className="mb-4 list-decimal space-y-2 pl-5 text-sm leading-7 text-slate-700">{children}</ol>,
                code: ({ children }) => <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[0.85em] text-slate-800">{children}</code>,
                pre: ({ children }) => <pre className="mb-4 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-100">{children}</pre>,
                blockquote: ({ children }) => <blockquote className="mb-4 border-l-2 border-teal-600 pl-4 text-sm leading-7 text-slate-600">{children}</blockquote>,
                hr: () => <hr className="my-5 border-slate-200" />,
              }}
            >
              {displayContent}
            </ReactMarkdown>
          )}
        </div>
      </aside>
    </>
  );
}

function formatReadableMemoryMarkdown(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const frontmatterEnd = lines[0]?.trim() === "---" ? lines.slice(1).findIndex((line) => line.trim() === "---") : -1;
  const withoutFrontmatter = frontmatterEnd >= 0 ? lines.slice(frontmatterEnd + 2) : lines;
  return withoutFrontmatter
    .filter((line) => !line.trim().startsWith("<!-- socrates:") && !line.trim().startsWith("<!-- /socrates:"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimStart();
}
