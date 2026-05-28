import { Check, ShieldCheck, X } from "lucide-react";
import type { PendingApproval } from "./ToolTimelineTypes";
import { DiffView } from "./DiffView";
import { formatApprovalPreview, parseDiff } from "./editPresentation";

interface ApprovalPromptProps {
  approval: PendingApproval;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
}

export function ApprovalPrompt({ approval, onApprovalDecision }: ApprovalPromptProps) {
  const isPending = approval.status === "pending";
  const isApproved = approval.status === "approved";
  const friendlyFilePreview = formatApprovalPreview(approval);
  const diffFiles = parseDiff(approval.actionPreview);
  const shouldHideRawPreview =
    approval.actionKind === "file_write" ||
    approval.actionKind === "patch_apply" ||
    approval.actionPreview.includes("oldText") ||
    approval.actionPreview.includes("newText");

  const frameClass = isPending
    ? "border-amber-200 bg-amber-50/50 ring-amber-100"
    : isApproved
      ? "border-emerald-200 bg-emerald-50/40 ring-emerald-100"
      : "border-gray-200 bg-gray-50 ring-gray-100";

  return (
    <div className={`mt-2 overflow-hidden rounded-xl border p-3 shadow-sm ring-1 ${frameClass}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-2.5">
          <span
            className={`mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full ${
              isPending ? "bg-amber-100 text-amber-700" : isApproved ? "bg-emerald-100 text-emerald-700" : "bg-gray-200 text-gray-600"
            }`}
          >
            <ShieldCheck className="size-4" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-brand-text-dark">{approval.title}</span>
              {approval.risk && (
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${riskClass(approval.risk)}`}>
                  {approval.risk} risk
                </span>
              )}
              {!isPending && (
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                    isApproved ? "bg-emerald-100 text-emerald-700" : "bg-gray-200 text-gray-600"
                  }`}
                >
                  {approval.status}
                </span>
              )}
            </div>
            <p className="mt-1 text-xs text-brand-text-light">
              {approval.description ?? "Socrates needs your approval before continuing."}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-brand-text-dark transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onApprovalDecision?.(approval.approvalId, "rejected")}
          >
            <X className="size-3.5" />
            Reject
          </button>
          <button
            type="button"
            disabled={!isPending}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-button px-3.5 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => onApprovalDecision?.(approval.approvalId, "approved")}
          >
            <Check className="size-3.5" />
            Approve
          </button>
        </div>
      </div>
      {diffFiles.length > 0 ? (
        <div className="mt-3">
          <DiffView files={diffFiles} />
        </div>
      ) : friendlyFilePreview.length > 0 ? (
        <div className="mt-3 space-y-1 rounded-lg border border-gray-100 bg-white p-2.5 text-xs text-brand-text-dark">
          {friendlyFilePreview.map((line) => (
            <div key={line} className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-amber-400" />
              <span className="font-mono">{line}</span>
            </div>
          ))}
        </div>
      ) : shouldHideRawPreview ? (
        <div className="mt-3 rounded-lg border border-gray-100 bg-white p-2.5 text-xs text-brand-text-light">
          File changes are ready for review. Approve to apply them to the workspace.
        </div>
      ) : approval.actionPreview ? (
        <pre className="mt-3 max-h-40 overflow-auto rounded-lg border border-gray-100 bg-white p-2.5 font-mono text-xs leading-5 text-brand-text-dark">
          {approval.actionPreview}
        </pre>
      ) : null}
    </div>
  );
}

function riskClass(risk: string): string {
  if (risk === "high") {
    return "bg-red-100 text-red-700";
  }
  if (risk === "medium") {
    return "bg-amber-100 text-amber-700";
  }
  return "bg-gray-200 text-gray-600";
}
