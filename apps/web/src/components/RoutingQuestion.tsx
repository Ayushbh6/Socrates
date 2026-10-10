import { ArrowUp, Check, ChevronDown, Link2, LoaderCircle, MessageCircleQuestion, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "../lib/dialog";
import { type AppState, store } from "../lib/store";
import type { ClarificationView } from "../lib/types";
import { Popover } from "./Popover";
import { Prose } from "./Prose";

/** Questions are global requests, so changing mode or chat cannot hide their reply box. */
export function RoutingQuestions({ app, enabled = true }: {app: AppState; enabled?: boolean}) {
  const questions = app.model.live?.routingQuestions ?? [];
  const seen = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled) return;
    const fresh = questions.filter(q => q.state === "pending" && !seen.current.has(q.turnId));
    for (const q of fresh) seen.current.add(q.turnId);
    if (fresh.length && !app.questionDialog) void store.openQuestion(fresh[0]!);
  }, [questions, enabled, app.questionDialog]);
  const question = questions.find(q => q.turnId === app.questionDialog && q.state === "pending");
  return enabled && question ? <QuestionDialog key={question.turnId} app={app} question={question} /> : null;
}

export function RoutingQuestionIndicator({app}: {app: AppState}) {
  const questions = (app.model.live?.routingQuestions ?? []).filter(q => q.state === "pending");
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {if (questions.length < 2) setOpen(false);}, [questions.length]);
  if (!questions.length) return null;
  const visit = (q: ClarificationView) => {setOpen(false); void store.openQuestion(q);};
  const label = questions.length === 1 ? "Reply needed" : `${questions.length} replies needed`;
  return <div className="approval-indicator">
    <button ref={button} type="button" className="chip routing-notice" aria-label={label} {...(questions.length > 1 ? {"aria-expanded": open, "aria-haspopup": "menu" as const} : {})} onClick={() => questions.length === 1 ? visit(questions[0]!) : setOpen(!open)}>
      <MessageCircleQuestion aria-hidden /><span className="approval-notice-label">{label}</span><span className="approval-notice-count" aria-hidden>{questions.length}</span>
    </button>
    {open && <Popover align="right" className="approval-menu" onClose={() => {setOpen(false); button.current?.focus();}}>
      {questions.map((q,i) => <button key={q.turnId} type="button" role="menuitem" autoFocus={i === 0} onClick={() => visit(q)}><strong>{q.question}</strong><span>{q.message}</span><small>Reply to routing question</small></button>)}
    </Popover>}
  </div>;
}

/** A freeform question panel in Socrates' own cream and teal, inspired by the user's reference. */
function QuestionDialog({app, question}: {app: AppState; question: ClarificationView}) {
  const modal = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const reduced = useReducedMotion();
  const key = `question:${question.turnId}`;
  const text = app.drafts[key] ?? "";
  const sending = app.questionSending === question.turnId;
  const ready = app.connected && app.model.live?.ready && !sending;
  useDialog(modal, () => store.closeQuestion(), true, input);
  useEffect(() => {input.current?.focus();}, []);
  const send = () => {if (ready && text.trim()) store.replyTo(question, text);};
  return createPortal(<motion.div className="routing-scrim" initial={{opacity: 0}} animate={{opacity: 1}} transition={{duration: reduced ? 0 : 0.16}} onPointerDown={e => {if (e.target === e.currentTarget) store.closeQuestion();}}>
    <motion.div ref={modal} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="routing-question-title" aria-describedby="routing-question-link" className="routing-dialog" initial={{y: reduced ? 0 : 14, opacity: 0}} animate={{y: 0, opacity: 1}} transition={{duration: reduced ? 0 : 0.22, ease: [0.22,1,0.36,1]}}>
      <div className="routing-dialog-head"><span><MessageCircleQuestion aria-hidden />Routing question</span><button type="button" className="icon-button" aria-label="Close routing question" title="Reply later" onClick={() => store.closeQuestion()}><X aria-hidden /></button></div>
      <p id="routing-question-link" className="routing-original"><Link2 aria-hidden /><span>For your request: <strong>{question.message}</strong></span></p>
      <h2 id="routing-question-title">{question.question}</h2>
      {question.detail !== question.question && <details className="routing-context"><summary>Context <ChevronDown aria-hidden /></summary><Prose text={question.detail} animate={false} writing={false} /></details>}
      <form onSubmit={e => {e.preventDefault(); send();}}>
        <label className="sr-only" htmlFor="routing-reply">Your reply to the routing question</label>
        <textarea ref={input} id="routing-reply" rows={3} placeholder="Write your reply…" value={text} disabled={sending} maxLength={100000} onChange={e => store.setDraft(key, e.target.value)} onKeyDown={e => {if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {e.preventDefault(); send();}}} />
        {(app.questionError || question.error) && <p className="routing-error" role="alert">{app.questionError ?? question.error}</p>}
        <div className="routing-dialog-foot"><span><Link2 aria-hidden />Your reply stays with this request</span><div><button type="button" className="quiet-button" onClick={() => store.closeQuestion()}>Not now</button><button type="submit" className="solid-button" disabled={!ready || !text.trim()}>{sending ? <LoaderCircle aria-hidden className="spin" /> : <ArrowUp aria-hidden />}{sending ? "Sending…" : "Send reply"}</button></div></div>
      </form>
    </motion.div>
  </motion.div>, document.body);
}

/** The clarification stays inside the original Q&A and folds after the final answer. */
export function ClarificationDetails({question, finished}: {question: ClarificationView; finished: boolean}) {
  const [open, setOpen] = useState(!finished);
  useEffect(() => {if (finished) setOpen(false);}, [finished]);
  const pending = question.state === "pending";
  const cancelled = question.state === "cancelled";
  return <div className="routing-linked" data-pending={pending}>
    <button type="button" className="routing-linked-label" aria-expanded={open} onClick={() => setOpen(!open)}>
      {pending ? <MessageCircleQuestion aria-hidden /> : cancelled ? <X aria-hidden /> : <Check aria-hidden />}
      <span>{pending ? "Routing question · Reply needed" : cancelled ? "Routing question cancelled" : question.state === "resuming" ? "Routing with your reply" : "Routing clarified"}</span>
      {!pending && !cancelled && <small><Link2 aria-hidden />Linked</small>}<ChevronDown aria-hidden className="routing-chevron" />
    </button>
    {open && <div className="routing-linked-body"><p>{question.question}</p>{question.answer && <p className="routing-received"><span>Your clarification</span>{question.answer}</p>}
      {pending && <div className="routing-linked-actions"><button type="button" className="quiet-button" onClick={() => store.cancelQuestion(question)}>Cancel request</button><button type="button" className="solid-button" onClick={() => void store.openQuestion(question)}>Reply to question</button></div>}
      {question.error && <p className="routing-error">{question.error}</p>}
    </div>}
  </div>;
}
