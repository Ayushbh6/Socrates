import { WrapText, X } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../lib/api";
import { viewEvidence } from "../lib/evidence";
import type { Evidence } from "../lib/types";

/** The complete recorded output of one tool call: a diff in colour, a result as tidy JSON, or its text. */
export function EvidenceViewer({ task, handle, onClose }: { task: string; handle: string; onClose: () => void }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);
  useEffect(() => {
    api.evidence(task, handle).then(setEvidence, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, [task, handle]);
  useEffect(() => {
    const close = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  const view = evidence ? viewEvidence(evidence.content) : null;

  // At the page level, so no panel's blur or clipping can trap the dialog.
  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal evidence" role="dialog" aria-modal="true" aria-label="Tool output">
        <div className="modal-head">
          <div className="evidence-title">
            <code>{evidence?.line ?? "…"}</code>
            <small>{task} · {handle}{evidence?.status === "error" ? " · failed" : ""}</small>
          </div>
          <div>
            <button type="button" className="icon-button" data-on={wrap} onClick={() => setWrap(!wrap)} aria-pressed={wrap} aria-label="Wrap long lines" title="Wrap long lines"><WrapText aria-hidden /></button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X aria-hidden /></button>
          </div>
        </div>
        {error && <p className="setup-error" role="alert">{error}</p>}
        {view && (
          <pre className="evidence-body" data-wrap={wrap}>
            {view.kind === "diff" ? view.lines.map((l, i) => <span key={i} className="diff-line" data-type={l.type}>{l.text}{"\n"}</span>) : view.text}
          </pre>
        )}
        {evidence && (evidence.truncated || evidence.outputLost) && (
          <p className="evidence-note">
            {evidence.truncated ? "Only the first 200,000 characters are shown. " : ""}
            {evidence.outputLost ? "Some output was not kept, because the command printed more than Socrates retains." : ""}
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
