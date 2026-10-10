import { BookmarkCheck, BookmarkX, ChevronRight, RotateCw } from "lucide-react";
import { motion } from "motion/react";
import { useState } from "react";
import type { Exchange, Limit, MemoryNote } from "../lib/model";
import { store, useApp } from "../lib/store";
import type { GoalView, PendingApproval, Place } from "../lib/types";
import { Prose } from "./Prose";
import { RedoMenu } from "./RedoMenu";
import { ClarificationDetails } from "./RoutingQuestion";
import { Work } from "./Work";

/**
 * Everything Socrates did for one question: its work, folded apart from the
 * answer, its approvals, and the answer. `redo` offers "Redo in…" (null: why
 * not now); an answer set aside by a redo folds to one line that opens it.
 * `onContinue` is given for the newest answer of its conversation: when a
 * safeguard ended its work, it offers to carry on.
 */
export function AnswerView({ exchange, approvals, redo, onContinue }: { exchange: Exchange; approvals: PendingApproval[]; redo?: { blocked: string | null; onRedone?: (id: string) => void }; onContinue?: () => void }) {
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
      {onContinue && exchange.limit && exchange.state === "done" && !exchange.redoneTo && <ContinueOffer limit={exchange.limit} onContinue={onContinue} />}
    </div>
  );
}

const LIMIT_NOTE: Record<Limit, string> = {
  steps: "Socrates stopped at its step limit for one turn.",
  time: "Socrates stopped at its time limit for one turn.",
  tokens: "Socrates stopped at its token limit for one turn.",
};

/** After a safeguard stop: the work so far is saved, and one click carries on from it. */
function ContinueOffer({ limit, onContinue }: { limit: Limit; onContinue: () => void }) {
  return (
    <p className="answer-continue">
      <span>{LIMIT_NOTE[limit]}</span>
      <button type="button" className="quiet-button" onClick={onContinue}><RotateCw aria-hidden /> Continue</button>
    </p>
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
      {exchange.clarification && <ClarificationDetails question={exchange.clarification} finished={exchange.state === "done"} />}
      <Work exchange={exchange} />
      {approvals.map((a) => <ApprovalCard key={a.id} approval={a} />)}
      {exchange.question && !exchange.clarification && <Prose text={exchange.question} animate={false} writing={false} />}
      {prose.map((p, i) => <Prose key={i} text={p.text} animate={live} writing={p.writing} />)}
      <MemoryNotes notes={exchange.memories} />
      {exchange.state === "failed" && <p className="answer-note failed">{exchange.note ?? "This message could not be sent."}</p>}
      {exchange.state === "stopped" && <p className="answer-note">{exchange.note ?? "Stopped."}</p>}
    </div>
  );
}

/**
 * What the answer saved to or forgot from memory (architecture/web.md,
 * "Memory"): "Remembered: …" with Undo, saved without asking so the
 * conversation flows; "Forgot: …" when the user asked to forget.
 */
function MemoryNotes({ notes }: { notes: MemoryNote[] }) {
  if (!notes.length) return null;
  return (
    <ul className="memory-notes" aria-label="Memory">
      {notes.map((n) => (
        <li key={n.number} data-undone={n.saved && n.forgotten}>
          {n.saved && !n.forgotten ? <BookmarkCheck aria-hidden /> : <BookmarkX aria-hidden />}
          <span className="memory-note-verb">{!n.saved ? "Forgot" : n.forgotten ? "Undone" : "Remembered"}</span>
          <span className="memory-note-text">{n.text}</span>
          {n.saved && !n.forgotten && <button type="button" className="memory-undo" onClick={() => void store.forgetMemory(n.number)}>Undo</button>}
        </li>
      ))}
    </ul>
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
