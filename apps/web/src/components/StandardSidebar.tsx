import { Archive, ArchiveRestore, ChevronRight, Folder, FolderOpen, FolderPlus, LoaderCircle, PanelLeftClose, Pencil, Plus, SquarePen } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { type Chat, type GoalChats, chatKey } from "../lib/chats";
import type { ArchivedView } from "../lib/types";

const SHOWN = 6;

type Current = { goal: number; task: number; chat: number } | null;
/** A goal, or a chat (a task) of one. */
export type Target = { goal: number; task?: number };

const sameTarget = (a: Target | null, b: Target) => !!a && a.goal === b.goal && a.task === b.task;

/**
 * Standard mode's left side: New chat, the goals as folders with their chats
 * (their tasks) beneath, the plain chats, and the archive. A goal or chat can
 * be renamed in place or archived; archived ones are listed at the bottom and
 * restored from there.
 */
export function StandardSidebar({ goals, current, archived, onChat, onNew, onNewGoal, onRename, onArchive, onRestore, onOpenArchive, onClose }: {
  goals: GoalChats[];
  current: Current;
  archived: ArchivedView | null;
  onChat: (goal: number, task: number, chat: number) => void;
  /** A new chat in a goal, or (null) among the plain chats. */
  onNew: (goal: number | null) => void;
  /** Makes the goal; resolves once it is listed, or rejects with why not. */
  onNewGoal: (title: string) => Promise<void>;
  onRename: (target: Target, title: string) => Promise<void>;
  onArchive: (target: Target, title: string) => Promise<void>;
  onRestore: (target: Target) => Promise<void>;
  onOpenArchive: () => void;
  onClose: () => void;
}) {
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  const [all, setAll] = useState<Record<number, boolean>>({});
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<{ target: Target; value: string } | null>(null);
  const [archive, setArchive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plain = goals.find((g) => g.plain) ?? null;
  const folders = goals.filter((g) => !g.plain);
  const isCurrent = (c: Chat) => !!current && c.goal === current.goal && c.task === current.task && c.chat === current.chat;
  const visible = (g: GoalChats) => (all[g.number] || g.chats.length <= SHOWN + 1 ? g.chats : g.chats.filter((c, i) => i < SHOWN || isCurrent(c)));

  const attempt = async (work: () => Promise<void>) => {
    try {
      await work();
      setError(null);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  };
  const create = async (e: FormEvent) => {
    e.preventDefault();
    const title = name.trim();
    if (title && await attempt(() => onNewGoal(title))) { setNaming(false); setName(""); }
  };
  const saveRename = async () => {
    if (!renaming) return;
    const title = renaming.value.trim();
    if (!title) return setRenaming(null);
    if (await attempt(() => onRename(renaming.target, title))) setRenaming(null);
  };
  const renameKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") { e.preventDefault(); void saveRename(); }
    if (e.key === "Escape") setRenaming(null);
  };
  const renameBox = (target: Target) => (
    <input className="rename-input" autoFocus aria-label="New name" maxLength={120} value={renaming!.value} onChange={(e) => setRenaming({ target, value: e.target.value })} onKeyDown={renameKeys} onBlur={() => void saveRename()} />
  );
  const actions = (target: Target, title: string, extra?: React.ReactNode) => (
    <span className="row-actions">
      {extra}
      <button type="button" className="icon-button" onClick={() => setRenaming({ target, value: title })} aria-label={`Rename ${title}`} title="Rename"><Pencil aria-hidden /></button>
      <button type="button" className="icon-button" onClick={() => void attempt(() => onArchive(target, title))} aria-label={`Archive ${title}`} title="Archive"><Archive aria-hidden /></button>
    </span>
  );

  const rows = (g: GoalChats, nested: boolean) => (
    <ul className="chat-list" data-nested={nested}>
      {visible(g).map((chat) => {
        const target: Target = { goal: chat.goal, task: chat.task };
        const title = chat.title.replace(/ — continued( \(\d+\))?$/, "");
        return (
          <li key={chatKey(chat.goal, chat.task, chat.chat)} className="chat-item">
            {renaming && sameTarget(renaming.target, target) && chat.chat === 1 ? renameBox(target) : (
              <>
                <button type="button" className="chat-row" data-current={isCurrent(chat)} data-status={chat.status} data-continued={chat.chat > 1} title={chat.title} onClick={() => onChat(chat.goal, chat.task, chat.chat)}>
                  <span>{chat.title}</span>
                  {chat.working && <LoaderCircle aria-label="Working" className="spin" />}
                </button>
                {chat.chat === 1 && !chat.working && actions(target, title)}
              </>
            )}
          </li>
        );
      })}
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
        </form>
      )}
      {error && <p className="sidebar-error" role="alert">{error}</p>}
      {!folders.length && !naming && <p className="sidebar-empty">A goal holds the chats of one project. Make one with the folder button.</p>}
      <ul className="goal-tree">
        {folders.map((goal) => {
          const has = current?.goal === goal.number;
          const open = closed[goal.number] === undefined ? true : !closed[goal.number];
          const target: Target = { goal: goal.number };
          return (
            <li key={goal.number} className="goal-item">
              {renaming && sameTarget(renaming.target, target) ? renameBox(target) : (
                <>
                  <button type="button" className="goal-row" aria-expanded={open} data-has-current={has} onClick={() => setClosed({ ...closed, [goal.number]: open })}>
                    {open ? <FolderOpen aria-hidden /> : <Folder aria-hidden />}
                    <span>{goal.title}</span>
                    {goal.working ? <LoaderCircle aria-label="Working" className="spin" /> : <ChevronRight aria-hidden className="goal-chevron" />}
                  </button>
                  {!goal.working && actions(target, goal.title, <button type="button" className="icon-button" onClick={() => onNew(goal.number)} aria-label={`New chat in ${goal.title}`} title="New chat in this goal"><Plus aria-hidden /></button>)}
                </>
              )}
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

      <div className="archive-drawer">
      {archive && (
        <ul className="archive-list">
          {!archived && <li className="sidebar-empty">Loading…</li>}
          {archived && !archived.goals.length && !archived.tasks.length && <li className="sidebar-empty">Nothing is archived.</li>}
          {archived?.goals.map((g) => (
            <li key={`g${g.number}`}>
              <span title={g.title}><Folder aria-hidden />{g.title}<small>{g.chats} {g.chats === 1 ? "chat" : "chats"}</small></span>
              <button type="button" className="icon-button" onClick={() => void attempt(() => onRestore({ goal: g.number }))} aria-label={`Restore ${g.title}`} title="Restore"><ArchiveRestore aria-hidden /></button>
            </li>
          ))}
          {archived?.tasks.map((t) => (
            <li key={`t${t.goal.number}/${t.number}`}>
              <span title={t.title}>{t.title}<small>{t.goal.title}</small></span>
              <button type="button" className="icon-button" onClick={() => void attempt(() => onRestore({ goal: t.goal.number, task: t.number }))} aria-label={`Restore ${t.title}`} title="Restore"><ArchiveRestore aria-hidden /></button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="archive-toggle" aria-expanded={archive} onClick={() => { if (!archive) onOpenArchive(); setArchive(!archive); }}>
        <Archive aria-hidden /> Archived{archived && archived.goals.length + archived.tasks.length > 0 ? ` · ${archived.goals.length + archived.tasks.length}` : ""}
      </button>
      </div>
    </nav>
  );
}
