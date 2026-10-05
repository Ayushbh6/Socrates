import { WrapText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { createPortal } from "react-dom";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { useDialog } from "../lib/dialog";
import { viewEvidence } from "../lib/evidence";
import type { Evidence } from "../lib/types";

/** The complete recorded output of one tool call: a diff in colour, a result as tidy JSON, or its text. */
export function EvidenceViewer({ task, handle, onClose }: { task: string; handle: string; onClose: () => void }) {
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wrap, setWrap] = useState(true);
  const modal = useRef<HTMLDivElement>(null);
  useDialog(modal, onClose);
  useEffect(() => {
    let active = true;
    setEvidence(null);
    setError(null);
    api.evidence(task, handle).then((found) => { if (active) setEvidence(found); }, (e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [task, handle]);
  const view = evidence ? viewEvidence(evidence.content) : null;

  // At the page level, so no panel's blur or clipping can trap the dialog.
  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={modal} tabIndex={-1} className="modal evidence" role="dialog" aria-modal="true" aria-label="Tool output">
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

/** A step's complete thinking, which the work shows only up to its first 20,000 characters. */
export function ThinkingViewer({ seq, onClose }: { seq: number; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modal = useRef<HTMLDivElement>(null);
  useDialog(modal, onClose);
  useEffect(() => {
    let active = true;
    api.thinking(seq).then((found) => { if (active) setText(found.text); }, (e) => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [seq]);

  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={modal} tabIndex={-1} className="modal evidence" role="dialog" aria-modal="true" aria-label="Thinking">
        <div className="modal-head">
          <div className="evidence-title">
            <strong>Thought</strong>
            <small>{text === null ? "…" : `${text.length.toLocaleString()} characters`}</small>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X aria-hidden /></button>
        </div>
        {error && <p className="setup-error" role="alert">{error}</p>}
        {text !== null && <div className="thinking-full"><Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown></div>}
      </div>
    </div>,
    document.body,
  );
}
