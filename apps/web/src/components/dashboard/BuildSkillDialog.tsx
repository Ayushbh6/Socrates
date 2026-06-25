"use client";

import { FormEvent, useState } from "react";
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
}: {
  projectName?: string;
  title?: string;
  description?: string;
  formId?: string;
  placeholder?: string;
  isBuilding: boolean;
  onCancel: () => void;
  onBuild: (input: BuildSkillInput) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [request, setRequest] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmedName = name.trim();
  const trimmedRequest = request.trim();

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
      await onBuild({
        request: trimmedRequest,
        ...(trimmedName ? { name: trimmedName } : {}),
      });
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
      <form id={formId} onSubmit={handleSubmit} className="space-y-4">
        <label className="block text-sm font-medium text-brand-text-dark">
          Skill id
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="memory-review"
            className="mt-2 w-full rounded-lg border border-gray-200 bg-brand-bg px-3 py-2 font-mono text-sm text-brand-text-dark outline-none transition-colors focus:border-brand-teal-dark"
          />
          <span className="mt-1 block text-xs font-normal leading-5 text-brand-text-light">
            Optional. Leave blank to auto-generate a unique id.
          </span>
        </label>
        <textarea
          value={request}
          onChange={(event) => setRequest(event.target.value)}
          placeholder={placeholder}
          className="h-48 w-full resize-none rounded-lg border border-gray-200 bg-brand-bg p-4 text-base leading-7 text-brand-text-dark outline-none transition-colors focus:border-brand-teal-dark"
        />
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </form>
    </Modal>
  );
}
