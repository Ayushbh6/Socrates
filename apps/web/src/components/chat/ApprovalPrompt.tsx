import { Check, X } from "lucide-react";
import type { PendingApproval } from "./ToolTimelineTypes";
import { formatApprovalPreview } from "./editPresentation";

interface ApprovalPromptProps {
  approval: PendingApproval;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
}

export function ApprovalPrompt({ approval, onApprovalDecision }: ApprovalPromptProps) {
  const isPending = approval.status === "pending";
  const friendlyFilePreview = formatApprovalPreview(approval);
  const shouldHideRawPreview =
    approval.actionKind === "file_write" ||
    approval.actionKind === "patch_apply" ||
    approval.actionPreview.includes("oldText") ||
    approval.actionPreview.includes("newText");

  return (
    <div className="mt-2 border-l border-amber-300 pl-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-brand-text-dark">{approval.title}</span>
            {approval.risk && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700">
                {approval.risk}
              </span>
            )}
            {!isPending && (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-text-light">
                {approval.status}
              </span>
            )}
          </div>
          {approval.description && <p className="mt-1 text-xs text-brand-text-light">{approval.description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={!isPending}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-brand-text-dark hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onApprovalDecision?.(approval.approvalId, "rejected")}
          >
            <X className="size-3" />
            Reject
          </button>
          <button
            type="button"
            disabled={!isPending}
            className="inline-flex items-center gap-1 rounded-md bg-brand-button px-2.5 py-1 text-xs font-medium text-white hover:bg-opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => onApprovalDecision?.(approval.approvalId, "approved")}
          >
            <Check className="size-3" />
            Approve
          </button>
        </div>
      </div>
      {friendlyFilePreview.length > 0 ? (
        <div className="mt-2 space-y-1 rounded-md bg-white p-2 text-xs text-brand-text-light">
          {friendlyFilePreview.map((line) => (
            <div key={line} className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-amber-400" />
              <span>{line}</span>
            </div>
          ))}
        </div>
      ) : shouldHideRawPreview ? (
        <div className="mt-2 rounded-md bg-white p-2 text-xs text-brand-text-light">
          File changes are ready for review. Approve to apply them to the workspace.
        </div>
      ) : approval.actionPreview ? (
        <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-white p-2 font-mono text-xs leading-5 text-brand-text-dark">
          {approval.actionPreview}
        </pre>
      ) : null}
    </div>
  );
}
