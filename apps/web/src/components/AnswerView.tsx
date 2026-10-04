import { motion } from "motion/react";
import type { Exchange } from "../lib/model";
import { store } from "../lib/store";
import type { PendingApproval } from "../lib/types";
import { Prose } from "./Prose";
import { Work } from "./Work";

/** Everything Socrates did for one question: its work, folded apart from the answer, its approvals, and the answer. */
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
      <Work exchange={exchange} />
      {approvals.map((a) => <ApprovalCard key={a.id} approval={a} />)}
      {exchange.question && <Prose text={exchange.question} animate={false} writing={false} />}
      {prose.map((p, i) => <Prose key={i} text={p.text} animate={live} writing={p.writing} />)}
      {exchange.state === "failed" && <p className="answer-note failed">{exchange.note ?? "This message could not be sent."}</p>}
      {exchange.state === "stopped" && <p className="answer-note">{exchange.note ?? "Stopped."}</p>}
    </div>
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
