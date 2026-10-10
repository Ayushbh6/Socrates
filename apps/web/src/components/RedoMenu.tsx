import { CornerUpRight, MessageSquare, Plus, Sun } from "lucide-react";
import { type CSSProperties, type MouseEvent, useState } from "react";
import type { Exchange } from "../lib/model";
import { store, useApp } from "../lib/store";
import { Popover } from "./Popover";

/** At most this many chats of one goal are offered; the newest first. */
const CHATS_SHOWN = 8;

/**
 * "Redo in…" (architecture/web.md, "Redo in another task"): ask a finished or
 * stopped question again in another chat, a new chat in a goal, or today's
 * general conversation, when the router put it in the wrong place. `blocked`
 * says why it cannot be redone now; the button then only says so.
 */
export function RedoMenu({ exchange, blocked, onRedone }: { exchange: Exchange; blocked: string | null; onRedone?: (id: string) => void }) {
  const app = useApp();
  const [place, setPlace] = useState<{ style: CSSProperties; anchor: HTMLElement } | null>(null);
  const here = exchange.route;
  const close = () => setPlace(null);
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    if (place) return close();
    const r = e.currentTarget.getBoundingClientRect();
    const height = Math.min(420, window.innerHeight - 24);
    const below = r.bottom + 4 + height <= window.innerHeight;
    setPlace({ anchor: e.currentTarget, style: { position: "fixed", top: below ? r.bottom + 4 : Math.max(12, r.top - 4 - height), left: Math.max(8, Math.min(r.left, window.innerWidth - 280)), right: "auto", maxHeight: height } });
  };
  const go = (to: Parameters<typeof store.redo>[1]) => () => {
    close();
    const id = store.redo(exchange, to);
    if (id) onRedone?.(id);
  };
  const goals = app.goals.filter((g) => !g.general);
  // A question asked in today's general conversation cannot be asked there again.
  const inGeneral = !!here && app.goals.some((g) => g.general && g.number === here.goal.number);
  const today = inGeneral && new Date(exchange.at).toDateString() === new Date().toDateString();
  // The plain chats last, as in the sidebar.
  const ordered = [...goals.filter((g) => !g.chats), ...goals.filter((g) => g.chats)];
  return (
    <span className="redo">
      <button type="button" className="redo-button" aria-haspopup="menu" aria-expanded={!!place} aria-disabled={!!blocked} title={blocked ?? "Ask this again in another task, when it landed in the wrong one"} onClick={blocked ? undefined : toggle}>
        <CornerUpRight aria-hidden />Redo in…
      </button>
      {place && (
        <Popover align="left" onClose={close} className="row-menu redo-menu" style={place.style} anchor={place.anchor}>
          <p className="redo-menu-label">Ask it again in</p>
          {!today && <button type="button" role="menuitem" onClick={go({ general: true })}><Sun aria-hidden />Today's general conversation</button>}
          {ordered.map((g) => {
            const chats = g.tasks.filter((t) => !(here && here.goal.number === g.number && here.task.number === t.number)).sort((a, b) => b.number - a.number).slice(0, CHATS_SHOWN);
            return (
              <div key={g.number} className="redo-menu-group">
                <p className="redo-menu-label">{g.chats ? "Chats" : g.title}</p>
                {chats.map((t) => (
                  <button key={t.number} type="button" role="menuitem" title={t.title} onClick={go({ chat: { goal: g.number, task: t.number } })}><MessageSquare aria-hidden /><span>{t.title}</span></button>
                ))}
                <button type="button" role="menuitem" className="redo-menu-new" onClick={go({ chat: { goal: g.number, task: null } })}><Plus aria-hidden />New chat{g.chats ? "" : ` in ${g.title}`}</button>
              </div>
            );
          })}
          {!goals.some((g) => g.chats) && (
            <div className="redo-menu-group">
              <p className="redo-menu-label">Chats</p>
              <button type="button" role="menuitem" className="redo-menu-new" onClick={go({ chat: { goal: null, task: null } })}><Plus aria-hidden />New chat</button>
            </div>
          )}
        </Popover>
      )}
    </span>
  );
}

/** AnswerView's `redo`: what to offer for this exchange, or nothing. */
export function redoOffer(exchange: Exchange, list: Exchange[], onRedone?: (id: string) => void): { blocked: string | null; onRedone?: (id: string) => void } | undefined {
  const blocked = redoBlock(exchange, list);
  return blocked === undefined ? undefined : { blocked, ...(onRedone ? { onRedone } : {}) };
}

/**
 * Whether an exchange can be redone: undefined when the offer does not apply
 * (still working, a clarifying question, a message split into parts, already
 * redone), else null, or why not now. Only a task's latest question can be,
 * because later ones may build on its answer; the server checks again.
 */
export function redoBlock(exchange: Exchange, list: Exchange[]): string | null | undefined {
  const route = exchange.route;
  const work = exchange.turns.filter(id => id !== exchange.clarification?.turnId);
  if (!route || exchange.redoneTo || (exchange.question && exchange.clarification?.state !== "answered") || work.length !== 1) return undefined;
  if (exchange.state !== "done" && exchange.state !== "stopped") return undefined;
  const later = list.some((o) => o !== exchange && !o.redoneTo && o.route?.goal.number === route.goal.number && o.route.task.number === route.task.number &&
    (o.route.projectTurn !== undefined && route.projectTurn !== undefined ? o.route.projectTurn > route.projectTurn : o.at > exchange.at));
  return later ? "Later questions in this task build on this answer." : null;
}
