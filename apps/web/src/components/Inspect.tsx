import { ArrowLeft, Database, LayoutDashboard, ListTree, Moon, Sun } from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { type Range, RANGES, type Tab, type Target, inspectHref } from "../lib/observe";
import type { AppState } from "../lib/store";
import { InspectCall } from "./InspectCall";
import { InspectData } from "./InspectData";
import { InspectOverview } from "./InspectOverview";
import { InspectTraces } from "./InspectTraces";
import { POLL_BUSY_MS, POLL_MS, usePolled, useStored } from "./inspect-kit";
import "../inspect.css";

const TABS: { id: Tab; label: string; icon: typeof Database; about: string }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard, about: "Cost, cache, speed and calls" },
  { id: "traces", label: "Traces", icon: ListTree, about: "Every message, step by step" },
  { id: "data", label: "Database", icon: Database, about: "Tables, rows and files" },
];

/**
 * The inspect console (architecture/web.md, "Inspect"): everything Socrates did
 * and what it cost, from totals down to the exact bytes one model was sent.
 * Three tabs: the overview, the traces of single messages, and a read-only
 * look into the databases. It reads what was recorded and changes nothing,
 * except a model's price.
 */
export function Inspect({ app, target }: { app: AppState; target: Target }) {
  const [range, setRange] = useStored<Range>("socrates.inspect.range", "24h", ["24h", "7d", "30d", "all"]);
  const [theme, setTheme] = useStored<"dark" | "light">("socrates.inspect.theme", "dark", ["dark", "light"]);
  const [call, setCall] = useState<string | null>(null);
  const busy = app.model.live?.busy ?? false;
  const ms = busy ? POLL_BUSY_MS : POLL_MS;
  // A light poll that says whether the data is arriving.
  const pulse = usePolled(() => api.observeRecent(1), [], ms);
  const tab = TABS.find((t) => t.id === target.tab)!;
  return (
    <div className="inspect" data-theme={theme}>
      <aside className="rail">
        <a className="brand" href="#/chat" title="Back to the chat"><img src="/favicon.png" alt="" width="26" height="26" /> <span>Socrates<small>Inspect</small></span></a>
        <nav aria-label="Inspect">
          {TABS.map((t) => (
            <a key={t.id} href={inspectHref(t.id)} data-current={t.id === target.tab} aria-current={t.id === target.tab ? "page" : undefined}>
              <t.icon aria-hidden /><span>{t.label}<small>{t.about}</small></span>
            </a>
          ))}
        </nav>
        <div className="rail-foot">
          <button type="button" className="quiet-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>{theme === "dark" ? <Sun aria-hidden /> : <Moon aria-hidden />} {theme === "dark" ? "Light" : "Dark"} console</button>
          <a className="quiet-button" href="#/chat"><ArrowLeft aria-hidden /> Back to chat</a>
        </div>
      </aside>
      <div className="inspect-main">
        <header className="topbar">
          <h1>{tab.label}</h1>
          <span className="live" data-busy={busy} data-stale={!!pulse.error} role="status">
            <i aria-hidden />{pulse.error ? "Cannot reach Socrates" : busy ? "Socrates is working" : "Idle"}
            {pulse.at && !pulse.error && <small>updated {pulse.at.toLocaleTimeString()}</small>}
          </span>
          {target.tab !== "data" && (
            <div className="range-tabs" role="radiogroup" aria-label="Time range">
              {RANGES.map((r) => <button key={r.id} type="button" role="radio" aria-checked={range === r.id} data-on={range === r.id} onClick={() => setRange(r.id)}>{r.label}</button>)}
            </div>
          )}
        </header>
        <main className="inspect-body">
          {target.tab === "overview" && <InspectOverview range={range} ms={ms} onCall={setCall} />}
          {target.tab === "traces" && <InspectTraces question={target.question} range={range} ms={ms} onCall={setCall} />}
          {target.tab === "data" && <InspectData db={target.db} table={target.table} ms={ms} onCall={setCall} />}
        </main>
      </div>
      {call && <InspectCall id={call} onClose={() => setCall(null)} />}
    </div>
  );
}
