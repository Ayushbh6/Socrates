import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import { type Exchange, asked } from "../lib/model";
import { type AppState, store } from "../lib/store";

function day(at: string): string {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "long" });
}

/** Earlier questions of the conversation on the canvas, newest first, and the lanes beside main. */
export function Sidebar({ app, open, conversation, selected, onClose, onConversation, onSelect }: {
  app: AppState;
  open: boolean;
  conversation: string;
  selected: string | null;
  onClose: () => void;
  onConversation: (conversation: string) => void;
  onSelect: (key: string | null) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const escape = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);

  const lanes = app.model.live?.lanes ?? app.status?.lanes ?? [];
  const exchanges = [...(app.model.conversations[conversation] ?? [])].reverse();
  const latest = exchanges[0]?.key ?? null;
  const groups: { day: string; items: Exchange[] }[] = [];
  for (const e of exchanges) {
    const d = day(e.at);
    if (groups.at(-1)?.day !== d) groups.push({ day: d, items: [] });
    groups.at(-1)!.items.push(e);
  }
  const laneTask = (id: string) => [...(app.model.conversations[id] ?? [])].reverse().find((e) => e.route)?.route?.task.title ?? null;

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="sidebar-scrim" onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} />
          <motion.nav className="sidebar" aria-label="Conversation" initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -24, opacity: 0 }} transition={{ duration: 0.22, ease: "easeOut" }}>
            <div className="sidebar-head">
              <strong>Socrates</strong>
              <button type="button" className="icon-button" onClick={onClose} aria-label="Close"><X aria-hidden /></button>
            </div>
            {lanes.length > 0 && (
              <section className="sidebar-section">
                <p className="sidebar-label">Conversations</p>
                <button type="button" className="sidebar-item" data-current={conversation === "main"} onClick={() => onConversation("main")}>
                  <span className="lane-dot" data-running={app.model.live?.busy ?? false} /> Main
                </button>
                {lanes.map((lane) => (
                  <div key={lane.id} className="sidebar-lane">
                    <button type="button" className="sidebar-item" data-current={conversation === lane.id} onClick={() => onConversation(lane.id)}>
                      <span className="lane-dot" data-running={lane.running} data-waiting={lane.waitingForApproval} />
                      Lane {lane.number}
                      <small>{lane.waitingForApproval ? "waiting for you" : lane.running ? "working" : laneTask(lane.id) ?? "idle"}</small>
                    </button>
                    {!lane.running && (
                      <button type="button" className="icon-button" aria-label={`Close lane ${lane.number}`} title="Close this lane" onClick={() => store.closeLane(lane.id)}><X aria-hidden /></button>
                    )}
                  </div>
                ))}
              </section>
            )}
            <section className="sidebar-section sidebar-questions">
              <p className="sidebar-label">Questions</p>
              {!exchanges.length && <p className="sidebar-empty">Nothing asked here yet.</p>}
              {groups.map((g) => (
                <div key={g.day}>
                  <p className="sidebar-day">{g.day}</p>
                  {g.items.map((e) => (
                    <button
                      key={e.key}
                      type="button"
                      className="sidebar-item question-item"
                      data-current={(selected ?? latest) === e.key}
                      onClick={() => onSelect(e.key === latest ? null : e.key)}
                    >
                      <span className="question-item-text">{e.message.trim() || imagesOnly(e.attachments.length)}</span>
                      <span className="question-item-foot">
                        <small>{e.route ? `g${e.route.goal.number}/t${e.route.task.number}` : e.question ? "question" : ""}{e.state === "working" || e.state === "sending" ? " · working" : e.state === "stopped" ? " · stopped" : ""}</small>
                        <time dateTime={e.at}>{asked(e.at)}</time>
                      </span>
                    </button>
                  ))}
                </div>
              ))}
              {app.older[conversation] ? (
                <button type="button" className="quiet-button" onClick={() => void store.loadOlder(conversation)}>Load earlier</button>
              ) : null}
            </section>
          </motion.nav>
        </>
      )}
    </AnimatePresence>
  );
}

/** How a message that is only images is listed. */
function imagesOnly(count: number): string {
  return count === 1 ? "An image" : `${count} images`;
}
