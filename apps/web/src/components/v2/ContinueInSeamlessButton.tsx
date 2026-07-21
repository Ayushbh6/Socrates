"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { MessageAttachment, ModelOption, ModelThinkingOption } from "@socrates/contracts";
import { v2Api } from "@/lib/v2/api";
import { appendViewHandoff, createViewHandoff } from "@/lib/v2/viewHandoff";

export function ContinueInSeamlessButton({
  projectId,
  conversationId,
  hasPersistedTurns,
  draftText,
  attachments,
  selectedModel,
  selectedThinkingOption,
}: {
  projectId: string;
  conversationId: string;
  hasPersistedTurns: boolean;
  draftText: string;
  attachments: MessageAttachment[];
  selectedModel: ModelOption | null;
  selectedThinkingOption: ModelThinkingOption | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="relative ml-2 shrink-0">
      <button
        type="button"
        disabled={busy}
        className="inline-flex h-9 items-center rounded-md border border-slate-200/80 bg-white/90 px-3 text-xs font-medium text-brand-text-light shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-brand-text-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal-dark disabled:cursor-wait disabled:opacity-60"
        onClick={() => {
          setBusy(true);
          setError(null);
          const navigation = hasPersistedTurns
            ? v2Api.continueClassicInSeamless(projectId, conversationId).then(({ href }) => href)
            : v2Api.ensureFlow(projectId).then(() => `/seamless/projects/${encodeURIComponent(projectId)}`);
          void navigation
            .then((href) => {
              const nonce = createViewHandoff({
                target: "flow",
                projectId,
                conversationId,
                text: draftText,
                attachments,
                model: selectedModel,
                thinking: selectedThinkingOption,
              });
              router.push(appendViewHandoff(href, nonce));
            })
            .catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : "Could not continue this chat in Seamless View.");
              setBusy(false);
            });
        }}
      >
        {busy ? "Bridging…" : "Continue in Flow View ↗"}
      </button>
      {error ? (
        <p
          className="absolute right-0 top-11 z-30 w-72 rounded-md border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-700 shadow-lg"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
