import { useEffect, useState } from "react";
import { Flow } from "./components/Flow";
import { Welcome } from "./components/Welcome";
import { store, useApp } from "./lib/store";

const routeOf = () => (location.hash === "#/chat" ? "chat" : "welcome");

/** The welcome page, then the flow canvas once Socrates is ready (architecture/web.md). */
export function App() {
  const app = useApp();
  const [route, setRoute] = useState(routeOf);
  useEffect(() => {
    void store.start();
    const follow = () => setRoute(routeOf());
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);
  // A short restart after a settings change keeps the canvas; only missing setup returns to the welcome page.
  if (route === "chat" && app.status && (app.status.ready || !app.status.setup.length)) return <Flow app={app} />;
  return <Welcome app={app} onOpen={() => (location.hash = "#/chat")} />;
}
