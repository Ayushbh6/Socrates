import { ChevronDown, FolderOpen, Pencil, Plus, RotateCcw, Square, SquareTerminal, X } from "lucide-react";
import { type PointerEvent, Suspense, lazy, useState } from "react";
import { type AppState } from "../lib/store";
import { type Dock, terminalState, dockMax } from "../lib/terminals";
import type { TerminalView } from "../lib/types";
import { FolderPicker } from "./FolderPicker";

const TerminalScreen = lazy(() => import("./TerminalScreen"));
const STATE_LABEL = { waiting: "needs input", running: "running", done: "finished", failed: "failed", stopped: "stopped" } as const;

export function TerminalToggle({ app, dock }: { app: AppState; dock: Dock }) {
  const list = app.terminals ?? [];
  const running = list.filter(t => t.status === "running").length;
  const waiting = list.some(t => t.status === "running" && t.inputRequired);
  const label = `${dock.open ? "Hide" : "Show"} terminals (Ctrl+\`)${waiting ? ": one needs input" : ""}`;
  return <button type="button" className="icon-button terminal-toggle" data-open={dock.open} data-waiting={waiting} onClick={dock.toggle} aria-label={label} title={label}>
    <SquareTerminal aria-hidden />{running > 0 && <span className="terminal-count">{running}</span>}
  </button>;
}

/** One shared terminal workspace in both chat modes. Hiding never stops a process. */
export function TerminalDock({ app, dock, variant }: { app: AppState; dock: Dock; variant: "docked" | "overlay" }) {
  const [chooseFolder, setChooseFolder] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  const list = app.terminals ?? [];
  const active = list.find(t => t.id === dock.active) ?? list[0] ?? null;
  if (!dock.open) return null;
  const state = active ? terminalState(active) : null;
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    const startY = e.clientY, startHeight = dock.height, handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const move = (m: globalThis.PointerEvent) => dock.setHeight(startHeight + startY - m.clientY);
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
  };
  const rename = () => {
    if (renaming && name.trim()) void dock.action(renaming, "rename", name.trim());
    setRenaming(null);
  };
  return <section className="terminal-dock" data-variant={variant} style={{ height: dock.height }} aria-label="Terminals">
    <div className="terminal-grip" role="separator" tabIndex={0} aria-orientation="horizontal" aria-label="Resize the terminal panel" aria-valuemin={160} aria-valuemax={dockMax()} aria-valuenow={dock.height} onPointerDown={drag} onKeyDown={e => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); dock.setHeight(dock.height + (e.key === "ArrowUp" ? 40 : -40)); } }} />
    <div className="terminal-bar">
      <span className="terminal-heading"><SquareTerminal aria-hidden /> Terminal</span>
      <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
        {list.map(t => <div key={t.id} className="terminal-tab" data-on={t.id === active?.id}>
          {renaming === t.id ? <input className="terminal-rename" autoFocus aria-label="Terminal name" maxLength={64} value={name} onChange={e => setName(e.target.value)} onBlur={rename} onKeyDown={e => { if (e.key === "Enter") rename(); if (e.key === "Escape") setRenaming(null); }} /> :
            <button type="button" role="tab" aria-selected={t.id === active?.id} className="terminal-tab-name" tabIndex={t.id === active?.id ? 0 : -1} onKeyDown={e => {
              const index = list.findIndex(s => s.id === t.id);
              const next = e.key === "ArrowRight" ? (index + 1) % list.length : e.key === "ArrowLeft" ? (index + list.length - 1) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
              if (next !== null) { e.preventDefault(); dock.select(list[next]!.id); (e.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus(); }
            }} title={`${t.command}\n${t.cwd}${t.task ? `\n${t.task}` : ""}`} onClick={() => dock.select(t.id)} onDoubleClick={() => { setRenaming(t.id); setName(t.name); }}>
              <span className="terminal-dot" data-state={terminalState(t)} aria-label={STATE_LABEL[terminalState(t)]} />
              {t.name}{terminalState(t) === "waiting" && <span className="terminal-badge">input</span>}
            </button>}
          <button type="button" disabled={dock.busy} className="terminal-tab-close" onClick={() => void dock.action(t.id, "close")} aria-label={`Close ${t.name}`} title={t.status === "running" ? "Close and stop this terminal" : "Close terminal"}><X aria-hidden /></button>
        </div>)}
      </div>
      <div className="terminal-actions">
        <button type="button" className="icon-button" disabled={dock.busy || !app.connected} onClick={() => void dock.create()} aria-label="New terminal" title={`New terminal${dock.folder ? ` in ${dock.folder}` : ""}`}><Plus aria-hidden /></button>
        <button type="button" className="icon-button" disabled={dock.busy} onClick={() => setChooseFolder(true)} aria-label="New terminal in folder" title="Choose a folder for a new terminal"><FolderOpen aria-hidden /></button>
        {active && <>
          <button type="button" className="icon-button" disabled={dock.busy} onClick={() => { setRenaming(active.id); setName(active.name); }} aria-label="Rename terminal" title="Rename terminal"><Pencil aria-hidden /></button>
          <button type="button" className="icon-button" disabled={dock.busy} onClick={() => void dock.action(active.id, "restart")} aria-label="Restart terminal" title="Restart this terminal"><RotateCcw aria-hidden /></button>
          {active.status === "running" && <button type="button" className="icon-button" disabled={dock.busy} onClick={() => void dock.action(active.id, "stop")} aria-label="Stop terminal" title="Stop this terminal and its processes"><Square aria-hidden /></button>}
        </>}
        <button type="button" className="icon-button" onClick={dock.close} aria-label="Hide the terminals" title="Hide (Ctrl+`)"><ChevronDown aria-hidden /></button>
      </div>
    </div>
    {dock.error && <p className="terminal-error" role="alert">{dock.error}</p>}
    {active ? <>
      <div className="terminal-meta">
        <FolderOpen aria-hidden /><span className="terminal-folder-label">Started in</span><span className="terminal-folder" title={`Started in ${active.cwd}`}>{active.cwd}</span>
        {active.task && <span>· {active.task}</span>}
        <span className="terminal-state" data-state={state}>{active.status === "exited" ? exitText(active) : dock.busy ? "Updating…" : "Connected"}</span>
        {active.ports.map(port => <a key={port} href={`http://localhost:${port}`} target="_blank" rel="noreferrer">:{port}</a>)}
      </div>
      {active.status === "exited" && !active.cols && <p className="terminal-note">This terminal is stopped. Restart to open a new session in the same folder.</p>}
      <Suspense fallback={<div className="terminal-screen" />}><TerminalScreen key={active.id} view={active} /></Suspense>
      {!active.pty && <p className="terminal-note">Output only · This command was started without an interactive terminal.</p>}
    </> : <div className="terminal-empty"><SquareTerminal aria-hidden /><p>{dock.busy ? "Opening your terminal…" : "Your workspace, ready when you are."}</p><button className="quiet-button" disabled={dock.busy || !app.connected} onClick={() => void dock.create()}>Open terminal</button>{dock.folder && <span>{dock.folder}</span>}</div>}
    {chooseFolder && <FolderPicker title="New terminal in folder" onCancel={() => setChooseFolder(false)} onChoose={async cwd => { setChooseFolder(false); await dock.create(cwd); }} />}
  </section>;
}
function exitText(t: TerminalView): string {
  if (t.reason === "terminated") return "Stopped";
  if (t.reason === "timeout") return "Deadline reached";
  if (t.signal) return `Ended by ${t.signal}`;
  return t.exitCode === 0 ? "Finished" : `Exit ${t.exitCode}`;
}
