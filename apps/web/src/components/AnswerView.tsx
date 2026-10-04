import { AlertTriangle, Check, ChevronRight, CornerDownRight, LoaderCircle, X } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../lib/api";
import type { Exchange, Step } from "../lib/model";
import { store } from "../lib/store";
import type { PendingApproval } from "../lib/types";

/** Everything Socrates did for one question: its steps, tool calls, approvals and answer. */
export function AnswerView({ exchange, approvals }: { exchange: Exchange; approvals: PendingApproval[] }) {
  return (
    <div className="answer-body">
      {exchange.route && (
        <p className="answer-route">
          g{exchange.route.goal.number} · {exchange.route.goal.title} <span>/</span> t{exchange.route.task.number} · {exchange.route.task.title}
        </p>
      )}
      {exchange.steps.length > 0 && (
        <ol className="steps">
          {exchange.steps.map((step, i) => <StepRow key={i} step={step} />)}
        </ol>
      )}
      {approvals.map((a) => <ApprovalCard key={a.id} approval={a} />)}
      {exchange.question && <Prose text={exchange.question} />}
      {exchange.answers.map((text, i) => <Prose key={i} text={text} />)}
      {exchange.state === "failed" && <p className="answer-note failed">{exchange.note ?? "This message could not be sent."}</p>}
      {exchange.state === "stopped" && <p className="answer-note">{exchange.note ?? "Stopped."}</p>}
    </div>
  );
}

function Prose({ text }: { text: string }) {
  return (
    <motion.div className="prose" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: "easeOut" }}>
      <Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>{text}</Markdown>
    </motion.div>
  );
}

function StepRow({ step }: { step: Step }) {
  switch (step.kind) {
    case "step":
      return <li className="step-text">{step.text}</li>;
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
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const showFull = async () => {
    setLoading(true);
    try {
      setFull((await api.evidence(step.task, step.handle)).content ?? "");
    } catch (e) {
      setFull(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  return (
    <li className="tool" data-status={step.status} data-open={open}>
      <button type="button" className="tool-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <ChevronRight aria-hidden className="tool-chevron" />
        <code>{step.line}</code>
        {step.status === "running" ? <LoaderCircle aria-label="Running" className="spin" /> : step.status === "ok" ? <Check aria-label="Done" /> : <X aria-label="Failed" />}
      </button>
      {open && (
        <div className="tool-output">
          <pre>{full ?? step.preview ?? (step.status === "running" ? "Running…" : "")}</pre>
          {full === null && (step.truncated || step.preview === null) && step.status !== "running" && (
            <button type="button" className="quiet-button" onClick={showFull} disabled={loading}>{loading ? "Loading…" : "Show the full output"}</button>
          )}
        </div>
      )}
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
