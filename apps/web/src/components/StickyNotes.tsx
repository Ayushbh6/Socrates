import { GripHorizontal } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import type { GoalView } from "../lib/types";

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
    <div className="notes" aria-label="Notes">
      <Note id="task" offset={offsets.task} onMove={move} eyebrow="Current task">
        {task ? (
          <>
            <strong className="note-title">t{task.number} · {task.title}</strong>
            <p className="note-body">{task.note ?? "No progress noted yet."}</p>
            <span className="note-meta">{task.status === "completed" ? "Completed" : "Open"}</span>
          </>
        ) : (
          <p className="note-body muted">Ask Socrates something and the task it works on appears here.</p>
        )}
      </Note>
      <Note id="goal" offset={offsets.goal} onMove={move} eyebrow="Current goal">
        {goal && !goal.general ? (
          <>
            <strong className="note-title">g{goal.number} · {goal.title}</strong>
            {goal.objective && <p className="note-body">{goal.objective}</p>}
            {goal.note && <p className="note-body muted">{goal.note}</p>}
            <span className="note-meta">{open} open · {done} done</span>
          </>
        ) : (
          <p className="note-body muted">{goal ? "A general conversation, not tied to a goal." : "No goal yet."}</p>
        )}
      </Note>
    </div>
  );
}

function Note({ id, offset, onMove, eyebrow, children }: { id: NoteId; offset: { x: number; y: number }; onMove: (id: NoteId, x: number, y: number) => void; eyebrow: string; children: ReactNode }) {
  const drag = useRef<{ pointer: number; x: number; y: number; from: { x: number; y: number } } | null>(null);
  const down = (e: PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("a, button:not(.note-grip)")) return;
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
      <span className="note-eyebrow">{eyebrow}</span>
      {children}
    </article>
  );
}
