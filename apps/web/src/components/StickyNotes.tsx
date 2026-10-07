import { ArrowUpRight, ChevronRight, GripHorizontal, Pencil, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialog } from "../lib/dialog";
import { store } from "../lib/store";
import type { GoalView } from "../lib/types";
import { Prose } from "./Prose";

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

/** The two notes beside the conversation: the current task and its goal. Drag them anywhere. */
export function StickyNotes({ goal, taskNumber }: { goal: GoalView | null; taskNumber: number | null }) {
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
            <span className="note-meta"><Status value={task.status} /></span>
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
    {expanded && <ExpandedNote kind={expanded} goal={goal} taskNumber={taskNumber} onClose={() => setExpanded(null)} />}
    </>
  );
}

function Note({ id, offset, onMove, onOpen, eyebrow, children }: { id: NoteId; offset: { x: number; y: number }; onMove: (id: NoteId, x: number, y: number) => void; onOpen: () => void; eyebrow: string; children: ReactNode }) {
  const drag = useRef<{ pointer: number; x: number; y: number; from: { x: number; y: number } } | null>(null);
  const down = (e: PointerEvent<HTMLElement>) => {
    if (!(e.target as HTMLElement).closest(".note-grip")) return;
    drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, from: offset };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moved = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    onMove(id, d.from.x + e.clientX - d.x, d.from.y + e.clientY - d.y);
  };
  const up = (e: PointerEvent<HTMLElement>) => {
    if (drag.current?.pointer === e.pointerId) drag.current = null;
  };
  const nudge = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 40 : 12;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!delta) return;
    e.preventDefault();
    onMove(id, offset.x + delta[0]!, offset.y + delta[1]!);
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
      <button type="button" className="note-grip" aria-label={`Move the ${eyebrow.toLowerCase()} note (arrow keys)`} onKeyDown={nudge}>
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

function ExpandedNote({ kind, goal, taskNumber, onClose }: { kind: NoteId; goal: GoalView | null; taskNumber: number | null; onClose: () => void }) {
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
          {goal && <p className="expanded-note-meta"><Status value={kind === "task" && task ? task.status : goal.status} />{goal.workspace && <span>{goal.workspace}</span>}</p>}
          {kind === "task" ? task ? <TaskText task={task} /> : <p className="muted">Send a message to give Socrates a task. Its full notes will appear here.</p> : goal ? <>
            <NoteText label="Objective" text={goal.objective} fallback={goal.general ? "A general conversation, not tied to a project goal." : "No objective recorded yet."} />
            <NoteText label="Goal note" text={goal.note} fallback="No goal note recorded yet." />
            <section className="note-section"><h3>Tasks <span>{goal.tasks.filter((t) => t.status === "open").length} open · {goal.tasks.filter((t) => t.status === "completed").length} done</span></h3>
              <div className="expanded-note-tasks">{goal.tasks.map((t) => <details key={t.number} open={t.number === taskNumber}>
                <summary><ChevronRight aria-hidden /><span>{t.number === taskNumber && <small>Current</small>}{t.title}</span><Status value={t.status} /></summary>
                <div className="expanded-task-body"><TaskText task={t} /></div>
              </details>)}</div>
            </section>
          </> : <p className="muted">Socrates will choose a goal when you send your first message.</p>}
        </div>
        <footer className="expanded-note-foot">The latest notes from Socrates. They update as the work progresses.</footer>
      </div>
    </div>, document.body,
  );
}
