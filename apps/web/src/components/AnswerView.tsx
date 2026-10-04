import { AlertTriangle, Check, ChevronRight, CornerDownRight, LoaderCircle, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import type { Exchange, Step } from "../lib/model";
import { store } from "../lib/store";
import { EvidenceViewer } from "./EvidenceViewer";
import type { PendingApproval } from "../lib/types";
import { Prose } from "./Prose";

/** Everything Socrates did for one question: its steps, tool calls, approvals and answer. */
export function AnswerView({ exchange, approvals }: { exchange: Exchange; approvals: PendingApproval[] }) {
  const live = exchange.state === "working";
  const draft = live ? exchange.draft : null;
  // One list, so the draft and the saved answer that replaces it are the same element and the text carries on.
  const prose = [...exchange.answers.map((text) => ({ text, writing: false })), ...(draft?.kind === "answer" ? [{ text: draft.text, writing: true }] : [])];
  return (
    <div className="answer-body">
      {exchange.route && (
        <p className="answer-route">
          g{exchange.route.goal.number} · {exchange.route.goal.title} <span>/</span> t{exchange.route.task.number} · {exchange.route.task.title}
        </p>
      )}
      {(exchange.steps.length > 0 || draft?.kind === "narration") && (
        <ol className="steps">
          {exchange.steps.map((step, i) => <StepRow key={i} step={step} />)}
          {draft?.kind === "narration" && <StepRow key={exchange.steps.length} step={{ kind: "step", text: draft.text }} live />}
        </ol>
      )}
      {approvals.map((a) => <ApprovalCard key={a.id} approval={a} />)}
      {exchange.question && <Prose text={exchange.question} animate={false} writing={false} />}
      {prose.map((p, i) => <Prose key={i} text={p.text} animate={live} writing={p.writing} />)}
      {exchange.state === "failed" && <p className="answer-note failed">{exchange.note ?? "This message could not be sent."}</p>}
      {exchange.state === "stopped" && <p className="answer-note">{exchange.note ?? "Stopped."}</p>}
    </div>
  );
}

function StepRow({ step, live = false }: { step: Step; live?: boolean }) {
  switch (step.kind) {
    case "step":
      return <li className="step-text" data-live={live}>{step.text}</li>;
    case "tool":
      return <ToolRow step={step} />;
    case "handed_off":
      return <li className="step-meta"><CornerDownRight aria-hidden /> Handed to lane {step.lane}, which is working on this task.</li>;
    case "warning":
      return <li className="step-meta warn"><AlertTriangle aria-hidden /> {step.detail}</li>;
    case "decision":
      return <li className="step-meta">{step.granted ? <Check aria-hidden /> : <X aria-hidden />} {step.granted ? "Approved" : "Refused"}: {step.detail}</li>;
  }
}

function ToolRow({ step }: { step: Extract<Step, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const [viewing, setViewing] = useState(false);
  return (
    <li className="tool" data-status={step.status} data-open={open}>
      <button type="button" className="tool-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight aria-hidden className="tool-chevron" />
        <code>{step.line}</code>
        {step.status === "running" ? <LoaderCircle aria-label="Running" className="spin" /> : step.status === "ok" ? <Check aria-label="Done" /> : <X aria-label="Failed" />}
      </button>
      {open && (
        <div className="tool-output">
          {step.preview !== null && <pre>{step.preview}{step.truncated ? "\n…" : ""}</pre>}
          {step.status === "running" ? <p className="tool-running">Running…</p> : (
            <button type="button" className="quiet-button" onClick={() => setViewing(true)}>Open the full output</button>
          )}
        </div>
      )}
      {viewing && <EvidenceViewer task={step.task} handle={step.handle} onClose={() => setViewing(false)} />}
    </li>
  );
}

function ApprovalCard({ approval }: { approval: PendingApproval }) {
  return (
    <motion.div className="approval" role="alertdialog" aria-label="Approval needed" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
      <p className="approval-eyebrow">{approval.kind === "outside_folder" ? "Outside your folders" : "Approve?"}</p>
      <p className="approval-detail">{approval.detail}</p>
      {approval.preview && <pre className="approval-preview">{approval.preview}</pre>}
      <div className="approval-actions">
        <button type="button" className="quiet-button" onClick={() => store.approve(approval.id, false)}>Refuse</button>
        <button type="button" className="solid-button" onClick={() => store.approve(approval.id, true)} autoFocus>Approve</button>
      </div>
    </motion.div>
  );
}
