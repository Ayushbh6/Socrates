import { SidebarToggle } from "./SidebarChrome";
import { Square } from "lucide-react";
import type { ReactNode } from "react";
import type { AppState } from "../lib/store";
import type { Dock } from "../lib/terminals";
import { AccessMenu } from "./AccessMenu";
import { type Mode, ModeSwitch } from "./ModeSwitch";
import { TerminalToggle } from "./TerminalDock";

/** Shared floating controls in both modes, without an opaque bar over the canvas. */
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
  return (
    <header className="app-header">
      <div className="app-header-left">
        <span className="sidebar-toggle-slot">{!sidebar && <SidebarToggle open={false} sidebarId={sidebarId} onClick={onSidebar} />}</span>
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
