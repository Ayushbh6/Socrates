"use client";

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";

interface DeleteConversationDialogProps {
  linkedToFlow: boolean;
  isChecking: boolean;
  impactError?: string;
  isDeleting: boolean;
  onCancel: () => void;
  onDelete: (scope: "classic_only" | "everywhere") => Promise<void>;
}

export function DeleteConversationDialog({ linkedToFlow, isChecking, impactError, isDeleting, onCancel, onDelete }: DeleteConversationDialogProps) {
  const [error, setError] = useState<string | null>(null);

  const handleDelete = async (scope: "classic_only" | "everywhere") => {
    setError(null);
    try {
      await onDelete(scope);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete conversation.");
    }
  };

  return (
    <Modal
      title="Delete conversation?"
      description={isChecking ? "Checking linked history…" : linkedToFlow ? "Keep Flow history or remove it everywhere?" : "This cannot be undone."}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onCancel} disabled={isDeleting}>
            Cancel
          </Button>
          {linkedToFlow ? (
            <>
              <Button type="button" variant="outline" onClick={() => void handleDelete("classic_only")} disabled={isChecking || Boolean(impactError) || isDeleting}>
                Classic only
              </Button>
              <Button type="button" variant="destructive" onClick={() => void handleDelete("everywhere")} disabled={isChecking || Boolean(impactError) || isDeleting}>
                {isDeleting ? "Deleting" : "Everywhere"}
              </Button>
            </>
          ) : (
            <Button type="button" variant="destructive" onClick={() => void handleDelete("classic_only")} disabled={isChecking || Boolean(impactError) || isDeleting}>
              {isDeleting ? "Deleting" : "Delete"}
            </Button>
          )}
        </>
      }
    >
      {(impactError || error) && <p className="text-sm text-red-600">{impactError ?? error}</p>}
    </Modal>
  );
}
