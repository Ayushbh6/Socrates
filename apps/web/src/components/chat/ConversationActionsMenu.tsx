"use client";

import { MoreHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";

interface ConversationActionsMenuProps {
  onRename: () => void;
  onDelete: () => void;
}

export function ConversationActionsMenu({ onRename, onDelete }: ConversationActionsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [isOpen]);

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        aria-label="Conversation actions"
        className="flex size-8 items-center justify-center rounded-full text-brand-text-light transition-colors hover:bg-gray-100 hover:text-brand-text-dark"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setIsOpen((current) => !current);
        }}
      >
        <MoreHorizontal className="size-4" />
      </button>
      {isOpen && (
        <div className="absolute right-0 top-9 z-20 w-36 rounded-xl border border-gray-200 bg-white p-1 text-sm shadow-lg">
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-brand-text-dark hover:bg-gray-50"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsOpen(false);
              onRename();
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="block w-full rounded-lg px-3 py-2 text-left text-red-600 hover:bg-red-50"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setIsOpen(false);
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}
