import { useCallback, useEffect, useRef, useState } from "react";
import { store } from "./store";
import type { TerminalView } from "./types";

/**
 * The terminal panel's state (architecture/web.md, "Terminal panel"): whether
 * it is open, which session it shows, and how tall it is. It belongs to the
 * page, not a mode, so switching between flow and standard keeps it.
 */
export interface Dock {
  open: boolean;
  /** The session shown, or null when there is none. */
  active: string | null;
  height: number;
  toggle(): void;
  close(): void;
  select(id: string): void;
  setHeight(height: number): void;
}

const HEIGHT_KEY = "socrates.terminal-height";
export const DOCK_MIN = 160;
const DOCK_DEFAULT = 300;

/** The tallest the panel may be: most of the window, leaving room for the chat above it. */
export const dockMax = () => Math.max(DOCK_MIN, Math.round(window.innerHeight * 0.7));

/**
 * What the panel should come forward for when the list changes: a session the
 * agent has just started, or one that has just begun to wait for input. The
 * first list a page receives brings nothing forward: those sessions were
 * already there.
 */
export function cameForward(before: TerminalView[] | null, after: TerminalView[]): string | null {
  if (!before) return null;
  const known = new Map(before.map((t) => [t.id, t]));
  const waiting = after.find((t) => t.status === "running" && t.inputRequired && !known.get(t.id)?.inputRequired);
  if (waiting) return waiting.id;
  return after.find((t) => t.status === "running" && !known.has(t.id))?.id ?? null;
}

/** The session to show when the shown one is gone: one that waits for input, else one that runs, else the newest. */
export function fallback(list: TerminalView[]): string | null {
  return (list.find((t) => t.status === "running" && t.inputRequired) ?? list.find((t) => t.status === "running") ?? list.at(-1))?.id ?? null;
}

/** How a session's state reads on its tab. */
export function terminalState(t: TerminalView): "waiting" | "running" | "done" | "failed" | "stopped" {
  if (t.status === "running") return t.inputRequired ? "waiting" : "running";
  if (t.reason === "terminated") return "stopped";
  return t.exitCode === 0 ? "done" : "failed";
}

export function useDock(terminals: TerminalView[] | null): Dock {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [height, setHeightState] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY));
      return saved >= DOCK_MIN ? saved : DOCK_DEFAULT;
    } catch {
      return DOCK_DEFAULT;
    }
  });
  const before = useRef<TerminalView[] | null>(null);

  useEffect(() => {
    if (!terminals) return;
    const forward = cameForward(before.current, terminals);
    before.current = terminals;
    if (forward) {
      setActive(forward);
      setOpen(true);
    } else {
      setActive((current) => (terminals.some((t) => t.id === current) ? current : fallback(terminals)));
    }
    if (!terminals.length) setOpen(false);
  }, [terminals]);

  // A session restarted from the panel comes back under a new id.
  useEffect(() => store.onTerminalRestarted((from, to) => setActive((current) => (current === from ? to : current))), []);

  const toggle = useCallback(() => setOpen((o) => !o && !!terminals?.length), [terminals]);
  // Ctrl+` opens and closes it, as in an editor.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === "`") {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [toggle]);

  const setHeight = useCallback((h: number) => {
    const next = Math.round(Math.min(dockMax(), Math.max(DOCK_MIN, h)));
    setHeightState(next);
    try { localStorage.setItem(HEIGHT_KEY, String(next)); } catch {}
  }, []);

  return {
    open: open && !!terminals?.length,
    active,
    height,
    toggle,
    close: () => setOpen(false),
    select: (id) => { setActive(id); setOpen(true); },
    setHeight,
  };
}
