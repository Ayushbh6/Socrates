"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

export function BuildSkillDialog({
  projectName,
  title = "Build project skill",
  description,
  formId = "project-skill-form",
  placeholder = "Create a skill for how Socrates should review backend memory changes in this repo.",
  isBuilding,
  onCancel,
  onBuild,
}: {
  projectName?: string;
  title?: string;
  description?: string;
  formId?: string;
  placeholder?: string;
  isBuilding: boolean;
  onCancel: () => void;
  onBuild: (request: string) => Promise<void>;
}) {
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmedRequest = request.trim();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedRequest) {
      setError("Describe the skill before building.");
      return;
    }

    setError(null);
    try {
      await onBuild(trimmedRequest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build skill.");
    }
  };

  return (
    <Modal
      title={title}
      description={description ?? `Describe the reusable workflow Socrates should learn for ${projectName ?? "this project"}.`}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isBuilding}>
            Cancel
          </Button>
          <Button type="submit" form={formId} disabled={isBuilding || !trimmedRequest}>
            {isBuilding ? "Building" : "Build skill"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit}>
        <textarea
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder={placeholder}
          className="h-56 w-full resize-none rounded-2xl border border-gray-200 bg-brand-bg p-4 text-base leading-7 text-brand-text-dark outline-none transition-colors focus:border-brand-teal-dark"
        />
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </form>
    </Modal>
  );
}
