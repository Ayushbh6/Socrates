import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { type Strand, strands } from "../lib/strands";
import { type AppState, store } from "../lib/store";

/**
 * The board (architecture/web.md, "Strands"): one row under the header with
 * every strand of work beside the main conversation, each with its state, its
 * task and its latest step. Choosing one brings its question onto the canvas.
 * The row is empty, and not drawn, while main works alone.
 */
export function Strands({ app, conversation, onOpen }: { app: AppState; conversation: string; onOpen: (conversation: string) => void }) {
  const now = useClock(10_000);
  const list = strands(app.model, now);
  if (!list.length) return null;
  return (
    <nav className="strands" aria-label="Work in progress">
      {list.map((s) => (
        <div key={s.conversation} className="strand" data-current={s.conversation === conversation} data-status={s.status}>
          <button type="button" className="strand-open" onClick={() => onOpen(s.conversation)} title={s.message}>
            <span className="lane-dot" data-running={s.running} data-waiting={s.waitingForApproval} />
            <span className="strand-body">
              <span className="strand-title">{s.title ?? (s.message.trim() || s.label)}</span>
              <small className="strand-step">{line(s, now)}</small>
            </span>
          </button>
          {s.closable && (
            <button type="button" className="icon-button strand-close" aria-label={`Close ${s.label}`} title="Close this lane" onClick={() => store.closeLane(s.conversation)}><X aria-hidden /></button>
          )}
        </div>
      ))}
    </nav>
  );
}

/** "Reading hero.css · 2m", "Waiting for your approval", "Done 3m ago", "Stopped". */
export function line(s: Strand, now: number): string {
  const age = elapsed(now - Date.parse(s.at));
  if (s.status === "waiting") return s.step ? `Waiting for your approval · ${s.step}` : "Waiting for your approval";
  if (s.status === "working") return `${s.step ?? "Working"}${age ? ` · ${age}` : ""}`;
  if (s.status === "done") return age ? `Done ${age} ago` : "Done";
  return age ? `Stopped ${age} ago` : "Stopped";
}

function elapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 5_000) return "";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.floor(ms / 1000)}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function useClock(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
