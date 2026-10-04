import { useEffect, useState } from "react";
import { Flow } from "./components/Flow";
import { type Mode, saveMode, storedMode } from "./components/ModeSwitch";
import { SettingsDialog } from "./components/SettingsDialog";
import { Standard } from "./components/Standard";
import { Welcome } from "./components/Welcome";
import { store, useApp } from "./lib/store";

const routeOf = () => (location.hash === "#/chat" ? "chat" : "welcome");

/** The welcome page, then flow or standard mode once Socrates is ready (architecture/web.md). */
export function App() {
  const app = useApp();
  const [route, setRoute] = useState(routeOf);
  const [mode, setMode] = useState<Mode>(storedMode);
  const [settings, setSettings] = useState(false);
  useEffect(() => {
    void store.start();
    const follow = () => setRoute(routeOf());
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  const changeMode = (next: Mode) => {
    saveMode(next);
    setMode(next);
  };
  // A short restart after a settings change keeps the canvas; only missing setup returns to the welcome page.
  if (route === "chat" && app.status && (app.status.ready || !app.status.setup.length)) {
    const props = { app, mode, onMode: changeMode, onSettings: () => setSettings(true) };
    return (
      <>
        {mode === "standard" ? <Standard {...props} /> : <Flow {...props} />}
        {settings && <SettingsDialog app={app} onClose={() => setSettings(false)} />}
      </>
    );
  }
  return <Welcome app={app} onOpen={() => (location.hash = "#/chat")} />;
}
