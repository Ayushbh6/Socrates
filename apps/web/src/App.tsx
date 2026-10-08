import { useEffect, useState } from "react";
import { Flow } from "./components/Flow";
import { Inspect } from "./components/Inspect";
import { type Mode } from "./components/ModeSwitch";
import { Onboarding } from "./components/Onboarding";
import { SettingsDialog } from "./components/SettingsDialog";
import { Standard } from "./components/Standard";
import { Welcome } from "./components/Welcome";
import { inspectTarget } from "./lib/observe";
import { useDock } from "./lib/terminals";
import { store, useApp } from "./lib/store";

export type Route = "welcome" | "onboarding" | "chat";

/** `#/chat` and `#/onboarding`; anything else is the welcome page. */
export const routeOf = (hash: string): Route => (hash === "#/chat" ? "chat" : hash === "#/onboarding" ? "onboarding" : "welcome");

/**
 * Whether someone must go through onboarding before the chat: they never
 * finished it, or setup is missing again (a key was removed). A short restart
 * after a settings change keeps the canvas, so only missing setup counts.
 */
export function needsOnboarding(status: { ready: boolean; setup: string[]; profile: { onboarded: boolean } } | null): boolean {
  return !!status && (!status.profile.onboarded || (!status.ready && status.setup.length > 0));
}

/** The welcome page, onboarding the first time, then flow or standard mode (architecture/web.md). */
export function App() {
  const app = useApp();
  const [route, setRoute] = useState(() => routeOf(location.hash));
  const [hash, setHash] = useState(() => location.hash);
  const [mode, setMode] = useState<Mode>("flow");
  const [settings, setSettings] = useState(false);
  // The terminal panel stays as it is across a switch between flow and standard.
  const dock = useDock(app.terminals);
  useEffect(() => {
    void store.start();
    const follow = () => { setRoute(routeOf(location.hash)); setHash(location.hash); };
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  // The chat is not open to someone who has not been through onboarding.
  const blocked = route === "chat" && needsOnboarding(app.status);
  useEffect(() => {
    if (blocked) location.replace("#/onboarding");
  }, [blocked]);
  // The inspect page needs no onboarding: it only reads what Socrates has recorded.
  const inspecting = inspectTarget(hash);
  if (inspecting && app.status) return <Inspect app={app} target={inspecting} />;
  if (route === "chat" && app.status && !blocked) {
    const props = { app, mode, dock, onMode: setMode, onSettings: () => setSettings(true) };
    return (
      <>
        {mode === "standard" ? <Standard {...props} /> : <Flow {...props} />}
        {settings && <SettingsDialog app={app} onClose={() => setSettings(false)} />}
      </>
    );
  }
  if (route === "onboarding" && app.status) return <Onboarding app={app} onDone={() => (location.hash = "#/chat")} />;
  return <Welcome app={app} onOpen={() => (location.hash = "#/chat")} onOnboard={() => (location.hash = "#/onboarding")} />;
}
