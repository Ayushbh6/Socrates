"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

interface RenameConversationDialogProps {
  initialTitle: string;
  isSaving: boolean;
  onCancel: () => void;
  onSave: (title: string) => Promise<void>;
}

export function RenameConversationDialog({ initialTitle, isSaving, onCancel, onSave }: RenameConversationDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState<string | null>(null);
  const trimmedTitle = title.trim();

  const handleSave = async () => {
    if (!trimmedTitle) {
      setError("Conversation title is required.");
      return;
    }
    setError(null);
    try {
      await onSave(trimmedTitle);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not rename conversation.");
    }
  };

  return (
    <Modal
      title="Rename conversation"
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSave()} disabled={isSaving || !trimmedTitle}>
            {isSaving ? "Saving" : "Save"}
          </Button>
        </>
      }
    >
      <label className="block text-sm font-medium text-brand-text-dark" htmlFor="conversation-title">
        Title
      </label>
      <input
        id="conversation-title"
        className="mt-2 w-full rounded-xl border border-gray-200 bg-brand-bg px-4 py-3 text-base text-brand-text-dark outline-none transition-colors focus:border-brand-teal-dark"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        autoFocus
      />
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
