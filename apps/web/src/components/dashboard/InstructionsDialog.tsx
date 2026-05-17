"use client";

import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

export function InstructionsDialog({
  initialContent,
  projectName,
  isSaving,
  onCancel,
  onSave,
}: {
  initialContent: string;
  projectName: string;
  isSaving: boolean;
  onCancel: () => void;
  onSave: (content: string) => Promise<void>;
}) {
  const [content, setContent] = useState(initialContent);
  const [error, setError] = useState<string | null>(null);
  const trimmedContent = content.trim();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedContent) {
      setError("Write instructions before saving.");
      return;
    }

    setError(null);
    try {
      await onSave(trimmedContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save instructions.");
    }
  };

  return (
    <Modal
      title="Set project instructions"
      description={`Provide Socrates with relevant instructions and information for chats within ${projectName}.`}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="submit" form="project-instructions-form" disabled={isSaving || !trimmedContent}>
            {isSaving ? "Saving" : "Save instructions"}
          </Button>
        </>
      }
    >
      <form id="project-instructions-form" onSubmit={handleSubmit}>
        <textarea
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Think step by step and use the repo docs before making changes."
          className="h-72 w-full resize-none rounded-2xl border border-gray-200 bg-brand-bg p-4 text-base leading-7 text-brand-text-dark outline-none transition-colors focus:border-brand-teal-dark"
        />
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </form>
    </Modal>
  );
}
