"use client";

import { ChevronRight, Clipboard, Copy, GripVertical, Pencil, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationTerminal } from "@socrates/contracts";

type TerminalInputKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape" | "Ctrl-C";

interface TerminalPanelProps {
  terminals: ConversationTerminal[];
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onResizePanel: (width: number) => void;
  onStop: (terminalId: string) => void;
  onInput: (terminalId: string, input: { data?: string; text?: string; key?: TerminalInputKey; submit?: boolean }) => void;
  onResize: (terminalId: string, size: { cols: number; rows: number }) => void;
  onRename: (terminalId: string, name: string) => void;
}

export function TerminalPanel({ terminals, isCollapsed, onToggleCollapsed, onResizePanel, onStop, onInput, onResize, onRename }: TerminalPanelProps) {
  const visibleTerminals = useMemo(
    () =>
      [...terminals]
        .sort((a, b) => {
          const startedDelta = Date.parse(b.startedAt) - Date.parse(a.startedAt);
          return startedDelta === 0 ? a.name.localeCompare(b.name) : startedDelta;
        })
        .slice(0, 6),
    [terminals],
  );
  const [activeTerminalId, setActiveTerminalId] = useState<string | undefined>(visibleTerminals[0]?.terminalId);
  const runningCount = visibleTerminals.filter((terminal) => terminal.status === "running" || terminal.status === "awaiting_input").length;
  const awaitingInputCount = visibleTerminals.filter((terminal) => terminal.status === "awaiting_input" || terminal.awaitingInput).length;
  const selectedTerminalId = activeTerminalId && visibleTerminals.some((terminal) => terminal.terminalId === activeTerminalId) ? activeTerminalId : visibleTerminals[0]?.terminalId;
  const activeTerminal = visibleTerminals.find((terminal) => terminal.terminalId === selectedTerminalId);

  if (visibleTerminals.length === 0) {
    return null;
  }

  if (isCollapsed) {
    return (
      <aside className="flex h-12 min-w-0 shrink-0 items-center gap-3 overflow-hidden border-t border-gray-200 bg-gray-50 px-3 lg:h-auto lg:w-full lg:flex-col lg:border-l lg:border-t-0 lg:px-0">
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md border border-gray-200 bg-white text-brand-text-light shadow-sm hover:text-brand-text-dark lg:mt-3"
          title="Show terminals"
          onClick={onToggleCollapsed}
        >
          <SquareTerminal className="size-4" />
        </button>
        <div className="flex items-center gap-2 text-[10px] font-medium text-brand-text-light lg:mt-3 lg:flex-col">
          <span className="rounded-full bg-white px-1.5 py-0.5 shadow-sm">{visibleTerminals.length}</span>
          {runningCount > 0 ? <span className="size-2 rounded-full bg-brand-teal-dark" title={`${runningCount} running`} /> : null}
          {awaitingInputCount > 0 ? <span className="size-2 rounded-full bg-amber-500" title={`${awaitingInputCount} awaiting input`} /> : null}
        </div>
      </aside>
    );
  }

  return (
    <aside className="relative flex max-h-[50vh] min-w-0 w-full shrink-0 flex-col overflow-hidden border-t border-gray-200 bg-gray-950 lg:max-h-none lg:border-l lg:border-t-0">
      <PanelResizeHandle onResizePanel={onResizePanel} />
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-800 bg-gray-900 px-4">
        <div className="flex size-8 items-center justify-center rounded-md bg-gray-950 text-white ring-1 ring-white/10">
          <SquareTerminal className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-gray-100">Terminal</h2>
            {runningCount > 0 ? <StatusPill tone="running" label={`${runningCount} running`} /> : null}
            {awaitingInputCount > 0 ? <StatusPill tone="input" label={`${awaitingInputCount} input`} /> : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-gray-400">Conversation-scoped PTY sessions</p>
        </div>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-gray-700 text-gray-400 hover:bg-gray-800 hover:text-gray-100"
          title="Collapse terminals"
          onClick={onToggleCollapsed}
        >
          <ChevronRight className="size-4" />
        </button>
      </header>
      <div className="flex min-h-0 shrink-0 gap-1 overflow-x-auto border-b border-gray-800 bg-gray-900 px-2 py-2">
        {visibleTerminals.map((terminal) => {
              const active = terminal.terminalId === selectedTerminalId;
          return (
            <button
              key={terminal.terminalId}
              type="button"
              className={`flex max-w-44 shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs ${
                active ? "bg-gray-800 text-gray-50" : "text-gray-400 hover:bg-gray-800/60 hover:text-gray-100"
              }`}
              title={terminal.name}
              onClick={() => setActiveTerminalId(terminal.terminalId)}
            >
              <span className={`size-1.5 shrink-0 rounded-full ${statusDotClass(terminal.status)}`} />
              <span className="truncate">{terminal.name}</span>
            </button>
          );
        })}
      </div>
      {activeTerminal ? (
        <TerminalPane
          key={activeTerminal.terminalId}
          terminal={activeTerminal}
          onStop={onStop}
          onInput={onInput}
          onResize={onResize}
          onRename={onRename}
        />
      ) : null}
    </aside>
  );
}

function PanelResizeHandle({ onResizePanel }: { onResizePanel: (width: number) => void }) {
  return (
    <div
      className="group absolute left-0 top-0 hidden h-full w-2 -translate-x-1 cursor-col-resize items-center justify-center lg:flex"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize terminal panel"
      onMouseDown={(event) => {
        event.preventDefault();
        const onMove = (moveEvent: MouseEvent) => {
          onResizePanel(Math.min(Math.max(window.innerWidth - moveEvent.clientX, 320), 720));
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }}
    >
      <div className="flex h-12 w-1 items-center justify-center rounded-full bg-transparent text-gray-600 transition group-hover:bg-gray-700 group-hover:text-gray-300">
        <GripVertical className="size-3" />
      </div>
    </div>
  );
}

function TerminalPane({
  terminal,
  onStop,
  onInput,
  onResize,
  onRename,
}: {
  terminal: ConversationTerminal;
  onStop: TerminalPanelProps["onStop"];
  onInput: TerminalPanelProps["onInput"];
  onResize: TerminalPanelProps["onResize"];
  onRename: TerminalPanelProps["onRename"];
}) {
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(terminal.name);
  const replay = terminal.output.pty ?? `${terminal.output.stdout}${terminal.output.stderr ? `\n${terminal.output.stderr}` : ""}`;
  const canStop = terminal.status === "running" || terminal.status === "awaiting_input";

  const commitName = () => {
    const next = nameDraft.trim();
    if (next && next !== terminal.name) {
      onRename(terminal.terminalId, next);
    }
    setEditingName(false);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-gray-800 bg-gray-950 px-3">
        {editingName ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              commitName();
            }}
          >
            <input
              className="h-7 min-w-0 flex-1 rounded-md border border-gray-700 bg-gray-900 px-2 font-mono text-xs text-gray-100 outline-none focus:border-teal-400"
              value={nameDraft}
              onChange={(event) => setNameDraft(event.target.value)}
              onBlur={commitName}
              autoFocus
            />
          </form>
        ) : (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left font-mono text-xs text-gray-200"
            title="Rename terminal"
            onClick={() => {
              setNameDraft(terminal.name);
              setEditingName(true);
            }}
          >
            <span className="truncate">{terminal.name}</span>
            <Pencil className="size-3.5 shrink-0 text-gray-500" />
          </button>
        )}
        <span className="hidden min-w-0 flex-1 truncate text-[11px] text-gray-500 xl:block">{terminal.command}</span>
        <TerminalControls terminal={terminal} replay={replay} canStop={canStop} onStop={onStop} onInput={onInput} />
      </div>
      <XtermSurface terminal={terminal} replay={replay} onInput={onInput} onResize={onResize} />
    </div>
  );
}

function TerminalControls({
  terminal,
  replay,
  canStop,
  onStop,
  onInput,
}: {
  terminal: ConversationTerminal;
  replay: string;
  canStop: boolean;
  onStop: TerminalPanelProps["onStop"];
  onInput: TerminalPanelProps["onInput"];
}) {
  const [clearNonce, setClearNonce] = useState(0);
  const didMountRef = useRef(false);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    window.dispatchEvent(new CustomEvent("socrates-terminal-clear", { detail: { terminalId: terminal.terminalId, nonce: clearNonce } }));
  }, [clearNonce, terminal.terminalId]);

  return (
    <div className="flex shrink-0 items-center gap-1">
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-gray-100"
        title="Copy terminal text"
        onClick={() => void navigator.clipboard?.writeText(replay)}
      >
        <Copy className="size-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-gray-100"
        title="Paste from clipboard"
        onClick={() => {
          void navigator.clipboard?.readText().then((text) => {
            if (text) {
              onInput(terminal.terminalId, { data: text });
            }
          });
        }}
      >
        <Clipboard className="size-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-gray-400 hover:bg-gray-800 hover:text-gray-100"
        title="Clear display"
        onClick={() => setClearNonce((value) => value + 1)}
      >
        <Trash2 className="size-3.5" />
      </button>
      {canStop ? (
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-gray-400 hover:bg-red-500/10 hover:text-red-300"
          title="Stop terminal"
          onClick={() => onStop(terminal.terminalId)}
        >
          <Square className="size-3.5" />
        </button>
      ) : (
        <X className="size-3.5 text-gray-600" aria-hidden />
      )}
    </div>
  );
}

function XtermSurface({
  terminal,
  replay,
  onInput,
  onResize,
}: {
  terminal: ConversationTerminal;
  replay: string;
  onInput: TerminalPanelProps["onInput"];
  onResize: TerminalPanelProps["onResize"];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const writtenRef = useRef("");
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const replayRef = useRef(replay);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);

  useEffect(() => {
    replayRef.current = replay;
    inputRef.current = onInput;
    resizeRef.current = onResize;
  }, [onInput, onResize, replay]);

  useEffect(() => {
    let disposed = false;
    let resizeObserver: ResizeObserver | undefined;

    const boot = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit")]);
      if (disposed || !containerRef.current) {
        return;
      }
      const xterm = new Terminal({
        convertEol: true,
        cursorBlink: true,
        fontFamily: "var(--font-mono), ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.2,
        scrollback: 5_000,
        theme: {
          background: "#030712",
          foreground: "#e5e7eb",
          cursor: "#5eead4",
          selectionBackground: "#155e75",
          black: "#111827",
          red: "#f87171",
          green: "#34d399",
          yellow: "#fbbf24",
          blue: "#60a5fa",
          magenta: "#c084fc",
          cyan: "#22d3ee",
          white: "#f9fafb",
          brightBlack: "#6b7280",
          brightRed: "#fca5a5",
          brightGreen: "#6ee7b7",
          brightYellow: "#fde68a",
          brightBlue: "#93c5fd",
          brightMagenta: "#d8b4fe",
          brightCyan: "#67e8f9",
          brightWhite: "#ffffff",
        },
      });
      const fit = new FitAddon();
      xterm.loadAddon(fit);
      xterm.open(containerRef.current);
      xterm.write(replayRef.current);
      writtenRef.current = replayRef.current;
      terminalRef.current = xterm;
      fitRef.current = fit;
      xterm.onData((data) => inputRef.current(terminal.terminalId, { data }));

      const fitAndNotify = () => {
        try {
          fit.fit();
        } catch {
          return;
        }
        const size = { cols: xterm.cols, rows: xterm.rows };
        if (size.cols > 0 && size.rows > 0 && (sizeRef.current?.cols !== size.cols || sizeRef.current?.rows !== size.rows)) {
          sizeRef.current = size;
          resizeRef.current(terminal.terminalId, size);
        }
      };
      resizeObserver = new ResizeObserver(fitAndNotify);
      resizeObserver.observe(containerRef.current);
      requestAnimationFrame(fitAndNotify);
    };

    void boot();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      terminalRef.current?.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      writtenRef.current = "";
      sizeRef.current = null;
    };
  }, [terminal.terminalId]);

  useEffect(() => {
    const xterm = terminalRef.current;
    if (!xterm) {
      return;
    }
    const written = writtenRef.current;
    if (replay.startsWith(written)) {
      const delta = replay.slice(written.length);
      if (delta) {
        xterm.write(delta);
        writtenRef.current = replay;
      }
      return;
    }
    xterm.reset();
    xterm.write(replay);
    writtenRef.current = replay;
  }, [replay]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ terminalId?: string }>).detail;
      if (detail?.terminalId !== terminal.terminalId) {
        return;
      }
      terminalRef.current?.clear();
      writtenRef.current = replay;
    };
    window.addEventListener("socrates-terminal-clear", handler);
    return () => window.removeEventListener("socrates-terminal-clear", handler);
  }, [replay, terminal.terminalId]);

  return <div ref={containerRef} className="min-h-[18rem] flex-1 overflow-hidden bg-gray-950 p-2" />;
}

function StatusPill({ tone, label }: { tone: "running" | "input"; label: string }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${pillClass(tone)}`}>{label}</span>;
}

function pillClass(tone: "running" | "input"): string {
  if (tone === "running") {
    return "bg-teal-400/10 text-teal-300";
  }
  return "bg-amber-400/10 text-amber-300";
}

function statusDotClass(status: ConversationTerminal["status"]): string {
  if (status === "running") {
    return "bg-teal-400";
  }
  if (status === "awaiting_input") {
    return "bg-amber-400";
  }
  if (status === "exited") {
    return "bg-gray-500";
  }
  if (status === "stopped") {
    return "bg-red-400";
  }
  return "bg-gray-600";
}
