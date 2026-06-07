"use client";

import { ChevronRight, Clipboard, Copy, GripVertical, Info, Maximize2, Pencil, Square, SquareTerminal, Trash2, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationTerminal } from "@socrates/contracts";

type TerminalInputKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape" | "Ctrl-C";

const MIN_TERMINAL_PANEL_WIDTH = 320;
const MAX_TERMINAL_PANEL_WIDTH = 720;
const MIN_DOCK_HEIGHT = 220;
const MAX_DOCK_HEIGHT = 760;

interface TerminalPanelProps {
  terminals: ConversationTerminal[];
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onResizePanel: (width: number) => void;
  onStop: (terminalId: string) => void;
  onRename: (terminalId: string, name: string) => void;
  onOpenInDock: (terminalId: string) => void;
}

interface TerminalDockPanelProps {
  terminals: ConversationTerminal[];
  isOpen: boolean;
  isMobile: boolean;
  activeTerminalId: string | undefined;
  onActiveTerminalIdChange: (terminalId: string) => void;
  onClose: () => void;
  onStop: (terminalId: string) => void;
  onInput: (terminalId: string, input: { data?: string; text?: string; key?: TerminalInputKey; submit?: boolean }) => void;
  onResize: (terminalId: string, size: { cols: number; rows: number }) => void;
  dockHeight: number;
  onResizeDock: (height: number) => void;
  rightInset: number;
}

export function TerminalPanel({ terminals, isCollapsed, onToggleCollapsed, onResizePanel, onStop, onRename, onOpenInDock }: TerminalPanelProps) {
  const terminalCount = terminals.length;
  const visibleTerminals = useMemo(
    () =>
      [...terminals]
        .sort((a, b) => {
          const startedDelta = Date.parse(b.startedAt) - Date.parse(a.startedAt);
          return startedDelta === 0 ? a.name.localeCompare(b.name) : startedDelta;
        })
        .slice(0, 12),
    [terminals],
  );
  const [detailsTerminalId, setDetailsTerminalId] = useState<string | undefined>(undefined);
  const runningCount = terminals.filter((terminal) => terminal.status === "running" || terminal.status === "awaiting_input").length;
  const awaitingInputCount = terminals.filter((terminal) => terminal.status === "awaiting_input" || terminal.awaitingInput).length;

  if (visibleTerminals.length === 0) {
    return null;
  }

  if (isCollapsed) {
    return (
      <aside className="hidden shrink-0 border-l border-gray-200 bg-white p-3 opacity-95 lg:flex lg:w-[3rem] lg:flex-col lg:items-center lg:gap-3">
        <button
          type="button"
          className="inline-flex size-9 items-center justify-center rounded-md border border-gray-200 bg-white text-brand-text-light shadow-sm transition hover:text-brand-text-dark"
          title="Show terminals"
          onClick={onToggleCollapsed}
        >
          <SquareTerminal className="size-4" />
        </button>
        <div className="flex flex-col items-center gap-2 text-[10px] font-medium text-brand-text-light">
          <span className="rounded-full border border-gray-200 px-1.5 py-0.5 text-[11px]">{terminalCount}</span>
          {runningCount > 0 ? <span className="size-2 rounded-full bg-brand-teal-dark" title={`${runningCount} running`} /> : null}
          {awaitingInputCount > 0 ? <span className="size-2 rounded-full bg-amber-500" title={`${awaitingInputCount} awaiting input`} /> : null}
        </div>
      </aside>
    );
  }

  return (
    <aside className="relative flex min-w-0 flex-col overflow-hidden border-l border-gray-200 bg-white transition-all duration-200">
      <PanelResizeHandle onResizePanel={onResizePanel} />
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4">
        <div className="inline-flex size-8 items-center justify-center rounded-md bg-brand-bg text-brand-text-light">
          <SquareTerminal className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-brand-text-dark">Terminal</h2>
            {runningCount > 0 ? <StatusPill tone="running" label={`${runningCount} running`} /> : null}
            {awaitingInputCount > 0 ? <StatusPill tone="input" label={`${awaitingInputCount} input`} /> : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-brand-text-light">Conversation-scoped PTY sessions</p>
        </div>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-gray-200 text-brand-text-light hover:bg-gray-100 hover:text-brand-text-dark"
          title="Collapse terminal rail"
          onClick={onToggleCollapsed}
        >
          <ChevronRight className="size-4" />
        </button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-auto p-2">
        <div className="space-y-1">
          {visibleTerminals.map((terminal) => (
            <article key={terminal.terminalId} className="rounded-lg border border-gray-100 bg-gray-50 p-2 transition hover:border-gray-300">
              <div className="flex items-start gap-2">
                <span className={`mt-1 size-2 shrink-0 rounded-full ${statusDotClass(terminal.status)}`} />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="w-full text-left"
                    onClick={() => onOpenInDock(terminal.terminalId)}
                    title={terminal.name}
                  >
                    <p className="truncate text-sm font-medium text-brand-text-dark">{terminal.name}</p>
                  </button>
                  <p className="mt-0.5 truncate text-xs text-brand-text-light">{terminal.status}</p>
                </div>
                <button
                  type="button"
                  className="inline-flex size-7 items-center justify-center rounded-md border border-transparent text-brand-text-light transition hover:bg-white hover:text-brand-text-dark"
                  title="Open in dock"
                  onClick={() => onOpenInDock(terminal.terminalId)}
                >
                  <Maximize2 className="size-3.5" />
                </button>
              </div>

              <div className="mt-2 flex items-center justify-between gap-1">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-brand-text-light transition hover:bg-white hover:text-brand-text-dark"
                  title="Terminal details"
                  onClick={() =>
                    setDetailsTerminalId((current) => (current === terminal.terminalId ? undefined : terminal.terminalId))
                  }
                >
                  <Info className="size-3.5" />
                  <span>Details</span>
                </button>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded-md text-brand-text-light transition hover:text-brand-text-dark"
                    title="Copy command"
                    onClick={() => {
                      void navigator.clipboard?.writeText(`${terminal.command}\n${terminal.cwd}`);
                    }}
                  >
                    <Copy className="size-3.5" />
                  </button>
                  <RenameButton terminal={terminal} onRename={onRename} />
                  {(terminal.status === "running" || terminal.status === "awaiting_input") ? (
                    <button
                      type="button"
                      className="inline-flex size-7 items-center justify-center rounded-md text-rose-500 transition hover:bg-rose-50"
                      title="Stop terminal"
                      onClick={() => onStop(terminal.terminalId)}
                    >
                      <Square className="size-3.5" />
                    </button>
                  ) : null}
                </div>
              </div>

              {detailsTerminalId === terminal.terminalId ? (
                <div className="mt-2 rounded-md border border-gray-200 bg-white p-2 text-xs text-brand-text-dark">
                  <div className="font-medium text-brand-text-light">Command</div>
                  <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap break-all rounded-md border border-gray-100 bg-brand-bg p-2 text-[11px] leading-5 text-brand-text-dark">
                    {terminal.command}
                  </pre>
                  <div className="mt-2 font-medium text-brand-text-light">Working Directory</div>
                  <p className="mt-1 truncate rounded-md border border-gray-100 bg-brand-bg px-2 py-1 text-[11px] text-brand-text-dark">{terminal.cwd}</p>
                  <div className="mt-2 flex justify-between gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-gray-200 px-2 py-1 text-[11px] text-brand-text-light transition hover:bg-white hover:text-brand-text-dark"
                      onClick={() => onOpenInDock(terminal.terminalId)}
                    >
                      Open in dock
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-gray-200 px-2 py-1 text-[11px] text-brand-text-light transition hover:bg-white hover:text-brand-text-dark"
                      onClick={() =>
                        void navigator.clipboard?.writeText(`${terminal.command}\n${terminal.cwd}`)
                      }
                    >
                      Copy details
                    </button>
                  </div>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </aside>
  );
}

export function TerminalDockPanel({
  terminals,
  isOpen,
  isMobile,
  activeTerminalId,
  onActiveTerminalIdChange,
  onClose,
  onStop,
  onInput,
  onResize,
  dockHeight,
  onResizeDock,
  rightInset,
}: TerminalDockPanelProps) {
  const sortedTerminals = useMemo(
    () =>
      [...terminals]
        .sort((a, b) => {
          const startedDelta = Date.parse(b.startedAt) - Date.parse(a.startedAt);
          return startedDelta === 0 ? a.name.localeCompare(b.name) : startedDelta;
        })
        .slice(0, 20),
    [terminals],
  );
  const selectedTerminalId =
    sortedTerminals.some((terminal) => terminal.terminalId === activeTerminalId) ? activeTerminalId : sortedTerminals[0]?.terminalId;
  const activeTerminal = sortedTerminals.find((terminal) => terminal.terminalId === selectedTerminalId);
  const runningCount = sortedTerminals.filter((terminal) => terminal.status === "running" || terminal.status === "awaiting_input").length;

  useEffect(() => {
    if (isOpen && selectedTerminalId && selectedTerminalId !== activeTerminalId) {
      onActiveTerminalIdChange(selectedTerminalId);
    }
  }, [isOpen, selectedTerminalId, activeTerminalId, onActiveTerminalIdChange]);

  if (!isOpen || sortedTerminals.length === 0 || !activeTerminal) {
    return null;
  }

  const panelStyle: CSSProperties = isMobile
    ? { inset: 0 }
    : {
        height: `${Math.min(Math.max(dockHeight, MIN_DOCK_HEIGHT), MAX_DOCK_HEIGHT)}px`,
        right: `${rightInset}px`,
        left: 0,
        bottom: 0,
        width: `calc(100vw - ${rightInset}px)`,
      };

  return (
    <aside
      className={`fixed z-40 border-t border-gray-200 bg-white shadow-2xl ${isMobile ? "left-0 inset-y-0" : ""}`}
      style={panelStyle}
    >
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden border-l border-gray-200 bg-white">
        {isMobile ? null : (
          <DockHeightHandle
            onResizeHeight={(nextHeight) => {
              onResizeDock(Math.min(Math.max(nextHeight, MIN_DOCK_HEIGHT), MAX_DOCK_HEIGHT));
            }}
          />
        )}

        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4">
          <div className="inline-flex size-8 items-center justify-center rounded-md bg-brand-bg text-brand-text-light">
            <SquareTerminal className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-brand-text-dark">Terminal Dock</h2>
              {runningCount > 0 ? <StatusPill tone="running" label={`${runningCount} running`} /> : null}
            </div>
            <p className="mt-0.5 truncate text-xs text-brand-text-light">Session control + interaction</p>
          </div>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-md border border-gray-200 text-brand-text-light transition hover:bg-gray-100 hover:text-brand-text-dark"
            title="Close terminal dock"
            onClick={onClose}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-h-0 w-52 shrink-0 flex-col border-r border-gray-200">
            <div className="bg-brand-bg/60 border-b border-gray-200 px-2 py-2 text-xs font-medium text-brand-text-light">Sessions</div>
            <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2">
              {sortedTerminals.map((terminal) => {
                const isSelected = terminal.terminalId === selectedTerminalId;
                return (
                  <button
                    key={terminal.terminalId}
                    type="button"
                    className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
                      isSelected ? "bg-brand-teal-light text-brand-text-dark" : "text-brand-text-light hover:bg-gray-100"
                    }`}
                    onClick={() => onActiveTerminalIdChange(terminal.terminalId)}
                    title={terminal.name}
                  >
                    <span className={`size-2 shrink-0 rounded-full ${statusDotClass(terminal.status)}`} />
                    <span className="truncate">{terminal.name}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            <TerminalDockControls
              terminal={activeTerminal}
              onStop={onStop}
              onInput={onInput}
              replay={activeTerminal.output.pty ?? `${activeTerminal.output.stdout}${activeTerminal.output.stderr ? `\n${activeTerminal.output.stderr}` : ""}`}
            />
            <XtermSurface terminal={activeTerminal} replay={activeTerminal.output.pty ?? `${activeTerminal.output.stdout}${activeTerminal.output.stderr ? `\n${activeTerminal.output.stderr}` : ""}`} onInput={onInput} onResize={onResize} />
          </div>
        </div>
      </div>
    </aside>
  );
}

function DockHeightHandle({ onResizeHeight }: { onResizeHeight: (height: number) => void }) {
  return (
    <div
      className="absolute left-0 top-0 z-10 flex h-3 w-full cursor-row-resize items-center justify-center bg-white/80"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize terminal dock"
      onMouseDown={(event) => {
        event.preventDefault();
        const onMove = (moveEvent: MouseEvent) => {
          const nextHeight = window.innerHeight - moveEvent.clientY;
          onResizeHeight(nextHeight);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }}
    >
      <GripVertical className="size-3 text-brand-text-light" />
    </div>
  );
}

function TerminalDockControls({
  terminal,
  onStop,
  onInput,
  replay,
}: {
  terminal: ConversationTerminal;
  onStop: TerminalDockPanelProps["onStop"];
  onInput: TerminalDockPanelProps["onInput"];
  replay: string;
}) {
  const [clearNonce, setClearNonce] = useState(0);
  const didMountRef = useRef(false);
  const canSendInput = isLiveTerminal(terminal);
  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }
    window.dispatchEvent(new CustomEvent("socrates-terminal-clear", { detail: { terminalId: terminal.terminalId, nonce: clearNonce } }));
  }, [clearNonce, terminal.terminalId]);

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-gray-200 bg-brand-bg px-2">
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded-md text-brand-text-light transition hover:bg-white hover:text-brand-text-dark"
        title="Copy terminal text"
        onClick={() => void navigator.clipboard?.writeText(replay)}
      >
        <Copy className="size-4" />
      </button>
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded-md text-brand-text-light transition hover:bg-white hover:text-brand-text-dark disabled:cursor-not-allowed disabled:opacity-50"
        title={canSendInput ? "Paste from clipboard" : "Terminal is not running"}
        disabled={!canSendInput}
        onClick={() => {
          void navigator.clipboard?.readText().then((text) => {
            if (text && isLiveTerminal(terminal)) {
              onInput(terminal.terminalId, { data: text });
            }
          });
        }}
      >
        <Clipboard className="size-4" />
      </button>
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded-md text-brand-text-light transition hover:bg-white hover:text-brand-text-dark"
        title="Clear display"
        onClick={() => setClearNonce((value) => value + 1)}
      >
        <Trash2 className="size-4" />
      </button>
      {isLiveTerminal(terminal) ? (
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-md text-rose-500 transition hover:bg-rose-50"
          title="Stop terminal"
          onClick={() => onStop(terminal.terminalId)}
        >
          <Square className="size-4" />
        </button>
      ) : null}
    </div>
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
          const nextWidth = Math.min(Math.max(window.innerWidth - moveEvent.clientX, MIN_TERMINAL_PANEL_WIDTH), MAX_TERMINAL_PANEL_WIDTH);
          onResizePanel(nextWidth);
        };
        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      }}
    >
      <div className="flex h-16 w-1 items-center justify-center rounded-full bg-transparent text-gray-300 transition group-hover:text-gray-500">
        <GripVertical className="size-3" />
      </div>
    </div>
  );
}

function RenameButton({ terminal, onRename }: { terminal: ConversationTerminal; onRename: (terminalId: string, name: string) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState(terminal.name);

  const commit = () => {
    const next = nameDraft.trim();
    if (next && next !== terminal.name) {
      onRename(terminal.terminalId, next);
    }
    setIsEditing(false);
  };

  if (!isEditing) {
    return (
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-md text-brand-text-light transition hover:bg-white hover:text-brand-text-dark"
        title="Rename terminal"
        onClick={() => {
          setNameDraft(terminal.name);
          setIsEditing(true);
        }}
      >
        <Pencil className="size-3.5" />
      </button>
    );
  }

  return (
    <form
      className="absolute right-3 top-16 z-20 w-56 rounded-md border border-gray-200 bg-white p-2 shadow-lg"
      onSubmit={(event) => {
        event.preventDefault();
        commit();
      }}
    >
      <input
        className="w-full rounded-md border border-gray-200 px-2 py-1 text-xs text-brand-text-dark"
        value={nameDraft}
        onChange={(event) => setNameDraft(event.target.value)}
        onBlur={commit}
        autoFocus
      />
    </form>
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
  onInput: TerminalDockPanelProps["onInput"];
  onResize: TerminalDockPanelProps["onResize"];
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const writtenRef = useRef("");
  const sizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const replayRef = useRef(replay);
  const inputRef = useRef(onInput);
  const resizeRef = useRef(onResize);
  const isLiveRef = useRef(isLiveTerminal(terminal));
  const awaitingInputRef = useRef(isAwaitingInputTerminal(terminal));
  const isLive = isLiveTerminal(terminal);
  const awaitingInput = isAwaitingInputTerminal(terminal);

  useEffect(() => {
    replayRef.current = replay;
    inputRef.current = onInput;
    resizeRef.current = onResize;
    isLiveRef.current = isLiveTerminal(terminal);
    awaitingInputRef.current = isAwaitingInputTerminal(terminal);
  }, [onInput, onResize, replay, terminal]);

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
      if (awaitingInputRef.current) {
        requestAnimationFrame(() => xterm.focus());
      }
      xterm.onData((data) => {
        if (isLiveRef.current) {
          inputRef.current(terminal.terminalId, { data });
        }
      });

      const fitAndNotify = () => {
        try {
          fit.fit();
        } catch {
          return;
        }
        const size = { cols: xterm.cols, rows: xterm.rows };
        if (size.cols > 0 && size.rows > 0 && (sizeRef.current?.cols !== size.cols || sizeRef.current?.rows !== size.rows)) {
          sizeRef.current = size;
          if (isLiveRef.current) {
            resizeRef.current(terminal.terminalId, size);
          }
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

  useEffect(() => {
    if (awaitingInput) {
      terminalRef.current?.focus();
    }
  }, [awaitingInput, terminal.terminalId]);

  return (
    <div className="relative flex-1 overflow-hidden bg-gray-950">
      {awaitingInput ? (
        <div className="absolute right-3 top-3 z-10 rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[11px] font-medium uppercase text-amber-200">
          Awaiting input
        </div>
      ) : !isLive ? (
        <div className="absolute right-3 top-3 z-10 rounded-md border border-gray-700 bg-gray-900/95 px-2 py-1 text-[11px] font-medium uppercase text-gray-400">
          {terminal.status}
        </div>
      ) : null}
      <div
        ref={containerRef}
        className={`h-full min-h-0 p-2 ${isLive ? "" : "opacity-80"}`}
        onMouseDown={() => {
          if (isLiveTerminal(terminal)) {
            terminalRef.current?.focus();
          }
        }}
      />
    </div>
  );
}

function StatusPill({ tone, label }: { tone: "running" | "input"; label: string }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${pillClass(tone)}`}>{label}</span>;
}

function pillClass(tone: "running" | "input"): string {
  if (tone === "running") {
    return "bg-teal-50 text-teal-700";
  }
  return "bg-amber-50 text-amber-700";
}

function statusDotClass(status: ConversationTerminal["status"]): string {
  if (status === "running") {
    return "bg-teal-500";
  }
  if (status === "awaiting_input") {
    return "bg-amber-500";
  }
  if (status === "exited") {
    return "bg-gray-500";
  }
  if (status === "stopped") {
    return "bg-red-500";
  }
  return "bg-gray-600";
}

function isLiveTerminal(terminal: ConversationTerminal): boolean {
  return terminal.status === "running" || terminal.status === "awaiting_input";
}

function isAwaitingInputTerminal(terminal: ConversationTerminal): boolean {
  return terminal.status === "awaiting_input" || terminal.awaitingInput;
}
