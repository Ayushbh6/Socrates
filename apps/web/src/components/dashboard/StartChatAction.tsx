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
    <div className="my-8 flex shrink-0 justify-center">
      <Button type="button" size="lg" onClick={() => void onStart()} disabled={isStarting} className="gap-2">
        <MessageSquarePlus className="size-5" />
        {isStarting ? "Starting chat" : "Start new chat"}
      </Button>
    </div>
  );
}
