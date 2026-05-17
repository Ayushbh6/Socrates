"use client";

import { MessageSquarePlus } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function StartChatAction({
  isStarting,
  onStart,
}: {
  isStarting: boolean;
  onStart: () => Promise<void>;
}) {
  return (
    <div className="mt-12 mb-8 flex justify-center">
      <Button type="button" size="lg" onClick={() => void onStart()} disabled={isStarting} className="gap-2">
        <MessageSquarePlus className="size-5" />
        {isStarting ? "Starting chat" : "Start new chat"}
      </Button>
    </div>
  );
}
