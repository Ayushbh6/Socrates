import { Menu, X } from "lucide-react";
import { LayoutGroup } from "motion/react";
import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { currentRoute, orbDocked, orbState } from "../lib/model";
import { useFollow } from "../lib/follow";
import { type AppState, store } from "../lib/store";
import { AccessMenu } from "./AccessMenu";
import { AnswerView } from "./AnswerView";
import { Composer } from "./Composer";
import { type Mode, ModeSwitch } from "./ModeSwitch";
import { Notices } from "./Notices";
import { Orb } from "./Orb";
import { QuestionCard } from "./QuestionCard";
import { Sidebar } from "./Sidebar";
import { StickyNotes } from "./StickyNotes";

/**
 * Flow mode (architecture/web.md, "Flow mode"): one question and its answer on
 * an open canvas, the orb in the middle until the answer starts, the task and
 * goal notes beside it, and earlier questions in the sidebar.
 */
export function Flow({ app, mode, onMode, onSettings }: { app: AppState; mode: Mode; onMode: (mode: Mode) => void; onSettings: () => void }) {
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
  const route = exchange?.route ?? currentRoute(list);
  const goal = useMemo(() => (route ? app.goals.find((g) => g.number === route.goal.number) ?? null : null), [route, app.goals]);

  // The newest work stays in view while it grows, unless the reader scrolls up or looks at an earlier question.
  const column = useRef<HTMLDivElement>(null);
  const pinned = useFollow(stage, column, !selected);
  // Braces matter: scrollTo returns a promise in newer browsers, and an effect may only return its cleanup.
  useEffect(() => {
    pinned.current = true;
    stage.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [exchange?.key]);

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
          <span className="composer-space" />
          <ModeSwitch mode={mode} onMode={onMode} onSettings={onSettings} />
        </header>

        <StickyNotes goal={goal} taskNumber={route?.task.number ?? null} />

        <main className="flow-stage" ref={stage}>
          <div className="flow-column" ref={column}>
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
        onModel={onSettings}
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

      <Notices app={app} />
    </div>
  );
}
