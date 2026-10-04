import { Square, X } from "lucide-react";
import { conversationBusy, currentRoute } from "../lib/model";
import { type AppState, store } from "../lib/store";
import type { Lane } from "../lib/types";
import { AccessMenu } from "./AccessMenu";
import { Composer } from "./Composer";
import { GoalsPanel } from "./GoalsPanel";
import { type Mode, ModeSwitch } from "./ModeSwitch";
import { Notices } from "./Notices";
import { Thread } from "./Thread";

/**
 * Standard mode (architecture/web.md, "Standard mode"): goals on the left, the
 * whole main conversation in the middle, and each lane in its own panel.
 */
export function Standard({ app, mode, onMode, onSettings }: { app: AppState; mode: Mode; onMode: (mode: Mode) => void; onSettings: () => void }) {
  const lanes = app.model.live?.lanes ?? app.status?.lanes ?? [];
  const route = currentRoute(app.model.conversations.main ?? []);
  const side = lanes.length > 0 || app.model.pending.length > 0;
  const mainBusy = conversationBusy(app.model.live, "main");

  return (
    <div className="standard" data-lanes={side}>
      <header className="standard-header">
        <span className="brand">Socrates</span>
        <AccessMenu app={app} />
        {!app.connected ? <span className="chip reconnecting">Reconnecting…</span> : app.model.live && !app.model.live.ready && <span className="chip reconnecting">Socrates is restarting…</span>}
        <span className="composer-space" />
        <ModeSwitch mode={mode} onMode={onMode} onSettings={onSettings} />
      </header>

      <GoalsPanel goals={app.goals} route={route} />

      <section className="panel main-panel" aria-label="Main conversation">
        <div className="panel-head">
          <strong>Main</strong>
          {route && <small>g{route.goal.number}/t{route.task.number} · {route.task.title}</small>}
          <span className="composer-space" />
          {mainBusy && <button type="button" className="quiet-button" onClick={() => store.cancel("main")}><Square aria-hidden /> Stop</button>}
        </div>
        <Thread app={app} conversation="main" empty="Ask Socrates anything to begin." />
        <Composer app={app} conversation="main" laneNumber={null} variant="panel" onModel={onSettings} onNewLane={(text, attachments) => store.sendToNewLane(text, attachments)} />
      </section>

      {side && (
        <div className="lanes-column" aria-label="Lanes">
          {lanes.map((lane) => <LanePanel key={lane.id} app={app} lane={lane} />)}
          {app.model.pending.map((e) => (
            <section key={e.key} className="panel lane-panel">
              <div className="panel-head"><strong>New lane</strong><small>starting…</small></div>
              <Thread app={app} conversation={`pending:${e.key}`} extra={[e]} compact empty="" />
            </section>
          ))}
        </div>
      )}

      <Notices app={app} />
    </div>
  );
}

function LanePanel({ app, lane }: { app: AppState; lane: Lane }) {
  const route = currentRoute(app.model.conversations[lane.id] ?? []);
  const state = lane.waitingForApproval ? "waiting for you" : lane.running ? "working" : "idle";
  return (
    <section className="panel lane-panel" aria-label={`Lane ${lane.number}`}>
      <div className="panel-head">
        <span className="lane-dot" data-running={lane.running} data-waiting={lane.waitingForApproval} />
        <strong>Lane {lane.number}</strong>
        <small title={route?.task.title}>{route ? route.task.title : state}</small>
        <span className="composer-space" />
        {route && <small>{state}</small>}
        {lane.running ? (
          <button type="button" className="icon-button" onClick={() => store.cancel(lane.id)} aria-label={`Stop lane ${lane.number}`} title="Stop"><Square aria-hidden /></button>
        ) : (
          <button type="button" className="icon-button" onClick={() => store.closeLane(lane.id)} aria-label={`Close lane ${lane.number}`} title="Close this lane"><X aria-hidden /></button>
        )}
      </div>
      <Thread app={app} conversation={lane.id} compact empty={`Lane ${lane.number} is ready.`} />
      <Composer app={app} conversation={lane.id} laneNumber={lane.number} variant="panel" compact autoFocus={false} onNewLane={(text, attachments) => store.sendToNewLane(text, attachments)} />
    </section>
  );
}
