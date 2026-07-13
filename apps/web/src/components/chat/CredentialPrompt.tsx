"use client";

import { Eye, EyeOff, KeyRound, LockKeyhole, X } from "lucide-react";
import { useState } from "react";
import type { PendingCredentialInput } from "./ToolTimelineTypes";

export function CredentialPrompt({
  request,
  onSubmit,
}: {
  request: PendingCredentialInput;
  onSubmit?: (request: PendingCredentialInput, decision: "submitted" | "cancelled", value?: string) => void;
}) {
  const [value, setValue] = useState("");
  const [isVisible, setIsVisible] = useState(false);
  const isPending = request.status === "pending";
  const serverName = request.serverLabel ?? request.serverId;
  const submit = () => {
    if (!value.trim()) return;
    const submittedValue = value;
    setValue("");
    onSubmit?.(request, "submitted", submittedValue);
  };
  const cancel = () => {
    setValue("");
    onSubmit?.(request, "cancelled");
  };

  if (!isPending) {
    return (
      <div className="mt-2 flex items-center gap-2 rounded-lg bg-emerald-50/60 px-3 py-2 text-xs text-emerald-800 ring-1 ring-inset ring-emerald-100">
        <LockKeyhole className="size-3.5" />
        {request.status === "submitted" ? "Credential received securely." : "Credential entry cancelled."}
      </div>
    );
  }

  return (
    <div className="mt-2 overflow-hidden rounded-xl bg-teal-50/55 ring-1 ring-inset ring-teal-100">
      <div className="flex items-start gap-2.5 px-3 pb-2 pt-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white text-brand-teal-dark shadow-sm ring-1 ring-teal-100">
          <KeyRound className="size-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-brand-text-dark">Connect {serverName}</p>
          <p className="mt-0.5 text-xs leading-5 text-brand-text-light">
            Enter <span className="font-mono text-brand-text-dark">{request.envKey}</span>. It goes directly to Socrates&apos; local credential store and is never shared with the model.
          </p>
        </div>
      </div>
      <div className="border-t border-teal-100/80 bg-white/65 px-3 py-3">
        <label className="block text-[11px] font-medium uppercase tracking-wide text-brand-text-light" htmlFor={request.credentialRequestId}>
          API credential
        </label>
        <div className="mt-1.5 flex items-center rounded-lg border border-gray-200 bg-white shadow-sm transition focus-within:border-brand-teal-dark focus-within:ring-2 focus-within:ring-teal-700/10">
          <input
            id={request.credentialRequestId}
            type={isVisible ? "text" : "password"}
            value={value}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
            placeholder={`Enter ${request.envKey}`}
            className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm text-brand-text-dark outline-none placeholder:font-sans placeholder:text-gray-400"
          />
          <button
            type="button"
            className="mr-1.5 rounded-md p-1.5 text-brand-text-light transition hover:bg-gray-100 hover:text-brand-text-dark"
            onClick={() => setIsVisible((current) => !current)}
            aria-label={isVisible ? "Hide credential" : "Show credential"}
          >
            {isVisible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
        <div className="mt-2.5 flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-brand-text-light">
            <LockKeyhole className="size-3" /> Not saved in chat history
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-brand-text-light transition hover:bg-gray-100 hover:text-brand-text-dark"
              onClick={cancel}
            >
              <X className="size-3.5" /> Cancel
            </button>
            <button
              type="button"
              disabled={!value.trim()}
              className="rounded-lg bg-brand-button px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={submit}
            >
              Save and continue
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
