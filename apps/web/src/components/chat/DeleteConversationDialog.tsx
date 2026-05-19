"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

interface DeleteConversationDialogProps {
  title: string;
  isDeleting: boolean;
  onCancel: () => void;
  onDelete: () => Promise<void>;
}

export function DeleteConversationDialog({ title, isDeleting, onCancel, onDelete }: DeleteConversationDialogProps) {
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async () => {
    setError(null);
    try {
      await onDelete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete conversation.");
    }
  };

  return (
    <Modal
      title="Delete conversation"
      description={`This will permanently delete "${title}" and its messages from Socrates.`}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isDeleting}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={isDeleting}>
            {isDeleting ? "Deleting" : "Delete"}
          </Button>
        </>
      }
    >
      {error && <p className="text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
