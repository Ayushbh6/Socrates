import { PanelLeft, Square, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { chatThread, chatTitle, groupChats, newThread, withoutArchived } from "../lib/chats";
import { conversationBusy, currentRoute } from "../lib/model";
import { type AppState, store } from "../lib/store";
import type { ChatChoice, Lane } from "../lib/types";
import { AccessMenu } from "./AccessMenu";
import { Composer } from "./Composer";
import { type Mode, ModeSwitch } from "./ModeSwitch";
import { Notices } from "./Notices";
import { StandardSidebar, type Target } from "./StandardSidebar";
import { Thread } from "./Thread";

/**
 * What the middle shows: the newest chat (null), one the reader chose, or a
 * new chat in a goal (null: among the plain chats) begun after a given question.
 */
type View = null | { chat: { goal: number; task: number; chat: number } } | { fresh: string | null; goal: number | null };

/**
 * Standard mode (architecture/web.md, "Standard mode"): the layout of any chat
 * app. Goals are folders on the left, each holding its chats (its tasks), with
 * the plain chats beside them; one chat fills the middle with the composer
 * under it, and lanes keep their own panels at the right. Nothing is routed:
 * a message goes to the chat that is open, or starts the new one.
 */
export function Standard({ app, mode, onMode, onSettings }: { app: AppState; mode: Mode; onMode: (mode: Mode) => void; onSettings: () => void }) {
  const lanes = app.model.live?.lanes ?? app.status?.lanes ?? [];
  const everything = app.model.conversations.main;
  const main = useMemo(() => withoutArchived(everything ?? [], app.goals), [everything, app.goals]);
  const side = lanes.length > 0 || app.model.pending.length > 0;
  const mainBusy = conversationBusy(app.model.live, "main");
  const [view, setView] = useState<View>(null);
  const [sidebar, setSidebar] = useState(() => typeof window === "undefined" || window.innerWidth >= 900);

  // The general conversation of flow mode is no chat here.
  const general = new Set(app.goals.filter((g) => g.general).map((g) => g.number));
  const route = view && "chat" in view ? { goal: { number: view.chat.goal }, task: { number: view.chat.task }, chat: view.chat.chat } : view ? null : currentRoute(main.filter((e) => e.route && !general.has(e.route.goal.number)));
  const chat = route?.chat ?? 1;
  const shown = useMemo(
    () => (view && "fresh" in view ? newThread(main, view.fresh) : route ? chatThread(main, route.goal.number, route.task.number, chat) : main.filter((e) => !e.route && (e.state === "sending" || e.state === "working"))),
    [main, view, route?.goal.number, route?.task.number, chat],
  );
  const goals = useMemo(() => groupChats(app.goals, main), [app.goals, main]);
  const goal = route ? app.goals.find((g) => g.number === route.goal.number) : undefined;
  const task = goal?.tasks.find((t) => t.number === route?.task.number);

  // A new chat becomes the chat its first question was bound to.
  useEffect(() => {
    const bound = view && "fresh" in view ? shown.find((e) => e.route)?.route : null;
    if (bound) setView({ chat: { goal: bound.goal.number, task: bound.task.number, chat: bound.chat ?? 1 } });
  }, [view, shown]);
  const fresh = view && "fresh" in view ? view : null;
  const freshGoal = fresh?.goal != null ? app.goals.find((g) => g.number === fresh.goal) : undefined;
  // Where the composer sends: the open chat, else a new one (in the chosen goal, or among the plain chats).
  const target: ChatChoice = route && !fresh ? { goal: route.goal.number, task: route.task.number } : { goal: fresh?.goal ?? null, task: null };
  const narrow = () => window.innerWidth < 900;

  // Archiving says so for a few seconds, with a way back.
  const [toast, setToast] = useState<{ text: string; undo: () => void } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 8_000);
    return () => clearTimeout(timer);
  }, [toast]);
  const archive = async (what: Target, title: string) => {
    await store.archive(what);
    // The open chat (or one in the archived goal) is gone; the view follows the newest remaining chat.
    if (route && route.goal.number === what.goal && (what.task === undefined || what.task === route.task.number)) setView(null);
    setToast({ text: `Archived “${title}”`, undo: () => { setToast(null); void store.restore(what); } });
  };

  return (
    <div className="standard" data-lanes={side} data-sidebar={sidebar}>
      {sidebar && (
        <>
          <StandardSidebar
            goals={goals}
            current={route ? { goal: route.goal.number, task: route.task.number, chat } : null}
            onChat={(g, t, c) => { setView({ chat: { goal: g, task: t, chat: c } }); if (narrow()) setSidebar(false); }}
            onNew={(g) => { setView({ fresh: main.at(-1)?.key ?? null, goal: g }); if (narrow()) setSidebar(false); }}
            archived={app.archived}
            onRename={(what, title) => (what.task === undefined ? store.renameGoal(what.goal, title) : store.renameChat(what.goal, what.task, title))}
            onArchive={archive}
            onRestore={(what) => store.restore(what)}
            onOpenArchive={() => void store.loadArchived().catch(() => {})}
            onNewGoal={async (title) => {
              const made = await store.createGoal(title);
              setView({ fresh: main.at(-1)?.key ?? null, goal: made.number });
              if (narrow()) setSidebar(false);
            }}
            onClose={() => setSidebar(false)}
          />
          <button type="button" className="sidebar-scrim-button" aria-label="Hide the sidebar" onClick={() => setSidebar(false)} />
        </>
      )}

      <section className="chat-main" aria-label="Chat">
        <header className="chat-top">
          {!sidebar && <button type="button" className="icon-button" onClick={() => setSidebar(true)} aria-label="Show the sidebar" title="Show the sidebar"><PanelLeft aria-hidden /></button>}
          <div className="chat-title">
            {task ? <><strong>{chatTitle(task.title, chat)}</strong>{!goal?.chats && <small>{goal?.title}</small>}</> : <><strong>New chat</strong>{freshGoal && <small>{freshGoal.title}</small>}</>}
          </div>
          {!app.connected ? <span className="chip reconnecting">Reconnecting…</span> : app.model.live && !app.model.live.ready && <span className="chip reconnecting">Socrates is restarting…</span>}
          <span className="composer-space" />
          {mainBusy && <button type="button" className="quiet-button" onClick={() => store.cancel("main")}><Square aria-hidden /> Stop</button>}
          <AccessMenu app={app} />
          <ModeSwitch mode={mode} onMode={onMode} onSettings={onSettings} />
        </header>
        <Thread app={app} conversation="main" shown={shown} before={chat > 1 && goal && task ? <Continued onBack={() => setView({ chat: { goal: goal.number, task: task.number, chat: chat - 1 } })} /> : null} empty={fresh || !main.length ? (freshGoal ? `What's next for ${freshGoal.title}?` : "What should we work on?") : "Nothing has been asked in this chat yet."} />
        <div className="chat-composer">
          <Composer app={app} conversation="main" laneNumber={null} variant="panel" chat={target} placeholder={task ? "Reply…" : "Ask Socrates…"} onModel={onSettings} onNewLane={(text, attachments) => store.sendToNewLane(text, attachments)} />
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

      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          <button type="button" className="quiet-button" onClick={toast.undo}>Undo</button>
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
