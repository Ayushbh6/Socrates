import type { Exchange } from "./model";
import type { GoalView } from "./types";

/** Standard mode's sidebar: a goal holds chats, and a chat is one task of it (or, for a very long task, one stretch of it). */
export interface Chat {
  goal: number;
  task: number;
  /** Which chat of the task, from 1; a long task continues in a new chat after five compactions. */
  chat: number;
  title: string;
  status: string;
  /** When its newest loaded question was asked. */
  at: string | null;
  working: boolean;
}

export interface GoalChats {
  number: number;
  title: string;
  at: string | null;
  working: boolean;
  chats: Chat[];
}

export const chatKey = (goal: number, task: number, chat = 1): string => `${goal}/${task}/${chat}`;

/** A task's later chats are named after it: "Fix the header — continued", then "— continued (3)". */
export const chatTitle = (title: string, chat: number): string => (chat <= 1 ? title : `${title} — continued${chat > 2 ? ` (${chat})` : ""}`);

const newest = (a: string | null, b: string | null): string | null => (a && b ? (a > b ? a : b) : a ?? b);
const latestFirst = (a: { at: string | null }, b: { at: string | null }): number => (a.at && b.at ? (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) : a.at ? -1 : b.at ? 1 : 0);

/** Every goal with its chats, the one worked on last first; a goal or chat not asked about since loading keeps the order it was made in, newest first. */
export function groupChats(goals: GoalView[], exchanges: Exchange[]): GoalChats[] {
  const seen = new Map<string, { at: string | null; working: boolean }>();
  for (const e of exchanges) {
    if (!e.route) continue;
    const key = chatKey(e.route.goal.number, e.route.task.number, e.route.chat);
    const now = seen.get(key) ?? { at: null, working: false };
    seen.set(key, { at: newest(now.at, e.at), working: now.working || e.state === "working" || e.state === "sending" });
  }
  return goals
    .filter((g) => !g.general)
    .map((g) => {
      const tasks = g.tasks.map((t) => {
        const chats = Array.from({ length: Math.max(1, t.chats ?? 1) }, (_, i): Chat => {
          const s = seen.get(chatKey(g.number, t.number, i + 1));
          return { goal: g.number, task: t.number, chat: i + 1, title: chatTitle(t.title, i + 1), status: t.status, at: s?.at ?? null, working: s?.working ?? false };
        });
        return { number: t.number, at: chats.reduce<string | null>((at, c) => newest(at, c.at), null), chats };
      });
      // The task worked on last first; its chats stay in the order of the chain.
      const chats = tasks.sort((a, b) => latestFirst(a, b) || b.number - a.number).flatMap((t) => t.chats);
      return { number: g.number, title: g.title, at: chats.reduce<string | null>((at, c) => newest(at, c.at), null), working: chats.some((c) => c.working), chats };
    })
    .sort((a, b) => latestFirst(a, b) || b.number - a.number);
}

/** The questions of one chat, oldest first. A question not routed yet, or the router's own question, that came after the chat's last one belongs to it too. */
export function chatThread(exchanges: Exchange[], goal: number, task: number, chat = 1): Exchange[] {
  const here = (e: Exchange) => e.route?.goal.number === goal && e.route.task.number === task && (e.route.chat ?? 1) === chat;
  const last = exchanges.reduce((at, e, i) => (here(e) ? i : at), -1);
  return exchanges.filter((e, i) => (e.route ? here(e) : i > last));
}

/** What was asked after a new chat was started: the questions newer than the one that was last when it began. */
export function newThread(exchanges: Exchange[], after: string | null): Exchange[] {
  const from = after === null ? 0 : exchanges.findIndex((e) => e.key === after) + 1;
  return exchanges.slice(from);
}
