import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { store } from "./store";
import type { TerminalView } from "./types";

/**
 * The terminal panel's state (architecture/web.md, "Terminal panel"): whether
 * it is open, which session it shows, and how tall it is. It belongs to the
 * page, not a mode, so switching between flow and standard keeps it.
 */
export interface Dock {
  open: boolean;
  busy: boolean;
  error: string | null;
  folder: string;
  context(goal?: number, task?: number): void;
  create(cwd?: string): Promise<void>;
  action(id: string, action: "stop" | "restart" | "close" | "rename", name?: string): Promise<void>;
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

export function useDock(terminals: TerminalView[] | null, folderSettings = ""): Dock {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem("socrates.terminal-open") === "true"; } catch { return false; } });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const pendingCreate = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [target, setTarget] = useState<{goal?: number; task?: number}>({});
  const context = useCallback((goal?: number, task?: number) => setTarget(old => old.goal === goal && old.task === task ? old : { ...(goal ? {goal} : {}), ...(task ? {task} : {}) }), []);
  useEffect(() => {
    let cancelled = false;
    api.terminalFolder(target.goal).then(value => { if (!cancelled) setFolder(value.cwd); }, () => { if (!cancelled) setFolder(""); });
    return () => { cancelled = true; };
  }, [target, open, folderSettings]);
  useEffect(() => { try { localStorage.setItem("socrates.terminal-open", String(open)); } catch {} }, [open]);
  const [active, setActive] = useState<string | null>(() => { try { return localStorage.getItem("socrates.terminal-active"); } catch { return null; } });
  useEffect(() => { try { if (active) localStorage.setItem("socrates.terminal-active", active); } catch {} }, [active]);
  const create = useCallback(async (cwd?: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setOpen(true);
    try {
      const next = await api.createTerminal({ ...target, ...(cwd ? {cwd} : {}) });
      setActive(next.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }, [target]);
  const action = useCallback(async (id: string, action: "stop" | "restart" | "close" | "rename", name?: string) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const next = await api.terminalAction(id, action, name);
      if (action === "restart") setActive(next.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { busyRef.current = false; setBusy(false); }
  }, []);
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
    if (pendingCreate.current) { pendingCreate.current = false; if (!terminals.length) void create(); }
    const forward = cameForward(before.current, terminals);
    before.current = terminals;
    if (forward) {
      setActive(forward);
      setOpen(true);
    } else {
      setActive((current) => (terminals.some((t) => t.id === current) ? current : fallback(terminals)));
    }

  }, [terminals, create]);

  // A session restarted from the panel comes back under a new id.
  useEffect(() => store.onTerminalRestarted((from, to) => setActive((current) => (current === from ? to : current))), []);

  const toggle = useCallback(() => {
    if (open) { pendingCreate.current = false; setOpen(false); }
    else { setOpen(true); if (!terminals) pendingCreate.current = true; else if (!terminals.length) void create(); }
  }, [open, terminals, create]);
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
    open, busy, error, folder, context, create, action,
    active,
    height,
    toggle,
    close: () => setOpen(false),
    select: (id) => { setActive(id); setOpen(true); },
    setHeight,
  };
}
