import { ChevronRight, Folder, FolderOpen, LoaderCircle, PanelLeftClose, SquarePen } from "lucide-react";
import { useState } from "react";
import { type GoalChats, chatKey } from "../lib/chats";

const SHOWN = 6;

/** Standard mode's left side: every goal as a folder, and its chats (its tasks) beneath. */
export function StandardSidebar({ goals, current, onChat, onNew, onClose }: {
  goals: GoalChats[];
  current: { goal: number; task: number; chat: number } | null;
  onChat: (goal: number, task: number, chat: number) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [closed, setClosed] = useState<Record<number, boolean>>({});
  const [all, setAll] = useState<Record<number, boolean>>({});
  return (
    <nav className="chat-sidebar" aria-label="Goals and chats">
      <div className="chat-sidebar-head">
        <span className="brand">Socrates</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Hide the sidebar" title="Hide the sidebar"><PanelLeftClose aria-hidden /></button>
      </div>
      <button type="button" className="new-chat" onClick={onNew}><SquarePen aria-hidden /> New chat</button>
      <p className="panel-label">Goals</p>
      {!goals.length && <p className="sidebar-empty">Goals appear here as you work with Socrates.</p>}
      <ul className="goal-tree">
        {goals.map((goal) => {
          const has = current?.goal === goal.number;
          const open = closed[goal.number] === undefined ? true : !closed[goal.number];
          const chats = all[goal.number] || goal.chats.length <= SHOWN + 1 ? goal.chats : goal.chats.filter((c, i) => i < SHOWN || (current && c.goal === current.goal && c.task === current.task && c.chat === current.chat));
          return (
            <li key={goal.number}>
              <button type="button" className="goal-row" aria-expanded={open} data-has-current={has} onClick={() => setClosed({ ...closed, [goal.number]: open })}>
                {open ? <FolderOpen aria-hidden /> : <Folder aria-hidden />}
                <span>{goal.title}</span>
                {goal.working ? <LoaderCircle aria-label="Working" className="spin" /> : <ChevronRight aria-hidden className="goal-chevron" />}
              </button>
              {open && (
                <ul className="chat-list">
                  {chats.map((chat) => (
                    <li key={chatKey(chat.goal, chat.task, chat.chat)}>
                      <button type="button" className="chat-row" data-current={has && current?.task === chat.task && current.chat === chat.chat} data-continued={chat.chat > 1} data-status={chat.status} title={chat.title} onClick={() => onChat(chat.goal, chat.task, chat.chat)}>
                        <span>{chat.title}</span>
                        {chat.working && <LoaderCircle aria-label="Working" className="spin" />}
                      </button>
                    </li>
                  ))}
                  {chats.length < goal.chats.length && <li><button type="button" className="chat-more" onClick={() => setAll({ ...all, [goal.number]: true })}>Show more</button></li>}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
