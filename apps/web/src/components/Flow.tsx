import { X } from "lucide-react";
import { LayoutGroup } from "motion/react";
import { type CSSProperties, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { CONTINUE_MESSAGE, continueKeep, currentRoute, orbDocked, orbState, viewedExchange } from "../lib/model";
import { useFollow } from "../lib/follow";
import { type AppState, store } from "../lib/store";
import type { Dock } from "../lib/terminals";
import type { KeepChoice } from "../lib/types";
import { AppHeader } from "./AppHeader";
import { AnswerView } from "./AnswerView";
import { redoOffer } from "./RedoMenu";
import { Composer } from "./Composer";
import { type Mode } from "./ModeSwitch";
import { Notices } from "./Notices";
import { Orb } from "./Orb";
import { QuestionCard } from "./QuestionCard";
import { Sidebar } from "./Sidebar";
import { StickyNotes } from "./StickyNotes";
import { TerminalDock } from "./TerminalDock";

/**
 * Flow mode (architecture/web.md, "Flow mode"): one question and its answer on
 * an open canvas, the orb in the middle until the answer starts, the task and
 * goal notes beside it, and earlier questions in the sidebar.
 */
export function Flow({ app, mode, dock, onMode, onSettings }: { app: AppState; mode: Mode; dock: Dock; onMode: (mode: Mode) => void; onSettings: () => void }) {
  const [conversation, setConversation] = useState("main");
  const [selected, setSelected] = useState<string | null>(null);
  const [sidebar, setSidebar] = useState(false);
  const [following, setFollowing] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  // "Keep my next message in this task", for the main conversation's next message only.
  const [keep, setKeep] = useState<KeepChoice | null>(null);
  useEffect(() => setKeep(null), [conversation]);
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
  // Keep the question just sent on the canvas while earlier queued work is saved and run.
  const waiting = sent ? list.find((e) => e.sendId === sent && !e.route && (e.state === "working" || e.state === "sending")) ?? null : null;
  const exchange = viewedExchange(list, selected, pendingLane ?? waiting);
  // An approval belongs to the question whose turn asked (a standard-mode chat's is not this canvas's); one without a turn, to the newest question here.
  const latest = exchange !== null && (exchange === list.at(-1) || exchange === pendingLane);
  const approvals = exchange ? (app.model.live?.approvals ?? []).filter((a) => (a.turnId ? exchange.turns.includes(a.turnId) : latest && a.conversation === conversation)) : [];
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
    // The terminal panel slides up over the canvas; the composer rises with it.
    <div className="flow" ref={root} onPointerMove={parallax} style={{ "--dock-h": dock.open ? `${dock.height}px` : "0px" } as CSSProperties}>
      <div className="flow-dots" aria-hidden />
      <LayoutGroup>
        <div className="planet-layer" aria-hidden={docked}>
          {!docked && <Orb state={state} docked={false} />}
        </div>

        <AppHeader app={app} mode={mode} dock={dock} sidebar={sidebar} sidebarId="flow-sidebar" onSidebar={() => setSidebar(!sidebar)} onMode={onMode} onSettings={onSettings} onApproval={(e) => { setConversation(e.conversation); setSelected(e.key); setFollowing(null); setSent(null); setSidebar(false); }}>
          {conversation !== "main" && (
            <button type="button" className="chip lane-chip" onClick={() => { setConversation("main"); setSelected(null); }}>
              Lane {lane?.number} <X aria-hidden />
            </button>
          )}
        </AppHeader>

        <StickyNotes goal={goal} taskNumber={route?.task.number ?? null} keep={conversation === "main" ? keep : null} onKeep={setKeep} />

        <main className="flow-stage" ref={stage}>
          <div className="flow-column" ref={column}>
            {exchange && selected && (
              <p className="history-notice">
                An earlier question <button type="button" onClick={() => setSelected(null)}>Return to the latest</button>
              </p>
            )}
            {exchange && (
              <>
                <QuestionCard text={exchange.message} attachments={exchange.attachments} note={exchange.state === "working" || exchange.state === "sending" ? exchange.note : null} />
                <section className="answer" aria-live="polite">
                  <div className="answer-dock">{docked && <Orb state={state} docked />}</div>
                  <AnswerView key={exchange.key} exchange={exchange} approvals={approvals} redo={redoOffer(exchange, list, () => setSelected(null))} {...(latest ? { onContinue: () => { store.send(CONTINUE_MESSAGE, conversation, [], undefined, continueKeep(exchange, conversation, app.goals)); setSelected(null); } } : {})} />
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
        onSent={(id) => { setSent(id); setSelected(null); setKeep(null); }}
        keep={conversation === "main" && keep ? { choice: keep, title: app.goals.find((g) => g.number === keep.goal)?.tasks.find((t) => t.number === keep.task)?.title ?? "this task" } : undefined}
        onUnkeep={() => setKeep(null)}
        onNewLane={(text, attachments) => {
          const id = store.sendToNewLane(text, attachments);
          if (id) setFollowing(id);
          return id;
        }}
      />

      <TerminalDock app={app} dock={dock} variant="overlay" />

      <Sidebar
        app={app}
        open={sidebar}
        conversation={conversation}
        selected={selected}
        onClose={() => setSidebar(false)}
        onConversation={(c) => {
          setSent(null);
          setConversation(c);
          setSelected(null);
          setSidebar(false);
        }}
        onSelect={(key) => {
          setSent(null);
          setSelected(key);
          setSidebar(false);
        }}
      />

      <Notices app={app} />
    </div>
  );
}
