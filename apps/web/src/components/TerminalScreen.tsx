import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { store } from "../lib/store";
import type { TerminalView } from "../lib/types";

/** The smallest terminal the panel gives a program, however short the panel is. */
const MIN_COLS = 40;
const MIN_ROWS = 8;
/** A panel being dragged taller tells the program its new size once it settles. */
const RESIZE_SETTLE_MS = 120;

/** Colours for a light terminal, readable on the page's background. */
const THEME = {
  background: "#fbfaf7",
  foreground: "#2d3748",
  cursor: "#087f7f",
  cursorAccent: "#fbfaf7",
  selectionBackground: "rgba(21, 159, 159, 0.22)",
  black: "#2d3748",
  red: "#b83b3b",
  green: "#2f7d3c",
  yellow: "#946a1f",
  blue: "#2b6cb0",
  magenta: "#8b46b8",
  cyan: "#087f7f",
  white: "#8a96a8",
  brightBlack: "#718096",
  brightRed: "#c53030",
  brightGreen: "#38a169",
  brightYellow: "#b7791f",
  brightBlue: "#3182ce",
  brightMagenta: "#805ad5",
  brightCyan: "#159f9f",
  brightWhite: "#a0aec0",
};

/** One session's terminal: what it already shows, then what it prints, and, while it runs in a terminal, the user's keys. */
export default function TerminalScreen({ view }: { view: TerminalView }) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  // Whether keys and sizes reach the program; it changes when the session ends, without making a new terminal.
  const live = useRef(view.pty && view.status === "running");
  live.current = view.pty && view.status === "running";

  useEffect(() => {
    const element = box.current!;
    const terminal = new Terminal({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace",
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: live.current,
      disableStdin: !live.current,
      scrollback: 5000,
      theme: THEME,
    });
    term.current = terminal;
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);

    let sent = { cols: view.cols ?? 0, rows: view.rows ?? 0 };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tell = (cols: number, rows: number) => {
      if (!live.current || (cols === sent.cols && rows === sent.rows)) return;
      sent = { cols, rows };
      store.resizeTerminal(view.id, cols, rows);
    };
    /** The terminal fills the panel; a program in a terminal is told its new size. An ended one keeps the size it had. */
    const fitNow = (settle: boolean) => {
      const size = fit.proposeDimensions();
      if (!size || !Number.isFinite(size.cols) || !Number.isFinite(size.rows)) return;
      if (view.pty && !live.current) return;
      const cols = Math.max(MIN_COLS, size.cols);
      const rows = Math.max(MIN_ROWS, size.rows);
      if (cols !== terminal.cols || rows !== terminal.rows) terminal.resize(cols, rows);
      if (!settle) return tell(cols, rows);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => tell(cols, rows), RESIZE_SETTLE_MS);
    };
    // The program learns its size before the page asks for its screen, so the screen comes drawn for this size.
    fitNow(false);
    const unwatch = store.watchTerminal(view.id, {
      replay: (data, size) => {
        terminal.reset();
        if (size && (size.cols !== terminal.cols || size.rows !== terminal.rows)) terminal.resize(size.cols, size.rows);
        terminal.write(data);
      },
      output: (data) => terminal.write(data),
    });
    const keys = terminal.onData((data) => {
      if (live.current) store.terminalInput(view.id, data);
    });
    const observer = new ResizeObserver(() => fitNow(true));
    observer.observe(element);
    if (live.current) terminal.focus();
    return () => {
      if (timer) clearTimeout(timer);
      observer.disconnect();
      keys.dispose();
      unwatch();
      terminal.dispose();
      term.current = null;
    };
  }, [view.id]);

  // A session that ends stops taking keys.
  useEffect(() => {
    if (!term.current) return;
    term.current.options.disableStdin = !live.current;
    term.current.options.cursorBlink = live.current;
  }, [view.status]);

  return <div className="terminal-screen" ref={box} />;
}
