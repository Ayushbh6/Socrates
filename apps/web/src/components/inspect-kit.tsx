import { type ReactNode, useEffect, useRef, useState } from "react";
import { type CallRow, MOVES, type Move, promptSplit, tokens, switched } from "../lib/observe";
import { Spark } from "./charts";

/** How often the page asks again while it is open, and while Socrates is working. */
export const POLL_MS = 5_000;
export const POLL_BUSY_MS = 1_500;

export interface Polled<T> {
  data: T | null;
  error: string | null;
  /** When the data last arrived. */
  at: Date | null;
}

/**
 * Fetches again every `ms` while the page is visible. A failure keeps what was
 * shown and says so. Changing `deps` forgets the old data, so a page never
 * shows one thing's numbers under another's name.
 */
export function usePolled<T>(load: () => Promise<T>, deps: unknown[], ms: number): Polled<T> {
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null; at: Date | null }>({ key: "", data: null, error: null, at: null });
  const loader = useRef(load);
  loader.current = load;
  const key = JSON.stringify(deps);
  useEffect(() => {
    let alive = true;
    const run = () => loader.current().then(
      (data) => alive && setState({ key, data, error: null, at: new Date() }),
      (error: Error) => alive && setState((s) => ({ key, data: s.key === key ? s.data : null, error: error.message, at: s.at })),
    );
    void run();
    const timer = setInterval(() => { if (!document.hidden) void run(); }, ms);
    return () => { alive = false; clearInterval(timer); };
  }, [key, ms]);
  return state.key === key ? state : { data: null, error: null, at: null };
}

export function Tile({ label, value, sub, tone, trend, color }: { label: string; value: string; sub?: ReactNode; tone?: "good" | "warn"; trend?: (number | null)[]; color?: string }) {
  return (
    <div className="tile" data-tone={tone}>
      <span className="tile-label">{label}</span>
      <strong className="tile-value">{value}</strong>
      {sub && <span className="tile-sub">{sub}</span>}
      {trend && <Spark values={trend} color={color} />}
    </div>
  );
}

/** A call's prompt as a bar: what the cache served, what was written to it, and what was sent fresh. */
export function PromptBar({ call, widest }: { call: Pick<CallRow, "promptTokens" | "cacheReadTokens" | "cacheWriteTokens">; widest: number }) {
  const split = promptSplit(call);
  const width = (n: number) => `${(n / Math.max(1, widest)) * 100}%`;
  return (
    <div className="prompt-bar" role="img" aria-label={`${tokens(split.cached)} cached, ${tokens(split.written)} written, ${tokens(split.fresh)} fresh`}>
      <i data-part="cached" style={{ width: width(split.cached) }} />
      <i data-part="written" style={{ width: width(split.written) }} />
      <i data-part="fresh" style={{ width: width(split.fresh) }} />
    </div>
  );
}

export function MoveChip({ move }: { move: Move }) {
  return <b className="chip-move" data-move={move} data-switch={switched(move)}>{MOVES[move]}</b>;
}

/** A section of text that opens, closed by default unless `open`. */
export function Fold({ title, meta, children, open = false, tone }: { title: ReactNode; meta?: ReactNode; children: ReactNode; open?: boolean; tone?: string }) {
  return (
    <details className="fold" open={open} data-tone={tone}>
      <summary><span className="fold-title">{title}</span>{meta && <small>{meta}</small>}</summary>
      {children}
    </details>
  );
}

/** A value that may be JSON, shown indented when it is. */
export function prettyJson(text: string): string {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return text;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return text; }
}

export function useStored<T extends string>(key: string, fallback: T, allowed: readonly T[]): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try { const v = localStorage.getItem(key); return allowed.includes(v as T) ? (v as T) : fallback; } catch { return fallback; }
  });
  return [value, (v) => { setValue(v); try { localStorage.setItem(key, v); } catch {} }];
}
