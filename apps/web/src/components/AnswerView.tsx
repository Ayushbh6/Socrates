import { ChevronRight } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import type { Exchange } from "../lib/model";
import { store, useApp } from "../lib/store";
import type { GoalView, PendingApproval, Place } from "../lib/types";
import { Prose } from "./Prose";
import { RedoMenu } from "./RedoMenu";
import { Work } from "./Work";

/**
 * Everything Socrates did for one question: its work, folded apart from the
 * answer, its approvals, and the answer. `redo` offers "Redo in…" (null: why
 * not now); an answer set aside by a redo folds to one line that opens it.
 */
export function AnswerView({ exchange, approvals, redo }: { exchange: Exchange; approvals: PendingApproval[]; redo?: { blocked: string | null; onRedone?: (id: string) => void } }) {
  const [unfolded, setUnfolded] = useState(false);
  const goals = useApp().goals;
  return (
    <div className="answer-body">
      {(exchange.route || redo) && (
        <p className="answer-route">
          {exchange.route && <span className="route-name">{exchange.route.goal.title}<span className="route-sep">/</span>{exchange.route.task.title}</span>}
          {exchange.redoneFrom && <span className="route-from">Redone from <PlaceName place={exchange.redoneFrom} goals={goals} /></span>}
          {redo && <RedoMenu exchange={exchange} blocked={redo.blocked} {...(redo.onRedone ? { onRedone: redo.onRedone } : {})} />}
        </p>
      )}
      {exchange.redoneTo && (
        <button type="button" className="redone-line" aria-expanded={unfolded} onClick={() => setUnfolded(!unfolded)}>
          Redone in <PlaceName place={exchange.redoneTo} goals={goals} />
          <ChevronRight aria-hidden />
        </button>
      )}
      {(!exchange.redoneTo || unfolded) && <Answer exchange={exchange} approvals={approvals} />}
    </div>
  );
}

/** A chat's goal and task by their names now: a new chat is renamed after its first answer. */
function PlaceName({ place, goals }: { place: Place; goals: GoalView[] }) {
  const goal = goals.find((g) => g.number === place.goal.number);
  const task = goal?.tasks.find((t) => t.number === place.task.number);
  return <>{goal?.title ?? place.goal.title}<span className="route-sep">/</span>{task?.title ?? place.task.title}</>;
}

/** The work, approvals and answer of one question. */
function Answer({ exchange, approvals }: { exchange: Exchange; approvals: PendingApproval[] }) {
  const live = exchange.state === "working";
  const draft = live ? exchange.draft : null;
  // One list, so the draft and the saved answer that replaces it are the same element and the text carries on.
  const prose = [...exchange.answers.map((text) => ({ text, writing: false })), ...(draft?.kind === "answer" ? [{ text: draft.text, writing: true }] : [])];
  return (
    <div className="answer-main" data-set-aside={!!exchange.redoneTo}>
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
