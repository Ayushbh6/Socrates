import { PanelLeft, Square } from "lucide-react";
import type { ReactNode } from "react";
import type { AppState } from "../lib/store";
import type { Dock } from "../lib/terminals";
import { AccessMenu } from "./AccessMenu";
import { type Mode, ModeSwitch } from "./ModeSwitch";
import { TerminalToggle } from "./TerminalDock";

/** One header in both modes; opening a sidebar never moves its controls. */
export function AppHeader({ app, mode, dock, sidebar, sidebarId, onSidebar, onMode, onSettings, onStop, children }: {
  app: AppState;
  mode: Mode;
  dock: Dock;
  sidebar: boolean;
  sidebarId: string;
  onSidebar: () => void;
  onMode: (mode: Mode) => void;
  onSettings: () => void;
  onStop?: () => void;
  children?: ReactNode;
}) {
  const label = sidebar ? "Hide the sidebar" : "Show the sidebar";
  return (
    <header className="app-header">
      <div className="app-header-left">
        <button type="button" className="icon-button sidebar-toggle" onClick={onSidebar} aria-label={label} title={label} aria-expanded={sidebar} aria-controls={sidebarId} data-on={sidebar}>
          <PanelLeft aria-hidden />
        </button>
        <AccessMenu app={app} />
      </div>
      <div className="app-header-context">{children}</div>
      <div className="app-header-actions">
        {!app.connected ? <span className="chip reconnecting" role="status">Reconnecting…</span> : app.model.live && !app.model.live.ready && <span className="chip reconnecting" role="status">Socrates is restarting…</span>}
        {onStop && <button type="button" className="icon-button" onClick={onStop} aria-label="Stop" title="Stop"><Square aria-hidden /></button>}
        <TerminalToggle app={app} dock={dock} />
        <ModeSwitch mode={mode} onMode={onMode} onSettings={onSettings} />
      </div>
    </header>
  );
}
