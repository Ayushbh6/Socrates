import { ChevronDown, RotateCcw, Square, SquareTerminal, X } from "lucide-react";
import { type PointerEvent, Suspense, lazy } from "react";
import { type AppState, store } from "../lib/store";
import { type Dock, terminalState } from "../lib/terminals";
import type { TerminalView } from "../lib/types";

/** xterm.js loads with the first terminal opened, not with the page. */
const TerminalScreen = lazy(() => import("./TerminalScreen"));

const STATE_LABEL = { waiting: "needs input", running: "running", done: "finished", failed: "failed", stopped: "stopped" } as const;

/** The header button that opens the terminal panel; it shows only once the agent has started something. */
export function TerminalToggle({ app, dock }: { app: AppState; dock: Dock }) {
  const list = app.terminals ?? [];
  if (!list.length) return null;
  const running = list.filter((t) => t.status === "running").length;
  const waiting = list.some((t) => t.status === "running" && t.inputRequired);
  const label = `${dock.open ? "Hide" : "Show"} terminals (Ctrl+\`)${waiting ? ": one needs input" : ""}`;
  return (
    <button type="button" className="icon-button terminal-toggle" data-open={dock.open} data-waiting={waiting} onClick={dock.toggle} aria-label={label} title={label}>
      <SquareTerminal aria-hidden />
      {running > 0 && <span className="terminal-count">{running}</span>}
    </button>
  );
}

/**
 * The terminal panel (architecture/web.md, "Terminal panel"): a tab for each
 * session the agent started, showing the same terminal the agent drives.
 * The user can watch it, type into it, stop it, and run it again; the agent
 * holds off typing for a few seconds after the user does.
 */
export function TerminalDock({ app, dock, variant }: { app: AppState; dock: Dock; variant: "docked" | "overlay" }) {
  const list = app.terminals ?? [];
  const active = list.find((t) => t.id === dock.active) ?? null;
  if (!dock.open || !active) return null;
  const state = terminalState(active);

  const drag = (e: PointerEvent<HTMLDivElement>) => {
    const startY = e.clientY;
    const startHeight = dock.height;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) => dock.setHeight(startHeight + startY - m.clientY);
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };

  return (
    <section className="terminal-dock" data-variant={variant} style={{ height: dock.height }} aria-label="Terminals">
      <div className="terminal-grip" role="separator" aria-orientation="horizontal" aria-label="Resize the terminal panel" onPointerDown={drag} />
      <div className="terminal-bar">
        <div className="terminal-tabs" role="tablist">
          {list.map((t) => {
            const s = terminalState(t);
            return (
              <div key={t.id} className="terminal-tab" role="tab" aria-selected={t.id === active.id} data-on={t.id === active.id} title={t.command}>
                <button type="button" className="terminal-tab-name" onClick={() => dock.select(t.id)}>
                  <span className="terminal-dot" data-state={s} aria-label={STATE_LABEL[s]} />
                  {t.name}
                  {s === "waiting" && <span className="terminal-badge">needs input</span>}
                </button>
                {t.status === "exited" && (
                  <button type="button" className="terminal-tab-close" onClick={() => store.terminal("terminal_dismiss", t.id)} aria-label={`Remove ${t.name}`} title="Remove">
                    <X aria-hidden />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <div className="terminal-actions">
          {active.status === "running" ? (
            <>
              <button type="button" className="quiet-button" onClick={() => store.terminal("terminal_restart", active.id)} title="Stop it and run the same command again"><RotateCcw aria-hidden /> Restart</button>
              <button type="button" className="quiet-button" onClick={() => store.terminal("terminal_stop", active.id)} title="Stop it and everything it started"><Square aria-hidden /> Stop</button>
            </>
          ) : (
            <button type="button" className="quiet-button" onClick={() => store.terminal("terminal_restart", active.id)} title="Run the same command again"><RotateCcw aria-hidden /> Run again</button>
          )}
          <button type="button" className="icon-button" onClick={dock.close} aria-label="Hide the terminals" title="Hide (Ctrl+`)"><ChevronDown aria-hidden /></button>
        </div>
      </div>
      <p className="terminal-meta">
        <code>{active.command}</code>
        {active.cwd !== "." && <span>in {active.cwd}</span>}
        {active.ports.map((port) => <a key={port} href={`http://localhost:${port}`} target="_blank" rel="noreferrer">localhost:{port}</a>)}
        {active.task && <span>for “{active.task}”</span>}
        {active.status === "exited" && <span data-state={state}>{exitText(active)}</span>}
      </p>
      <Suspense fallback={<div className="terminal-screen" />}>
        <TerminalScreen key={active.id} view={active} />
      </Suspense>
      {!active.pty && <p className="terminal-note">This command runs without a terminal, so it shows output but can't be typed into.</p>}
    </section>
  );
}

function exitText(t: TerminalView): string {
  if (t.reason === "terminated") return "Stopped";
  if (t.reason === "timeout") return "Stopped at its deadline";
  if (t.signal) return `Ended by ${t.signal}`;
  return t.exitCode === 0 ? "Finished" : `Exited with code ${t.exitCode}`;
}
