import { ArrowUpRight, ChevronRight, GripHorizontal, Pencil, Pin, PinOff, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "../lib/dialog";
import { store } from "../lib/store";
import type { GoalView, KeepChoice } from "../lib/types";
import { Prose } from "./Prose";
import { StatusMenu, closedText } from "./StatusMenu";

type NoteId = "task" | "goal";
type Offsets = Record<NoteId, { x: number; y: number }>;

const STORAGE_KEY = "socrates.notes";
const START: Offsets = { task: { x: 0, y: 0 }, goal: { x: 0, y: 0 } };

function stored(): Offsets {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Offsets> | null;
    const valid = (o: unknown): o is { x: number; y: number } => !!o && Number.isFinite((o as { x: number }).x) && Number.isFinite((o as { y: number }).y);
    return { task: valid(parsed?.task) ? parsed.task : START.task, goal: valid(parsed?.goal) ? parsed.goal : START.goal };
  } catch {
    return START;
  }
}

/**
 * The two notes beside the conversation: the current task and its goal. Drag
 * them anywhere. Expanded, they set a status and keep the next message in the
 * task (`keep`, used by the composer).
 */
export function StickyNotes({ goal, taskNumber, keep, onKeep }: { goal: GoalView | null; taskNumber: number | null; keep: KeepChoice | null; onKeep: (keep: KeepChoice | null) => void }) {
  const [offsets, setOffsets] = useState(stored);
  const [expanded, setExpanded] = useState<NoteId | null>(null);
  const move = (id: NoteId, x: number, y: number) =>
    setOffsets((current) => {
      const next = { ...current, [id]: { x, y } };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  const task = goal?.tasks.find((t) => t.number === taskNumber) ?? null;
  const open = goal ? goal.tasks.filter((t) => t.status === "open").length : 0;
  const done = goal ? goal.tasks.filter((t) => t.status === "completed").length : 0;

  return (
    <>
    <div className="notes" aria-label="Notes">
      <Note id="task" offset={offsets.task} onMove={move} onOpen={() => setExpanded("task")} eyebrow="Current task">
        {task ? (
          <>
            <strong className="note-title">{task.title}</strong>
            <span className="note-body">{task.note ?? "No progress noted yet."}</span>
            <span className="note-meta"><Status value={task.status} />{keep && goal && keep.goal === goal.number && keep.task === task.number && <span className="note-kept"><Pin aria-hidden />Next message stays here</span>}</span>
          </>
        ) : (
          <span className="note-body muted">Ask Socrates something and the task it works on appears here.</span>
        )}
      </Note>
      <Note id="goal" offset={offsets.goal} onMove={move} onOpen={() => setExpanded("goal")} eyebrow="Current goal">
        {goal && !goal.general ? (
          <>
            <strong className="note-title">{goal.title}</strong>
            {goal.objective && <span className="note-body">{goal.objective}</span>}
            {goal.note && <span className="note-body muted">{goal.note}</span>}
            <span className="note-meta">{open} open · {done} done</span>
          </>
        ) : (
          <span className="note-body muted">{goal ? "A general conversation, not tied to a goal." : "No goal yet."}</span>
        )}
      </Note>
    </div>
    {expanded && <ExpandedNote kind={expanded} goal={goal} taskNumber={taskNumber} keep={keep} onKeep={onKeep} onClose={() => setExpanded(null)} />}
    </>
  );
}

function Note({ id, offset, onMove, onOpen, eyebrow, children }: { id: NoteId; offset: { x: number; y: number }; onMove: (id: NoteId, x: number, y: number) => void; onOpen: () => void; eyebrow: string; children: ReactNode }) {
  const grip = useRef<HTMLButtonElement>(null);
  // Measure the transformed grip, so rotation and previously saved positions
  // cannot leave the only drag target outside the viewport.
  const constrain = (x: number, y: number) => {
    const element = grip.current;
    if (!element || !element.getClientRects().length) return;
    const rect = element.getBoundingClientRect();
    const left = rect.left + x - offset.x;
    const top = rect.top + y - offset.y;
    const nextX = x + Math.max(8, Math.min(left, window.innerWidth - rect.width - 8)) - left;
    const nextY = y + Math.max(8, Math.min(top, window.innerHeight - rect.height - 8)) - top;
    if (Math.abs(nextX - offset.x) > 0.01 || Math.abs(nextY - offset.y) > 0.01) onMove(id, nextX, nextY);
  };
  useLayoutEffect(() => {
    const recover = () => constrain(offset.x, offset.y);
    recover();
    window.addEventListener("resize", recover);
    return () => window.removeEventListener("resize", recover);
  });
  const drag = useRef<{ pointer: number; x: number; y: number; from: { x: number; y: number } } | null>(null);
  const down = (e: PointerEvent<HTMLElement>) => {
    if (!(e.target as HTMLElement).closest(".note-grip")) return;
    drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: offset };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moved = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    constrain(d.from.x + e.clientX - d.x, d.from.y + e.clientY - d.y);
  };
  const up = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };
  const nudge = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 40 : 12;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!delta) return;
    e.preventDefault();
    constrain(offset.x + delta[0]!, offset.y + delta[1]!);
  };
  return (
    <article
      className="note"
      data-note={id}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px) rotate(${id === "task" ? -1.2 : 1.1}deg)` }}
      onPointerDown={down}
      onPointerMove={moved}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <button ref={grip} type="button" className="note-grip" aria-label={`Move the ${eyebrow.toLowerCase()} note (arrow keys)`} onKeyDown={nudge}>
        <GripHorizontal aria-hidden />
      </button>
      <button type="button" className="note-open" aria-label={`Expand ${eyebrow.toLowerCase()} note`} aria-haspopup="dialog" onClick={onOpen}>
        <span className="note-eyebrow">{eyebrow}<ArrowUpRight aria-hidden /></span>
        {children}
        <span className="note-hint">View full note <ArrowUpRight aria-hidden /></span>
      </button>
    </article>
  );
}

function Status({ value }: { value: string }) {
  return <span className="note-status" data-status={value}><i aria-hidden />{value === "completed" ? "Completed" : value === "superseded" ? "Superseded" : "Open"}</span>;
}

type Task = GoalView["tasks"][number];

/** "Keep my next message in this task": the next message goes here without routing, reopening the task if it was closed. */
function KeepButton({ kept, onKeep }: { kept: boolean; onKeep: (on: boolean) => void }) {
  return kept
    ? <button type="button" className="quiet-button keep-button" data-on="true" onClick={() => onKeep(false)} title="The next message will be routed as usual"><PinOff aria-hidden /> Next message stays here</button>
    : <button type="button" className="quiet-button keep-button" onClick={() => onKeep(true)} title="Send the next message to this task, without routing; a closed task is reopened"><Pin aria-hidden /> Keep my next message in this task</button>;
}

function NoteText({ label, text, fallback }: { label: string; text: string | null | undefined; fallback?: string }) {
  if (!text && !fallback) return null;
  return <section className="note-section"><h3>{label}</h3>{text ? <Prose text={text} animate={false} writing={false} /> : <p className="muted">{fallback}</p>}</section>;
}

function TaskText({ task }: { task: Task }) {
  return <>
    <NoteText label="Objective" text={task.objective} />
    <NoteText label="Done when" text={task.completionCriteria} />
    <NoteText label="Progress & continuation" text={task.note} fallback="No progress noted yet. This fills in as Socrates works." />
  </>;
}

function ExpandedNote({ kind, goal, taskNumber, keep, onKeep, onClose }: { kind: NoteId; goal: GoalView | null; taskNumber: number | null; keep: KeepChoice | null; onKeep: (keep: KeepChoice | null) => void; onClose: () => void }) {
  const modal = useRef<HTMLDivElement>(null);
  useDialog(modal, onClose);
  const task = goal?.tasks.find((t) => t.number === taskNumber) ?? null;
  const title = kind === "task" ? task?.title ?? "No task yet" : goal?.title ?? "No goal yet";
  const canRename = !!goal && !goal.general && (kind === "goal" || !!task);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    const next = draft?.trim();
    if (!goal || next === undefined || !next || next === title) return setDraft(null);
    try {
      await (kind === "task" && task ? store.renameChat(goal.number, task.number, next) : store.renameGoal(goal.number, next));
      setDraft(null);
      setProblem(null);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    }
  };
  return createPortal(
    <div className="modal-scrim note-scrim" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={modal} tabIndex={-1} className="modal expanded-note" data-note={kind} role="dialog" aria-modal="true" aria-labelledby="expanded-note-title">
        <header className="expanded-note-head">
          <span className="note-eyebrow">{kind === "task" ? "Current task" : "Current goal"}</span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close expanded note"><X aria-hidden /></button>
        </header>
        <div className="expanded-note-body">
          <div className="note-title-row">
            {draft === null ? <>
              <h2 id="expanded-note-title">{title}</h2>
              {canRename && <button type="button" className="icon-button" onClick={() => setDraft(title)} aria-label={`Rename this ${kind}`} title="Rename"><Pencil aria-hidden /></button>}
            </> : <input className="note-title-input" autoFocus aria-label={`New name of this ${kind}`} maxLength={120} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void save(); } if (e.key === "Escape") { e.stopPropagation(); setDraft(null); } }} />}
          </div>
          {problem && <p className="note-title-error" role="alert">{problem}</p>}
          {goal && <div className="expanded-note-meta">
            {goal.general ? <Status value="open" /> : kind === "task" && task
              ? <StatusMenu what="task" value={task.status} onChange={(status) => void store.setStatus({ goal: goal.number, task: task.number }, status)} />
              : kind === "goal" ? <StatusMenu what="goal" value={goal.status} onChange={(status) => void store.setStatus({ goal: goal.number }, status)} /> : null}
            {goal.workspace && <span>{goal.workspace}</span>}
            {kind === "task" && task && !goal.general && <KeepButton kept={!!keep && keep.goal === goal.number && keep.task === task.number} onKeep={(on) => { onKeep(on ? { goal: goal.number, task: task.number } : null); if (on) onClose(); }} />}
          </div>}
          {kind === "task" && task && closedText(task.status, task.closed) && <p className="note-closed">{closedText(task.status, task.closed)}</p>}
          {kind === "task" ? task ? <TaskText task={task} /> : <p className="muted">Send a message to give Socrates a task. Its full notes will appear here.</p> : goal ? <>
            <NoteText label="Objective" text={goal.objective} fallback={goal.general ? "A general conversation, not tied to a project goal." : "No objective recorded yet."} />
            <NoteText label="Goal note" text={goal.note} fallback="No goal note recorded yet." />
            <section className="note-section"><h3>Tasks <span>{goal.tasks.filter((t) => t.status === "open").length} open · {goal.tasks.filter((t) => t.status === "completed").length} done</span></h3>
              <div className="expanded-note-tasks">{goal.tasks.map((t) => <details key={t.number} open={t.number === taskNumber}>
                <summary><ChevronRight aria-hidden /><span>{t.number === taskNumber && <small>Current</small>}{t.title}</span>{goal.general ? <Status value={t.status} /> : <StatusMenu what="task" align="right" value={t.status} onChange={(status) => void store.setStatus({ goal: goal.number, task: t.number }, status)} />}</summary>
                <div className="expanded-task-body">{closedText(t.status, t.closed) && <p className="note-closed">{closedText(t.status, t.closed)}</p>}<TaskText task={t} /></div>
              </details>)}</div>
            </section>
          </> : <p className="muted">Socrates will choose a goal when you send your first message.</p>}
        </div>
        <footer className="expanded-note-foot">The latest notes from Socrates. They update as the work progresses.</footer>
      </div>
    </div>, document.body,
  );
}
