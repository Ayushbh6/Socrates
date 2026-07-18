"use client";

import { useState } from "react";
import { v2Api } from "@/lib/v2/api";

export function ContinueInSeamlessButton({ projectId, conversationId }: { projectId: string; conversationId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="fixed right-5 top-[4.25rem] z-20 flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={busy}
        className="inline-flex h-9 items-center rounded-md border border-slate-200/80 bg-white/90 px-3 text-xs font-medium text-brand-text-light shadow-sm backdrop-blur transition-colors hover:bg-white hover:text-brand-text-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal-dark disabled:cursor-wait disabled:opacity-60"
        onClick={() => {
          setBusy(true);
          setError(null);
          void v2Api.continueClassicInSeamless(projectId, conversationId)
            .then(({ href }) => { window.location.href = href; })
            .catch((reason: unknown) => {
              setError(reason instanceof Error ? reason.message : "Could not continue this chat in Seamless View.");
              setBusy(false);
            });
        }}
      >
        {busy ? "Bridging…" : "Continue in Flow View ↗"}
      </button>
      {error && <p className="max-w-72 rounded bg-red-50 px-2 py-1 text-[11px] text-red-700" role="alert">{error}</p>}
    </div>
  );
}
