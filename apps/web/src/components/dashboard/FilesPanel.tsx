"use client";

import { Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { ProjectResource } from "@socrates/contracts";
import { useState } from "react";
import { formatFileSize } from "@/lib/format";
import { FileUploadDialog } from "./FileUploadDialog";

export function FilesPanel({
  resources,
  isUploading = false,
  deletingResourceId,
  onUpload,
  onDelete,
}: {
  resources: ProjectResource[];
  isUploading?: boolean;
  deletingResourceId?: string | null;
  onUpload?: (files: File[]) => Promise<void>;
  onDelete?: (resourceId: string) => Promise<void>;
}) {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  const handleDelete = async (resource: ProjectResource) => {
    if (!onDelete || deletingResourceId) {
      return;
    }
    const shouldDelete = window.confirm(
      `Remove "${resource.name}" from this project? Uploaded Socrates-owned copies will also be deleted from .socrates/resources.`,
    );
    if (!shouldDelete) {
      return;
    }
    await onDelete(resource.id);
  };

  return (
    <div className="py-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-medium text-brand-text-dark">Files</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          disabled={!onUpload || isUploading}
          onClick={() => setIsDialogOpen(true)}
          className="size-6 text-brand-text-light hover:text-brand-text-dark hover:bg-gray-100 rounded-full"
        >
          {isUploading ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        </Button>
      </div>
      <div className="max-h-[23rem] overflow-y-auto pr-1">
        <div className="grid grid-cols-2 gap-3">
          {resources.length === 0 && <p className="col-span-2 text-sm text-brand-text-light">No files yet.</p>}
          {resources.map((resource) => {
            const isDeleting = deletingResourceId === resource.id;
            return (
              <div
                key={resource.id}
                className="group relative bg-white border border-gray-200 rounded-xl p-4 shadow-sm flex flex-col justify-between focus-within:ring-2 focus-within:ring-brand-forest/20"
              >
                {onDelete && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={Boolean(deletingResourceId)}
                    aria-label={`Remove ${resource.name}`}
                    onClick={() => {
                      void handleDelete(resource).catch(() => undefined);
                    }}
                    className="absolute -left-2 -top-2 size-7 rounded-full border border-gray-200 bg-white text-brand-text-light opacity-0 shadow-sm transition hover:bg-gray-50 hover:text-red-600 group-hover:opacity-100 focus:opacity-100 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {isDeleting ? <Loader2 className="size-3.5 animate-spin" /> : <X className="size-3.5" />}
                  </Button>
                )}
                <div>
                  <p className="text-sm font-medium text-brand-text-dark truncate">{resource.name}</p>
                  <p className="text-xs text-brand-text-light mt-1">{resource.mimeType ?? resource.source.replaceAll("_", " ")}</p>
                  <p className="text-xs text-brand-text-light mt-1">{formatFileSize(resource.sizeBytes)}</p>
                </div>
                <div className="mt-4">
                  <span className="inline-block px-2 py-1 bg-gray-100 text-gray-500 text-[10px] uppercase font-semibold rounded">
                    {resource.kind}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {isDialogOpen && onUpload && (
        <FileUploadDialog
          isUploading={isUploading}
          onCancel={() => setIsDialogOpen(false)}
          onUpload={onUpload}
        />
      )}
    </div>
  );
}
