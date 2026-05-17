"use client";

import { ChangeEvent, FormEvent, useState } from "react";
import { FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { formatFileSize } from "@/lib/format";

const maxFilesPerUpload = 10;

export function FileUploadDialog({
  isUploading,
  onCancel,
  onUpload,
}: {
  isUploading: boolean;
  onCancel: () => void;
  onUpload: (files: File[]) => Promise<void>;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (selectedFiles.length > maxFilesPerUpload) {
      setError("Select up to 10 files at once.");
      setFiles([]);
      return;
    }

    setError(null);
    setFiles(selectedFiles);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (files.length === 0) {
      setError("Select at least one file.");
      return;
    }

    setError(null);
    try {
      await onUpload(files);
      onCancel();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not upload files.");
    }
  };

  return (
    <Modal
      title="Add project files"
      description="Upload PDFs, documents, text files, images, or other local resources for this project."
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isUploading}>
            Cancel
          </Button>
          <Button type="submit" form="project-file-upload-form" disabled={isUploading || files.length === 0}>
            {isUploading ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Uploading
              </>
            ) : (
              "Upload files"
            )}
          </Button>
        </>
      }
    >
      <form id="project-file-upload-form" onSubmit={handleSubmit}>
        <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-brand-bg px-6 py-10 text-center transition-colors hover:border-brand-teal-dark">
          <FileText className="mb-3 size-8 text-brand-text-light" />
          <span className="text-sm font-medium text-brand-text-dark">Choose up to 10 files</span>
          <span className="mt-1 text-xs text-brand-text-light">Selected files will be copied into .socrates/resources.</span>
          <input type="file" multiple className="hidden" onChange={handleFileChange} />
        </label>

        {files.length > 0 && (
          <div className="mt-4 max-h-64 overflow-y-auto rounded-2xl border border-gray-200">
            {files.map((file) => (
              <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center justify-between border-b border-gray-100 px-4 py-3 last:border-b-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-brand-text-dark">{file.name}</p>
                  <p className="text-xs text-brand-text-light">{file.type || "Unknown type"}</p>
                </div>
                <span className="ml-4 shrink-0 text-xs text-brand-text-light">{formatFileSize(file.size)}</span>
              </div>
            ))}
          </div>
        )}

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </form>
    </Modal>
  );
}
