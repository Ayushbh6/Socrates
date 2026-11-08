import { WrapText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { createPortal } from "react-dom";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import { useDialog } from "../lib/dialog";
import { viewEvidence } from "../lib/evidence";
import { evidenceLayout } from "../lib/output";
import { Code, ToolOutput } from "./ToolOutput";
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
  const laid = evidence ? evidenceLayout(evidence.tool, evidence.content, evidence.call?.target ?? null) : null;
  const view = evidence && !laid ? viewEvidence(evidence.content) : null;

  // At the page level, so no panel's blur or clipping can trap the dialog.
  return createPortal(
    <div className="modal-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={modal} tabIndex={-1} className="modal evidence" role="dialog" aria-modal="true" aria-label="Tool output">
        <div className="modal-head">
          <div className="evidence-title">
            {evidence?.call ? <span>{evidence.call.verb} {evidence.call.target && <code>{evidence.call.target}</code>} {evidence.call.detail}</span> : <code>{evidence?.line ?? "…"}</code>}
            {evidence?.status === "error" && <small>failed</small>}
          </div>
          <div>
            <button type="button" className="icon-button" data-on={wrap} onClick={() => setWrap(!wrap)} aria-pressed={wrap} aria-label="Wrap long lines" title="Wrap long lines"><WrapText aria-hidden /></button>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X aria-hidden /></button>
          </div>
        </div>
        {error && <p className="setup-error" role="alert">{error}</p>}
        {evidence?.call?.command && <pre className="evidence-command"><span aria-hidden className="tool-prompt">$ </span><Code code={evidence.call.command} language="bash" /></pre>}
        {laid && (
          <div className="evidence-body evidence-laid" data-wrap={wrap}>
            {laid.facts.length > 0 && <p className="evidence-facts">{laid.facts.join(" · ")}</p>}
            <ToolOutput layout={laid.layout.kind === "terminal" ? { ...laid.layout, wrap: wrap || laid.layout.wrap } : laid.layout} cut={null} pattern={evidence?.tool === "grep" ? evidence.call?.target ?? null : null} />
          </div>
        )}
        {view && (
          <pre className="evidence-body" data-wrap={wrap}>
            {view.kind === "diff" ? view.lines.map((l, i) => <span key={i} className="diff-line" data-type={l.type}>{l.text}{"\n"}</span>) : view.kind === "json" ? <Code code={view.text} language="json" /> : view.text}
          </pre>
        )}
        {evidence && (evidence.truncated || evidence.outputLost || evidence.captureComplete === false) && (
          <p className="evidence-note">
            {evidence.truncated ? "Only the first 200,000 characters are shown. " : ""}
            {evidence.captureComplete === false
              ? evidence.captureGap === "cap" ? "Recording stopped at the output size limit; some output was not saved."
                : evidence.captureGap === "write_failed" ? "Recording stopped because the output could not be saved; some output is missing."
                : evidence.captureGap === "interrupted" ? "Recording was interrupted; the end of the output may be missing."
                : "This recording is incomplete; some output may be missing."
              : evidence.outputLost ? "Some output was not kept, because the command printed more than Socrates retains." : ""}
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
