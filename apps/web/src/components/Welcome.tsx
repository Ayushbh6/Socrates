import { ArrowRight } from "lucide-react";
import type { AppState } from "../lib/store";

/**
 * Socrates' front door (`#/welcome`): one button. Someone who has not been
 * through onboarding goes to it from here; everyone else goes to the chat.
 */
export function Welcome({ app, onOpen, onOnboard }: { app: AppState; onOpen: () => void; onOnboard: () => void }) {
  const status = app.status;
  const onboarded = status?.profile.onboarded ?? false;
  const ready = status?.ready ?? false;
  const name = status?.profile.name;
  return (
    <main className="welcome">
      <p className="welcome-eyebrow">Your thinking workspace</p>
      <h1 className="welcome-title">Socrates</h1>
      <p className="welcome-motto">Think clearly. Ask well. Live examined.</p>
      {app.error ? (
        <p className="welcome-sub">Socrates could not load: {app.error}</p>
      ) : !status ? (
        <p className="welcome-sub">Waking Socrates…</p>
      ) : !onboarded ? (
        <>
          <p className="welcome-sub">A minute to set things up, and we begin.</p>
          <button type="button" className="welcome-button" onClick={onOnboard} autoFocus>
            Get started <ArrowRight aria-hidden />
          </button>
        </>
      ) : ready ? (
        <>
          <p className="welcome-sub">{name ? `Welcome back, ${name}.` : status.workingFolder ? `Working in ${status.workingFolder.name}.` : "Ready when you are."}</p>
          <button type="button" className="welcome-button" onClick={onOpen} autoFocus>
            Chat with Socrates <ArrowRight aria-hidden />
          </button>
        </>
      ) : (
        <>
          <p className="welcome-sub">{status.setup[0] ?? "Socrates needs a little setup."}</p>
          <button type="button" className="welcome-button" onClick={onOnboard} autoFocus>
            Fix the setup <ArrowRight aria-hidden />
          </button>
        </>
      )}
    </main>
  );
}
