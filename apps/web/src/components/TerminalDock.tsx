import { ListX, ChevronDown, FolderOpen, Pencil, Plus, RotateCcw, Square, SquareTerminal, X } from "lucide-react";
import { type PointerEvent, Suspense, lazy, useState } from "react";
import { type AppState } from "../lib/store";
import { type Dock, dockMax, groupByOwner, ownerLine, ownerOf, terminalState } from "../lib/terminals";
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
export function TerminalDock({ app, dock, variant, onOwner }: { app: AppState; dock: Dock; variant: "docked" | "overlay"; /** Open the conversation a terminal was started in; omitted where the mode cannot show it. */ onOwner?: (t: TerminalView) => boolean }) {
  const [chooseFolder, setChooseFolder] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState("");
  // Tabs by whose they are; a group is labelled only when there is more than one.
  const groups = groupByOwner(app.terminals ?? []);
  const list = groups.flatMap(g => g.terminals);
  const grouped = groups.length > 1;
  const finished = list.filter(t => t.status === "exited");
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
        {groups.map(g => <div key={g.owner.key} className="terminal-group" data-tone={g.owner.tone} data-grouped={grouped} role="presentation">
        {grouped && <span className="terminal-group-label" title={[g.owner.label, g.owner.detail].filter(Boolean).join(" · ")}><span className="owner-swatch" aria-hidden />{g.owner.label}</span>}
        {g.terminals.map(t => <div key={t.id} className="terminal-tab" data-on={t.id === active?.id}>
          {renaming === t.id ? <input className="terminal-rename" autoFocus aria-label="Terminal name" maxLength={64} value={name} onChange={e => setName(e.target.value)} onBlur={rename} onKeyDown={e => { if (e.key === "Enter") rename(); if (e.key === "Escape") setRenaming(null); }} /> :
            <button type="button" role="tab" aria-selected={t.id === active?.id} className="terminal-tab-name" tabIndex={t.id === active?.id ? 0 : -1} onKeyDown={e => {
              const index = list.findIndex(s => s.id === t.id);
              const next = e.key === "ArrowRight" ? (index + 1) % list.length : e.key === "ArrowLeft" ? (index + list.length - 1) % list.length : e.key === "Home" ? 0 : e.key === "End" ? list.length - 1 : null;
              if (next !== null) { e.preventDefault(); dock.select(list[next]!.id); (e.currentTarget.closest('[role="tablist"]')?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next])?.focus(); }
            }} title={`${t.command}\n${t.cwd}\n${ownerLine(t)}${t.task ? ` · ${t.task}` : ""}`} onClick={() => dock.select(t.id)} onDoubleClick={() => { setRenaming(t.id); setName(t.name); }}>
              <span className="terminal-dot" data-state={terminalState(t)} data-watched={t.watched} aria-label={`${STATE_LABEL[terminalState(t)]}${t.watched ? ", Socrates is waiting on it" : ""}`} />
              {grouped && <span className="sr-only">{ownerOf(t).label}: </span>}{t.name}{terminalState(t) === "waiting" && <span className="terminal-badge">input</span>}
            </button>}
          <button type="button" disabled={dock.busy} className="terminal-tab-close" onClick={() => void dock.action(t.id, "close")} aria-label={`Close ${t.name}`} title={t.status === "running" ? "Close and stop this terminal" : "Close terminal"}><X aria-hidden /></button>
        </div>)}
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
        {finished.length > 1 && <button type="button" className="icon-button" disabled={dock.busy} onClick={() => void dock.closeAll(finished.map(t => t.id))} aria-label={`Close ${finished.length} finished terminals`} title={`Close the ${finished.length} finished terminals`}><ListX aria-hidden /></button>}
        <button type="button" className="icon-button" onClick={dock.close} aria-label="Hide the terminals" title="Hide (Ctrl+`)"><ChevronDown aria-hidden /></button>
      </div>
    </div>
    {dock.error && <p className="terminal-error" role="alert">{dock.error}</p>}
    {active ? <>
      <div className="terminal-meta">
        <Owner t={active} onOwner={onOwner} />
        <FolderOpen aria-hidden /><span className="terminal-folder" title={`Started in ${active.cwd}`}>{active.cwd}</span>
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
/** Whose the terminal is, in its tone; it opens the lane or chat that started it where the page can. */
function Owner({ t, onOwner }: { t: TerminalView; onOwner?: (t: TerminalView) => boolean }) {
  const owner = ownerOf(t);
  const task = t.owner?.strand === "chat" ? t.task : owner.detail;
  const body = <>
    <span className="owner-swatch" aria-hidden />
    <span className="terminal-owner-text">{ownerLine(t)}{task && <> · <strong>{task}</strong></>}</span>
    {t.watched && <span className="terminal-watched">Socrates is waiting on it</span>}
  </>;
  const canOpen = !!onOwner && t.owner?.by === "agent" && (t.owner.strand === "main" || (t.owner.strand === "lane" && !!t.owner.lane?.open) || t.owner.strand === "chat");
  return canOpen
    ? <button type="button" className="terminal-owner" data-tone={owner.tone} onClick={() => onOwner!(t)} title="Open the conversation that started it">{body}</button>
    : <span className="terminal-owner" data-tone={owner.tone}>{body}</span>;
}

function exitText(t: TerminalView): string {
  if (t.reason === "terminated") return "Stopped";
  if (t.reason === "timeout") return "Deadline reached";
  if (t.signal) return `Ended by ${t.signal}`;
  return t.exitCode === 0 ? "Finished" : `Exit ${t.exitCode}`;
}
