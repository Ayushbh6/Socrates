"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

export function DeleteFlowItemDialog({ kind, onCancel, onDelete }: {
  kind: "focus" | "exchange";
  onCancel: () => void;
  onDelete: () => Promise<void>;
}) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async () => {
    setError(null);
    setIsDeleting(true);
    try {
      await onDelete();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete this item.");
      setIsDeleting(false);
    }
  };

  return (
    <Modal
      title={kind === "focus" ? "Delete focus?" : "Delete exchange?"}
      description={kind === "focus" ? "This removes its chat history." : "This removes the full turn."}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isDeleting}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={() => void remove()} disabled={isDeleting}>
            {isDeleting ? "Deleting" : "Delete"}
          </Button>
        </>
      }
    >
      {error && <p className="text-sm text-red-600">{error}</p>}
    </Modal>
  );
}
