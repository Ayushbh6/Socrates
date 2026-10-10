import { type Exchange, taskOrder } from "./model";
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
  /** A day of the general conversation: listed with the plain chats; it cannot be renamed or archived. */
  general?: boolean;
}

export interface GoalChats {
  number: number;
  title: string;
  /** Standard mode's plain chats, outside any goal: listed apart, not as a folder. */
  plain: boolean;
  /** The goal's status, which only the user sets: open, completed, or superseded. */
  status: string;
  at: string | null;
  working: boolean;
  chats: Chat[];
}

export const chatKey = (goal: number, task: number, chat = 1): string => `${goal}/${task}/${chat}`;

/** A task's later chats are named after it: "Fix the header — continued", then "— continued (3)". */
export const chatTitle = (title: string, chat: number): string => (chat <= 1 ? title : `${title} — continued${chat > 2 ? ` (${chat})` : ""}`);

const newest = (a: string | null, b: string | null): string | null => (a && b ? (a > b ? a : b) : a ?? b);
const latestFirst = (a: { at: string | null }, b: { at: string | null }): number => (a.at && b.at ? (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) : a.at ? -1 : b.at ? 1 : 0);

/**
 * Every goal with its chats, the one worked on last first; a goal or chat not
 * asked about since loading keeps the order it was made in, newest first. The
 * general conversation's days join the plain chats, as one list.
 */
export function groupChats(goals: GoalView[], exchanges: Exchange[]): GoalChats[] {
  const seen = new Map<string, { at: string | null; working: boolean }>();
  for (const e of exchanges) {
    if (!e.route) continue;
    const key = chatKey(e.route.goal.number, e.route.task.number, e.route.chat);
    const now = seen.get(key) ?? { at: null, working: false };
    seen.set(key, { at: newest(now.at, e.at), working: now.working || e.state === "working" || e.state === "sending" });
  }
  const grouped = goals
    .map((g) => {
      const tasks = g.tasks.map((t) => {
        const chats = Array.from({ length: Math.max(1, t.chats ?? 1) }, (_, i): Chat => {
          const s = seen.get(chatKey(g.number, t.number, i + 1));
          return { goal: g.number, task: t.number, chat: i + 1, title: chatTitle(t.title, i + 1), status: t.status, at: s?.at ?? null, working: s?.working ?? false, ...(g.general ? { general: true } : {}) };
        });
        return { number: t.number, at: chats.reduce<string | null>((at, c) => newest(at, c.at), null), chats };
      });
      // The task worked on last first; its chats stay in the order of the chain.
      const chats = tasks.sort((a, b) => latestFirst(a, b) || b.number - a.number).flatMap((t) => t.chats);
      return { number: g.number, title: g.title, plain: g.chats === true || g.general, status: g.status, at: chats.reduce<string | null>((at, c) => newest(at, c.at), null), working: chats.some((c) => c.working), chats };
    })
    .sort((a, b) => latestFirst(a, b) || b.number - a.number);
  const plain = grouped.filter((g) => g.plain);
  if (plain.length < 2) return grouped;
  // One plain list: the task worked on last first, its chats in the order of the chain; the rest keep their order, newest goal first.
  const tasks: Chat[][] = [];
  for (const c of plain.sort((a, b) => b.number - a.number).flatMap((g) => g.chats)) {
    const last = tasks.at(-1);
    if (last && last[0]!.goal === c.goal && last[0]!.task === c.task) last.push(c);
    else tasks.push([c]);
  }
  const latest = (t: Chat[]) => ({ at: t.reduce<string | null>((at, c) => newest(at, c.at), null) });
  const chats = tasks.sort((a, b) => latestFirst(latest(a), latest(b))).flat();
  const into = plain.find((g) => !goals.find((v) => v.number === g.number)?.general) ?? plain[0]!;
  const merged = { ...into, at: chats.reduce<string | null>((at, c) => newest(at, c.at), null), working: chats.some((c) => c.working), chats };
  return grouped.filter((g) => !g.plain).concat(merged).sort((a, b) => latestFirst(a, b) || b.number - a.number);
}

/**
 * Every question standard mode shows, in the order asked: the main
 * conversation's and each lane's, since a lane's work shows in its chat (there
 * are no lane panels here). A main-conversation question handed whole to a
 * lane shows once, in the lane, where its work and answer are.
 */
export function allQuestions(conversations: Record<string, Exchange[]>): Exchange[] {
  const main = conversations.main ?? [];
  const lanes = Object.entries(conversations).flatMap(([id, list]) => (id === "main" ? [] : list));
  if (!lanes.length) return main;
  const inLanes = new Set(lanes.flatMap((e) => e.turns));
  const kept = main.filter(e => {const work = e.turns.filter(t => t !== e.clarification?.turnId); return e.answers.length > 0 || !work.length || !work.every(t => inLanes.has(t));});
  return [...kept, ...lanes].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The questions explicitly assigned to this chat, including its chosen sends still waiting to bind. */
export function chatThread(exchanges: Exchange[], goal: number, task: number, chat = 1): Exchange[] {
  const here = (e: Exchange) => e.route?.goal.number === goal && e.route.task.number === task && (e.route.chat ?? 1) === chat;
  return taskOrder(exchanges.filter(here));
}

/** What was asked after a new chat was started: the questions newer than the one that was last when it began. */
export function newThread(exchanges: Exchange[], after: string | null): Exchange[] {
  const from = after === null ? 0 : exchanges.findIndex((e) => e.key === after) + 1;
  return exchanges.slice(from);
}

/**
 * The questions the page still shows: those of a chat that was archived (so is
 * no longer listed) are left out. A question still being worked on, or one
 * whose goal has not been listed yet, is always kept.
 */
export function withoutArchived(exchanges: Exchange[], goals: GoalView[]): Exchange[] {
  if (!goals.length) return exchanges;
  const listed = new Map(goals.map((g) => [g.number, new Set(g.tasks.map((t) => t.number))]));
  return exchanges.filter((e) => {
    if (!e.route || e.state === "sending" || e.state === "working") return true;
    const tasks = listed.get(e.route.goal.number);
    // A goal not listed at all is archived, or too new to be listed; only an old, settled question is dropped.
    return tasks ? tasks.has(e.route.task.number) : Date.now() - Date.parse(e.at) < 60_000;
  });
}
