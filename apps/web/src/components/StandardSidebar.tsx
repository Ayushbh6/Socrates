import { ChevronRight, Folder, FolderOpen, FolderPlus, LoaderCircle, PanelLeftClose, Plus, SquarePen } from "lucide-react";
import { type FormEvent, useState } from "react";
import { type Chat, type GoalChats, chatKey } from "../lib/chats";

const SHOWN = 6;

type Current = { goal: number; task: number; chat: number } | null;

/** Standard mode's left side: New chat, the plain chats, then every goal as a folder with its chats (its tasks) beneath. */
export function StandardSidebar({ goals, current, onChat, onNew, onNewGoal, onClose }: {
  goals: GoalChats[];
  current: Current;
  onChat: (goal: number, task: number, chat: number) => void;
  /** A new chat in a goal, or (null) among the plain chats. */
  onNew: (goal: number | null) => void;
  /** Makes the goal; resolves once it is listed, or rejects with why not. */
  onNewGoal: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  const [all, setAll] = useState<Record<number, boolean>>({});
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const plain = goals.find((g) => g.plain) ?? null;
  const folders = goals.filter((g) => !g.plain);
  const isCurrent = (c: Chat) => !!current && c.goal === current.goal && c.task === current.task && c.chat === current.chat;
  const visible = (g: GoalChats) => (all[g.number] || g.chats.length <= SHOWN + 1 ? g.chats : g.chats.filter((c, i) => i < SHOWN || isCurrent(c)));

  const create = async (e: FormEvent) => {
    e.preventDefault();
    const title = name.trim();
    if (!title) return;
    try {
      await onNewGoal(title);
      setNaming(false);
      setName("");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const rows = (g: GoalChats, nested: boolean) => (
    <ul className="chat-list" data-nested={nested}>
      {visible(g).map((chat) => (
        <li key={chatKey(chat.goal, chat.task, chat.chat)}>
          <button type="button" className="chat-row" data-current={isCurrent(chat)} data-status={chat.status} data-continued={chat.chat > 1} title={chat.title} onClick={() => onChat(chat.goal, chat.task, chat.chat)}>
            <span>{chat.title}</span>
            {chat.working && <LoaderCircle aria-label="Working" className="spin" />}
          </button>
        </li>
      ))}
      {visible(g).length < g.chats.length && <li><button type="button" className="chat-more" onClick={() => setAll({ ...all, [g.number]: true })}>Show more</button></li>}
    </ul>
  );

  return (
    <nav className="chat-sidebar" aria-label="Goals and chats">
      <div className="chat-sidebar-head">
        <span className="brand">Socrates</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Hide the sidebar" title="Hide the sidebar"><PanelLeftClose aria-hidden /></button>
      </div>
      <button type="button" className="new-chat" onClick={() => onNew(null)}><SquarePen aria-hidden /> New chat</button>

      <div className="sidebar-heading">
        <p className="panel-label">Goals</p>
        <button type="button" className="icon-button" onClick={() => { setNaming(!naming); setError(null); }} aria-label="New goal" title="New goal"><FolderPlus aria-hidden /></button>
      </div>
      {naming && (
        <form className="new-goal" onSubmit={create}>
          <input autoFocus value={name} maxLength={120} placeholder="Name the goal" aria-label="Name of the new goal" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(false)} />
          {error && <small role="alert">{error}</small>}
        </form>
      )}
      {!folders.length && !naming && <p className="sidebar-empty">A goal holds the chats of one project. Make one with the folder button.</p>}
      <ul className="goal-tree">
        {folders.map((goal) => {
          const has = current?.goal === goal.number;
          const open = closed[goal.number] === undefined ? true : !closed[goal.number];
          return (
            <li key={goal.number} className="goal-item">
              <button type="button" className="goal-row" aria-expanded={open} data-has-current={has} onClick={() => setClosed({ ...closed, [goal.number]: open })}>
                {open ? <FolderOpen aria-hidden /> : <Folder aria-hidden />}
                <span>{goal.title}</span>
                {goal.working ? <LoaderCircle aria-label="Working" className="spin" /> : <ChevronRight aria-hidden className="goal-chevron" />}
              </button>
              <button type="button" className="icon-button goal-new" onClick={() => onNew(goal.number)} aria-label={`New chat in ${goal.title}`} title="New chat in this goal"><Plus aria-hidden /></button>
              {open && (goal.chats.length ? rows(goal, true) : <p className="chat-none">No chats yet</p>)}
            </li>
          );
        })}
      </ul>

      {plain && plain.chats.length > 0 && (
        <>
          <p className="panel-label">Chats</p>
          {rows(plain, false)}
        </>
      )}
    </nav>
  );
}
