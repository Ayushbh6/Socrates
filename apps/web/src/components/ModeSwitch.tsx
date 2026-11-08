import { Activity, Settings as Gear, Moon, Sun } from "lucide-react";
import { toggleTheme, useTheme } from "../lib/theme";

export type Mode = "flow" | "standard";

/** Flow or Standard, and the way to settings: the same in both modes' headers. */
export function ModeSwitch({ mode, onMode, onSettings }: { mode: Mode; onMode: (mode: Mode) => void; onSettings: () => void }) {
  const { theme } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <div className="mode-controls">
      <div className="mode-switch" role="radiogroup" aria-label="Layout">
        {(["flow", "standard"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} data-on={mode === m} onClick={() => onMode(m)}>
            {m === "flow" ? "Flow" : "Standard"}
          </button>
        ))}
      </div>
      <a className="icon-button" href="#/inspect" aria-label="Inspect" title="Inspect: cost, cache and every model call">
        <Activity aria-hidden />
      </a>
      <button type="button" className="icon-button theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
        {theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />}
      </button>
      <button type="button" className="icon-button" onClick={onSettings} aria-label="Settings" title="Settings">
        <Gear aria-hidden />
      </button>
    </div>
  );
}
