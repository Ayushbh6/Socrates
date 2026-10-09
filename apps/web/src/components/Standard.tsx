import { useEffect, useMemo, useState } from "react";
import { allQuestions, chatThread, chatTitle, groupChats, newThread, withoutArchived } from "../lib/chats";
import { chatBusy, currentRoute } from "../lib/model";
import { type AppState, store } from "../lib/store";
import type { Dock } from "../lib/terminals";
import type { ChatChoice } from "../lib/types";
import { AppHeader } from "./AppHeader";
import { Composer } from "./Composer";
import { type Mode } from "./ModeSwitch";
import { Notices } from "./Notices";
import { StandardSidebar, type Target } from "./StandardSidebar";
import { TerminalDock } from "./TerminalDock";
import { Thread } from "./Thread";

/**
 * What the middle shows: the newest chat (null), one the reader chose, or a
 * new chat in a goal (null: among the plain chats) begun after a given
 * question, with the id of its first message once sent. Other chats keep
 * working meanwhile, so the new chat follows its own message only.
 */
type View = null | { chat: { goal: number; task: number; chat: number } } | { fresh: string | null; goal: number | null; sent?: string };

/**
 * Standard mode (architecture/web.md, "Standard mode"): the layout of any chat
 * app. Goals are folders on the left, each holding its chats (its tasks), with
 * the plain chats beside them; one chat fills the middle with the composer
 * under it. Nothing is routed: a message goes to the chat that is open, or
 * starts the new one. Each chat works on its own, as its own lane would, so
 * several can work at once; a lane's work shows in its chat.
 */
export function Standard({ app, mode, dock, onMode, onSettings }: { app: AppState; mode: Mode; dock: Dock; onMode: (mode: Mode) => void; onSettings: () => void }) {
  const conversations = app.model.conversations;
  const main = useMemo(() => withoutArchived(allQuestions(conversations), app.goals), [conversations, app.goals]);
  const [view, setView] = useState<View>(null);
  const [sidebar, setSidebar] = useState(() => typeof window === "undefined" || window.innerWidth >= 1100);

  const route = view && "chat" in view ? { goal: { number: view.chat.goal }, task: { number: view.chat.task }, chat: view.chat.chat } : view ? null : currentRoute(main.filter((e) => e.route));
  const chat = route?.chat ?? 1;
  const shown = useMemo(
    () => (view && "fresh" in view ? (view.sent ? main.filter((e) => e.sendId === view.sent) : newThread(main, view.fresh).filter((e) => !e.route)) : route ? chatThread(main, route.goal.number, route.task.number, chat) : main.filter((e) => !e.route && (e.state === "sending" || e.state === "working"))),
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
  const working = chatBusy(app.model.live, target);
  const narrow = () => window.innerWidth < 1100;

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
    <div className="standard" data-sidebar={sidebar}>
      <AppHeader app={app} mode={mode} dock={dock} sidebar={sidebar} sidebarId="standard-sidebar" onSidebar={() => setSidebar(!sidebar)} onMode={onMode} onSettings={onSettings} onStop={working ? () => store.cancel("main", target) : undefined}>
        <div className="chat-title">
          {task ? <><strong title={task.title}>{chatTitle(task.title, chat)}</strong>{!goal?.chats && <small title={goal?.title}>{goal?.title}</small>}</> : <><strong>New chat</strong>{freshGoal && <small>{freshGoal.title}</small>}</>}
        </div>
      </AppHeader>
      {sidebar && (
        <>
          <StandardSidebar
            onClose={() => setSidebar(false)}
            goals={goals}
            current={route ? { goal: route.goal.number, task: route.task.number, chat } : null}
            onChat={(g, t, c) => { setView({ chat: { goal: g, task: t, chat: c } }); if (narrow()) setSidebar(false); }}
            onNew={(g) => { setView({ fresh: main.at(-1)?.key ?? null, goal: g }); if (narrow()) setSidebar(false); }}
            archived={app.archived}
            onRename={(what, title) => (what.task === undefined ? store.renameGoal(what.goal, title) : store.renameChat(what.goal, what.task, title))}
            onArchive={archive}
            onRestore={(what) => store.restore(what)}
            onStatus={(goal, status) => void store.setStatus({ goal }, status)}
            onOpenArchive={() => void store.loadArchived().catch(() => {})}
            onNewGoal={async (title) => {
              const made = await store.createGoal(title);
              setView({ fresh: main.at(-1)?.key ?? null, goal: made.number });
              if (narrow()) setSidebar(false);
            }}
          />
          <button type="button" className="sidebar-scrim-button" aria-label="Hide the sidebar" onClick={() => setSidebar(false)} />
        </>
      )}

      <section className="chat-main" aria-label="Chat">
        <Thread app={app} conversation="main" shown={shown} onRedone={(id) => setView({ fresh: main.at(-1)?.key ?? null, goal: null, sent: id })} before={chat > 1 && goal && task ? <Continued onBack={() => setView({ chat: { goal: goal.number, task: task.number, chat: chat - 1 } })} /> : null} empty={fresh || !main.length ? (freshGoal ? `What's next for ${freshGoal.title}?` : "What should we work on?") : "Nothing has been asked in this chat yet."} />
        <div className="chat-composer">
          <Composer app={app} conversation="main" laneNumber={null} variant="panel" chat={target} placeholder={task ? "Reply…" : "Ask Socrates…"} onModel={onSettings} onNewLane={() => null} onSent={(id) => { if (fresh) setView({ ...fresh, sent: id }); }} />
        </div>
        <TerminalDock app={app} dock={dock} variant="docked" />
      </section>

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
