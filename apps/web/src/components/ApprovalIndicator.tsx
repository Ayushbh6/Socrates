import { CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Exchange } from "../lib/model";
import { approvalExchange } from "../lib/approvals";
import { type AppState, store } from "../lib/store";
import type { PendingApproval } from "../lib/types";
import { Popover } from "./Popover";

/** Pending questions remain reachable even when another chat or mode is on screen. */
export function ApprovalIndicator({ app, onOpen }: { app: AppState; onOpen: (exchange: Exchange) => void }) {
  const approvals = app.model.live?.approvals ?? [];
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (approvals.length < 2) setOpen(false); }, [approvals.length]);
  if (!approvals.length) return null;
  const label = approvals.length === 1 ? "Approval needed" : `${approvals.length} approvals needed`;
  const visit = async (approval: PendingApproval) => {
    setLoading(true);
    try {
      const exchange = await store.resolveApproval(approval);
      if (exchange) { setOpen(false); onOpen(exchange); }
    } finally { setLoading(false); }
  };
  return (
    <div className="approval-indicator">
      <button ref={button} type="button" className="chip approval-notice" aria-label={label} title="Open the question waiting for approval" aria-busy={loading} disabled={loading} {...(approvals.length > 1 ? { "aria-expanded": open, "aria-haspopup": "menu" as const } : {})} onClick={() => approvals.length === 1 ? void visit(approvals[0]!) : setOpen(!open)}>
        <CircleAlert aria-hidden /><span className="approval-notice-label">{label}</span><span className="approval-notice-count" aria-hidden>{approvals.length}</span>
      </button>
      {open && approvals.length > 1 && <Popover align="right" className="approval-menu" onClose={() => { setOpen(false); button.current?.focus(); }}>
        {approvals.map((a, i) => <button key={a.id} type="button" role="menuitem" autoFocus={i === 0} disabled={loading} onClick={() => void visit(a)}>
          <strong>{a.task?.replace(/^g\d+\/t\d+\s+/, "") ?? (a.lane ? `Lane ${a.lane}` : "Main conversation")}</strong>
          <span>{approvalExchange(app.model, a)?.message ?? a.detail}</span><small>Open question</small>
        </button>)}
      </Popover>}
    </div>
  );
}
