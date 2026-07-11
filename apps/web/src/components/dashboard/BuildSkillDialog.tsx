"use client";

import { FormEvent, useState } from "react";
import { AlertTriangle, FileArchive, Loader2, Sparkles } from "lucide-react";
import type { CommitSkillImportResponse, SkillImportPreview } from "@socrates/contracts";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

export type BuildSkillInput = {
  name?: string;
  request: string;
};

const isValidSkillId = (name: string) => /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name) && !name.includes("--");

export function BuildSkillDialog({
  projectName,
  title = "Build project skill",
  description,
  formId = "project-skill-form",
  placeholder = "Create a skill for how Socrates should review backend memory changes in this repo.",
  isBuilding,
  onCancel,
  onBuild,
  onPreviewImport,
  onCommitImport,
}: {
  projectName?: string;
  title?: string;
  description?: string;
  formId?: string;
  placeholder?: string;
  isBuilding: boolean;
  onCancel: () => void;
  onBuild: (input: BuildSkillInput) => Promise<void>;
  onPreviewImport?: (file: File) => Promise<SkillImportPreview>;
  onCommitImport?: (preview: SkillImportPreview, replace: boolean) => Promise<CommitSkillImportResponse>;
}) {
  const [mode, setMode] = useState<"build" | "import">("build");
  const [name, setName] = useState("");
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [archive, setArchive] = useState<File | null>(null);
  const [preview, setPreview] = useState<SkillImportPreview | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);
  const trimmedName = name.trim();
  const trimmedRequest = request.trim();
  const busy = isBuilding || isPreviewing || isInstalling;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedRequest) {
      setError("Describe the skill before building.");
      return;
    }
    if (trimmedName && !isValidSkillId(trimmedName)) {
      setError("Skill id must use lowercase letters, numbers, and single hyphens.");
      return;
    }
    setError(null);
    try {
      await onBuild({ request: trimmedRequest, ...(trimmedName ? { name: trimmedName } : {}) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build skill.");
    }
  };

  const handlePreview = async () => {
    if (!archive || !onPreviewImport) return;
    setError(null);
    setIsPreviewing(true);
    try {
      setPreview(await onPreviewImport(archive));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not inspect skill package.");
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleInstall = async () => {
    if (!preview || !onCommitImport) return;
    setError(null);
    setIsInstalling(true);
    try {
      await onCommitImport(preview, preview.conflict.exists);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not install skill.");
    } finally {
      setIsInstalling(false);
    }
  };

  return (
    <Modal
      title={onPreviewImport ? title.replace(/^Build /, "Add ") : title}
      description={description ?? `Describe the reusable workflow Socrates should learn for ${projectName ?? "this project"}.`}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          {mode === "build" ? (
            <Button type="submit" form={formId} disabled={isBuilding || !trimmedRequest}>{isBuilding ? "Building" : "Build skill"}</Button>
          ) : preview ? (
            <Button type="button" onClick={() => void handleInstall()} disabled={isInstalling}>
              {isInstalling && <Loader2 className="mr-2 size-4 animate-spin" />}
              {preview.conflict.exists ? "Replace skill" : "Install skill"}
            </Button>
          ) : (
            <Button type="button" onClick={() => void handlePreview()} disabled={!archive || isPreviewing}>
              {isPreviewing && <Loader2 className="mr-2 size-4 animate-spin" />}
              Review package
            </Button>
          )}
        </>
      }
    >
      {onPreviewImport && (
        <div className="mb-5 grid grid-cols-2 gap-2 rounded-lg bg-gray-100 p-1">
          <button type="button" onClick={() => setMode("build")} className={mode === "build" ? activeTabClass : tabClass}>
            <Sparkles className="size-4" /> Build with Socrates
          </button>
          <button type="button" onClick={() => setMode("import")} className={mode === "import" ? activeTabClass : tabClass}>
            <FileArchive className="size-4" /> Import ZIP
          </button>
        </div>
      )}

      {mode === "build" ? (
        <form id={formId} onSubmit={handleSubmit} className="space-y-4">
          <label className="block text-sm font-medium text-brand-text-dark">
            Skill id
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="memory-review"
              className="mt-2 w-full rounded-lg border border-gray-200 bg-brand-bg px-3 py-2 font-mono text-sm text-brand-text-dark outline-none transition-colors focus:border-brand-teal-dark"
            />
            <span className="mt-1 block text-xs font-normal leading-5 text-brand-text-light">Optional. Leave blank to auto-generate a unique id.</span>
          </label>
          <textarea
            value={request}
            onChange={(event) => setRequest(event.target.value)}
            placeholder={placeholder}
            className="h-48 w-full resize-none rounded-lg border border-gray-200 bg-brand-bg p-4 text-base leading-7 text-brand-text-dark outline-none transition-colors focus:border-brand-teal-dark"
          />
        </form>
      ) : (
        <div className="space-y-4">
          {!preview ? (
            <label className="block rounded-lg border border-dashed border-gray-300 bg-brand-bg p-5 text-center">
              <FileArchive className="mx-auto size-7 text-brand-teal-dark" />
              <span className="mt-2 block text-sm font-medium text-brand-text-dark">Choose an Agent Skill ZIP</span>
              <span className="mt-1 block text-xs leading-5 text-brand-text-light">One skill directory with SKILL.md. Maximum 30 MB and 200 files.</span>
              <input
                type="file"
                accept=".zip,application/zip"
                className="mt-4 block w-full text-sm text-brand-text-light file:mr-3 file:rounded-md file:border-0 file:bg-brand-teal-dark file:px-3 file:py-2 file:text-sm file:font-medium file:text-white"
                onChange={(event) => {
                  setArchive(event.target.files?.[0] ?? null);
                  setPreview(null);
                  setError(null);
                }}
              />
            </label>
          ) : (
            <div className="space-y-4">
              <div className="rounded-lg border border-gray-200 bg-brand-bg p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-base font-semibold text-brand-text-dark">{preview.skill.name}</p>
                    <p className="mt-1 text-sm leading-6 text-brand-text-light">{preview.skill.description}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-white px-2.5 py-1 text-xs font-medium text-brand-text-light">{preview.package.fileCount} files</span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-brand-text-light">
                  <span>Package: {preview.package.filename}</span>
                  <span>Size: {formatBytes(preview.package.totalBytes)}</span>
                  {preview.metadata.license && <span>License: {preview.metadata.license}</span>}
                  {preview.metadata.version && <span>Version: {preview.metadata.version}</span>}
                </div>
              </div>
              {preview.conflict.exists && (
                <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-6 text-amber-900">
                  <AlertTriangle className="mt-1 size-4 shrink-0" /> A skill named {preview.skill.name} already exists. Installing will replace it atomically.
                </div>
              )}
              {preview.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                  <p className="text-sm font-medium text-amber-900">Review {preview.warnings.length} warning{preview.warnings.length === 1 ? "" : "s"}</p>
                  <ul className="mt-2 max-h-28 space-y-1 overflow-y-auto text-xs leading-5 text-amber-800">
                    {preview.warnings.map((warning, index) => <li key={`${warning.code}-${warning.path ?? "package"}-${index}`}>• {warning.message}{warning.path ? ` (${warning.path})` : ""}</li>)}
                  </ul>
                </div>
              )}
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-brand-text-light">Package files</p>
                <div className="mt-2 max-h-28 overflow-y-auto rounded-lg bg-gray-950 p-3 font-mono text-xs leading-5 text-gray-200">
                  {preview.package.files.slice(0, 40).map((file) => <div key={file}>{file}</div>)}
                </div>
              </div>
              <button type="button" onClick={() => setPreview(null)} className="text-sm font-medium text-brand-teal-dark hover:underline">Choose another package</button>
            </div>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}

const tabClass = "flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm text-brand-text-light";
const activeTabClass = `${tabClass} bg-white font-medium text-brand-text-dark shadow-sm`;
const formatBytes = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`);
