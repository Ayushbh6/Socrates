import { PanelLeft, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { chatThread, chatTitle, groupChats, newThread } from "../lib/chats";
import { conversationBusy, currentRoute } from "../lib/model";
import { type AppState, store } from "../lib/store";
import type { Lane } from "../lib/types";
import { AccessMenu } from "./AccessMenu";
import { Composer } from "./Composer";
import { type Mode, ModeSwitch } from "./ModeSwitch";
import { Notices } from "./Notices";
import { StandardSidebar } from "./StandardSidebar";
import { Thread } from "./Thread";

/** What the middle shows: the newest chat (null), one the reader chose, or a new chat begun after a given question. */
type View = null | { chat: { goal: number; task: number; chat: number } } | { fresh: string | null };

/**
 * Standard mode (architecture/web.md, "Standard mode"): the layout of any chat
 * app. Goals are folders on the left, each holding its chats (its tasks); one
 * chat fills the middle with the composer under it, and lanes keep their own
 * panels at the right. Socrates still routes every message, so a message
 * written in a chat joins the chat it belongs to.
 */
export function Standard({ app, mode, onMode, onSettings }: { app: AppState; mode: Mode; onMode: (mode: Mode) => void; onSettings: () => void }) {
  const lanes = app.model.live?.lanes ?? app.status?.lanes ?? [];
  const main = app.model.conversations.main ?? [];
  const side = lanes.length > 0 || app.model.pending.length > 0;
  const mainBusy = conversationBusy(app.model.live, "main");
  const [view, setView] = useState<View>(null);
  const [sidebar, setSidebar] = useState(() => typeof window === "undefined" || window.innerWidth >= 900);

  const route = view && "chat" in view ? { goal: { number: view.chat.goal }, task: { number: view.chat.task }, chat: view.chat.chat } : view ? null : currentRoute(main);
  const chat = route?.chat ?? 1;
  const shown = useMemo(() => (view && "fresh" in view ? newThread(main, view.fresh) : route ? chatThread(main, route.goal.number, route.task.number, chat) : main), [main, view, route?.goal.number, route?.task.number, chat]);
  const goals = useMemo(() => groupChats(app.goals, main), [app.goals, main]);
  const goal = route ? app.goals.find((g) => g.number === route.goal.number) : undefined;
  const task = goal?.tasks.find((t) => t.number === route?.task.number);

  // A new chat becomes the chat its first question was routed to.
  useEffect(() => {
    if (view && "fresh" in view && shown.some((e) => e.route)) setView(null);
  }, [view, shown]);

  return (
    <div className="standard" data-lanes={side} data-sidebar={sidebar}>
      {sidebar && (
        <>
          <StandardSidebar
            goals={goals}
            current={route ? { goal: route.goal.number, task: route.task.number, chat } : null}
            onChat={(g, t, c) => { setView({ chat: { goal: g, task: t, chat: c } }); if (window.innerWidth < 900) setSidebar(false); }}
            onNew={() => { setView({ fresh: main.at(-1)?.key ?? null }); if (window.innerWidth < 900) setSidebar(false); }}
            onClose={() => setSidebar(false)}
          />
          <button type="button" className="sidebar-scrim-button" aria-label="Hide the sidebar" onClick={() => setSidebar(false)} />
        </>
      )}

      <section className="chat-main" aria-label="Chat">
        <header className="chat-top">
          {!sidebar && <button type="button" className="icon-button" onClick={() => setSidebar(true)} aria-label="Show the sidebar" title="Show the sidebar"><PanelLeft aria-hidden /></button>}
          <div className="chat-title">
            {task ? <><strong>{chatTitle(task.title, chat)}</strong><small>{goal?.title}</small></> : <strong>New chat</strong>}
          </div>
          {!app.connected ? <span className="chip reconnecting">Reconnecting…</span> : app.model.live && !app.model.live.ready && <span className="chip reconnecting">Socrates is restarting…</span>}
          <span className="composer-space" />
          {mainBusy && <button type="button" className="quiet-button" onClick={() => store.cancel("main")}><Square aria-hidden /> Stop</button>}
          <AccessMenu app={app} />
          <ModeSwitch mode={mode} onMode={onMode} onSettings={onSettings} />
        </header>
        <Thread app={app} conversation="main" shown={shown} before={chat > 1 && goal && task ? <Continued onBack={() => setView({ chat: { goal: goal.number, task: task.number, chat: chat - 1 } })} /> : null} empty={view && "fresh" in view || !main.length ? "What should we work on?" : "Nothing has been asked in this chat yet."} />
        <div className="chat-composer">
          <Composer app={app} conversation="main" laneNumber={null} variant="panel" onModel={onSettings} onNewLane={(text, attachments) => store.sendToNewLane(text, attachments)} />
        </div>
      </section>

      {side && (
        <div className="lanes-column" aria-label="Lanes">
          {lanes.map((lane) => <LanePanel key={lane.id} app={app} lane={lane} />)}
          {app.model.pending.map((e) => (
            <section key={e.key} className="panel lane-panel">
              <div className="panel-head"><strong>New lane</strong><small>starting…</small></div>
              <Thread app={app} conversation={`pending:${e.key}`} extra={[e]} compact empty="" />
            </section>
          ))}
        </div>
      )}

      <Notices app={app} />
    </div>
  );
}

/** The start of a chat that took over from a full one. */
function Continued({ onBack }: { onBack: () => void }) {
  return (
    <aside className="continued-note" aria-label="Continued from the previous chat">
      <span>Automatically continued from the previous chat after extensive context compression. Socrates carries over what matters.</span>
      <button type="button" className="quiet-button" onClick={onBack}>Open the previous chat</button>
    </aside>
  );
}

function LanePanel({ app, lane }: { app: AppState; lane: Lane }) {
  const route = currentRoute(app.model.conversations[lane.id] ?? []);
  const state = lane.waitingForApproval ? "waiting for you" : lane.running ? "working" : "idle";
  return (
    <section className="panel lane-panel" aria-label={`Lane ${lane.number}`}>
      <div className="panel-head">
        <span className="lane-dot" data-running={lane.running} data-waiting={lane.waitingForApproval} />
        <strong>Lane {lane.number}</strong>
        <small title={route?.task.title}>{route ? route.task.title : state}</small>
        <span className="composer-space" />
        {route && <small>{state}</small>}
        {lane.running ? (
          <button type="button" className="icon-button" onClick={() => store.cancel(lane.id)} aria-label={`Stop lane ${lane.number}`} title="Stop"><Square aria-hidden /></button>
        ) : (
          <button type="button" className="icon-button" onClick={() => store.closeLane(lane.id)} aria-label={`Close lane ${lane.number}`} title="Close this lane"><X aria-hidden /></button>
        )}
      </div>
      <Thread app={app} conversation={lane.id} compact empty={`Lane ${lane.number} is ready.`} />
      <Composer app={app} conversation={lane.id} laneNumber={lane.number} variant="panel" compact autoFocus={false} onNewLane={(text, attachments) => store.sendToNewLane(text, attachments)} />
    </section>
  );
}
