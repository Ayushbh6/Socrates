import { Menu, X } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { orbDocked, orbState } from "../lib/model";
import { type AppState, store } from "../lib/store";
import { AccessMenu } from "./AccessMenu";
import { AnswerView } from "./AnswerView";
import { Composer } from "./Composer";
import { Orb } from "./Orb";
import { QuestionCard } from "./QuestionCard";
import { Sidebar } from "./Sidebar";
import { StickyNotes } from "./StickyNotes";

/**
 * Flow mode (architecture/web.md, "Flow mode"): one question and its answer on
 * an open canvas, the orb in the middle until the answer starts, the task and
 * goal notes beside it, and earlier questions in the sidebar.
 */
export function Flow({ app }: { app: AppState }) {
  const [conversation, setConversation] = useState("main");
  const [selected, setSelected] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);

  const lanes = app.model.live?.lanes ?? app.status?.lanes ?? [];
  const lane = lanes.find((l) => l.id === conversation) ?? null;
  // A lane that closed takes the canvas back to main.
  useEffect(() => {
    if (conversation !== "main" && app.model.live && !lane) setConversation("main");
  }, [conversation, lane, app.model.live]);
  // A message sent to a new lane brings its lane onto the canvas once the server names it.
  useEffect(() => {
    if (!following) return;
    const found = Object.entries(app.model.conversations).find(([, list]) => list.some((e) => e.sendId === following));
    if (found) {
      setConversation(found[0]);
      setSelected(null);
      setFollowing(null);
    }
  }, [following, app.model.conversations]);

  const list = app.model.conversations[conversation] ?? [];
  const pendingLane = following ? app.model.pending.find((e) => e.sendId === following) ?? null : null;
  const exchange = pendingLane ?? (selected ? list.find((e) => e.key === selected) : null) ?? list.at(-1) ?? null;
  // Approvals belong to the work happening now: the newest question of this conversation.
  const latest = exchange !== null && (exchange === list.at(-1) || exchange === pendingLane);
  const approvals = latest ? (app.model.live?.approvals ?? []).filter((a) => a.conversation === conversation) : [];
  const state = orbState(exchange, approvals);
  const docked = orbDocked(state);

  // The notes follow the question on the canvas, or the newest routed one.
  const route = exchange?.route ?? [...list].reverse().find((e) => e.route)?.route ?? null;
  const goal = useMemo(() => (route ? app.goals.find((g) => g.number === route.goal.number) ?? null : null), [route, app.goals]);

  // Keep the newest work in view while it grows.
  const size = `${exchange?.key}:${exchange?.steps.length}:${exchange?.answers.length}:${approvals.length}`;
  useEffect(() => {
    const el = stage.current;
    if (!el || selected) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [size, selected]);
  // Braces matter: scrollTo returns a promise in newer browsers, and an effect may only return its cleanup.
  useEffect(() => {
    stage.current?.scrollTo({ top: 0 });
  }, [exchange?.key]);

  // Notices fade after a while.
  const notices = app.model.notices.map((n) => n.id).join(",");
  useEffect(() => {
    if (!notices) return;
    const timers = app.model.notices.map((n) => setTimeout(() => store.dismiss(n.id), 8_000));
    return () => timers.forEach(clearTimeout);
  }, [notices]);

  // A slight parallax: the planet and the dots drift against the pointer.
  const parallax = (e: PointerEvent<HTMLDivElement>) => {
    const el = root.current;
    if (!el || e.pointerType !== "mouse") return;
    el.style.setProperty("--mx", ((e.clientX / window.innerWidth) * 2 - 1).toFixed(3));
    el.style.setProperty("--my", ((e.clientY / window.innerHeight) * 2 - 1).toFixed(3));
  };

  return (
    <div className="flow" ref={root} onPointerMove={parallax}>
      <div className="flow-dots" aria-hidden />
      <LayoutGroup>
        <div className="planet-layer" aria-hidden={docked}>
          {!docked && <Orb state={state} docked={false} />}
        </div>

        <header className="flow-header">
          <button type="button" className="icon-button menu-button" onClick={() => setSidebar(true)} aria-label="Open the conversation list">
            <Menu aria-hidden />
          </button>
          <AccessMenu app={app} />
          {conversation !== "main" && (
            <button type="button" className="chip lane-chip" onClick={() => { setConversation("main"); setSelected(null); }}>
              Lane {lane?.number} <X aria-hidden />
            </button>
          )}
          {!app.connected ? <span className="chip reconnecting">Reconnecting…</span> : app.model.live && !app.model.live.ready && <span className="chip reconnecting">Socrates is restarting…</span>}
        </header>

        <StickyNotes goal={goal} taskNumber={route?.task.number ?? null} />

        <main className="flow-stage" ref={stage}>
          <div className="flow-column">
            {exchange && selected && (
              <p className="history-notice">
                An earlier question <button type="button" onClick={() => setSelected(null)}>Return to the latest</button>
              </p>
            )}
            {exchange && (
              <>
                <QuestionCard text={exchange.message} note={exchange.state === "working" || exchange.state === "sending" ? exchange.note : null} />
                <section className="answer" aria-live="polite">
                  <div className="answer-dock">{docked && <Orb state={state} docked />}</div>
                  <AnswerView exchange={exchange} approvals={approvals} />
                </section>
              </>
            )}
          </div>
        </main>
      </LayoutGroup>

      <Composer
        app={app}
        conversation={conversation}
        laneNumber={lane?.number ?? null}
        onNewLane={(text) => {
          const id = store.sendToNewLane(text);
          if (id) setFollowing(id);
        }}
      />

      <Sidebar
        app={app}
        open={sidebar}
        conversation={conversation}
        selected={selected}
        onClose={() => setSidebar(false)}
        onConversation={(c) => {
          setConversation(c);
          setSelected(null);
          setSidebar(false);
        }}
        onSelect={(key) => {
          setSelected(key);
          setSidebar(false);
        }}
      />

      <div className="toasts" aria-live="polite">
        <AnimatePresence>
          {app.model.notices.map((n) => (
            <motion.div key={n.id} className="toast" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}>
              <span>{n.text}</span>
              <button type="button" className="icon-button" onClick={() => store.dismiss(n.id)} aria-label="Dismiss"><X aria-hidden /></button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
