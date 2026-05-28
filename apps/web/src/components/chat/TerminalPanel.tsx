"use client";

import { ChevronRight, Circle, Send, Square, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import type { ConversationTerminal } from "@socrates/contracts";

type TerminalInputKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Enter" | "Escape" | "Ctrl-C";

interface TerminalPanelProps {
  terminals: ConversationTerminal[];
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  onStop: (terminalId: string) => void;
  onInput: (terminalId: string, input: { text?: string; key?: TerminalInputKey; submit?: boolean }) => void;
}

export function TerminalPanel({ terminals, isCollapsed, onToggleCollapsed, onStop, onInput }: TerminalPanelProps) {
  const visibleTerminals = useMemo(
    () => [...terminals].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 6),
    [terminals],
  );
  const runningCount = visibleTerminals.filter((terminal) => terminal.status === "running" || terminal.status === "awaiting_input").length;
  const awaitingInputCount = visibleTerminals.filter((terminal) => terminal.status === "awaiting_input" || terminal.awaitingInput).length;

  if (visibleTerminals.length === 0) {
    return null;
  }

  if (isCollapsed) {
    return (
      <aside className="flex h-12 shrink-0 items-center gap-3 border-t border-gray-200 bg-gray-50 px-3 lg:h-auto lg:w-12 lg:flex-col lg:border-l lg:border-t-0 lg:px-0">
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
    <aside className="flex max-h-[45vh] w-full shrink-0 flex-col border-t border-gray-200 bg-gray-50 lg:max-h-none lg:w-[380px] lg:border-l lg:border-t-0">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4">
        <div className="flex size-8 items-center justify-center rounded-md bg-gray-950 text-white">
          <SquareTerminal className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-brand-text-dark">Terminal</h2>
            {runningCount > 0 ? <StatusPill tone="running" label={`${runningCount} running`} /> : null}
            {awaitingInputCount > 0 ? <StatusPill tone="input" label={`${awaitingInputCount} input`} /> : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-brand-text-light">Conversation-scoped sessions</p>
        </div>
        <button
          type="button"
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-gray-200 text-brand-text-light hover:bg-gray-50 hover:text-brand-text-dark"
          title="Collapse terminals"
          onClick={onToggleCollapsed}
        >
          <ChevronRight className="size-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <div className="space-y-3">
          {visibleTerminals.map((terminal) => (
            <TerminalPane key={terminal.terminalId} terminal={terminal} onStop={onStop} onInput={onInput} />
          ))}
        </div>
      </div>
    </aside>
  );
}

function TerminalPane({ terminal, onStop, onInput }: { terminal: ConversationTerminal; onStop: TerminalPanelProps["onStop"]; onInput: TerminalPanelProps["onInput"] }) {
  const [input, setInput] = useState("");
  const stdout = terminal.output.stdout;
  const stderr = terminal.output.stderr;
  const output = [stdout, stderr].filter(Boolean).join("\n");
  const shell = [terminal.platform, terminal.shellKind, terminal.shellExecutable].filter(Boolean).join(" / ");
  const canStop = terminal.status === "running" || terminal.status === "awaiting_input";
  const needsInput = terminal.awaitingInput || terminal.status === "awaiting_input";
  const canSendInput = terminal.status === "running" || terminal.status === "awaiting_input";

  const sendInput = () => {
    if (!input) {
      return;
    }
    onInput(terminal.terminalId, { text: input, submit: true });
    setInput("");
  };

  const sendKey = (key: TerminalInputKey) => {
    onInput(terminal.terminalId, { key });
  };

  return (
    <article className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-start gap-3 border-b border-gray-100 px-3 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <Circle className={`size-2.5 shrink-0 fill-current ${statusDotClass(terminal.status)}`} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-brand-text-dark">{terminal.name}</span>
            <StatusPill tone={statusTone(terminal.status)} label={terminal.status.replaceAll("_", " ")} />
          </div>
          <p className="mt-1 truncate font-mono text-xs text-brand-text-light">{terminal.command}</p>
          <div className="mt-2 grid gap-1 text-[11px] text-brand-text-light">
            <span className="truncate font-mono">cwd {terminal.cwd}</span>
            {shell ? <span className="truncate">{shell}</span> : null}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-brand-text-light">
            {terminal.exitCode !== undefined ? <span>exit {terminal.exitCode ?? "none"}</span> : null}
            {terminal.signal ? <span>signal {terminal.signal}</span> : null}
            <span>seq {terminal.output.nextOutputSequence}</span>
          </div>
        </div>
        {canStop ? (
          <button
            type="button"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-gray-200 text-brand-text-light hover:bg-gray-100 hover:text-brand-text-dark"
            title="Stop terminal"
            onClick={() => onStop(terminal.terminalId)}
          >
            <Square className="size-4" />
          </button>
        ) : null}
      </div>
      {output ? (
        <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words bg-gray-950 px-3 py-3 font-mono text-[11px] leading-relaxed text-gray-100">
          {output}
        </pre>
      ) : (
        <div className="bg-gray-950 px-3 py-6 text-center font-mono text-[11px] text-gray-500">No output yet.</div>
      )}
      {canSendInput ? (
        <div className={`border-t px-3 py-3 ${needsInput ? "border-amber-100 bg-amber-50" : "border-gray-100 bg-gray-50"}`}>
          {terminal.lastPrompt ? <p className="mb-2 text-xs text-amber-800">{terminal.lastPrompt}</p> : null}
          <div className="mb-2 flex flex-wrap gap-1.5">
            <KeyButton label="↑" title="Arrow up" onClick={() => sendKey("ArrowUp")} />
            <KeyButton label="↓" title="Arrow down" onClick={() => sendKey("ArrowDown")} />
            <KeyButton label="Enter" title="Enter" onClick={() => sendKey("Enter")} />
            <KeyButton label="Esc" title="Escape" onClick={() => sendKey("Escape")} />
            <KeyButton label="^C" title="Ctrl-C" onClick={() => sendKey("Ctrl-C")} />
          </div>
          <div className="flex gap-2">
            <input
              className={`min-w-0 flex-1 rounded-md border bg-white px-2 py-1.5 text-sm outline-none ${
                needsInput ? "border-amber-200 focus:border-amber-500" : "border-gray-200 focus:border-brand-teal-dark"
              }`}
              type={isSecretPrompt(terminal.lastPrompt) ? "password" : "text"}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  sendInput();
                }
              }}
            />
            <button
              type="button"
              className="inline-flex size-8 items-center justify-center rounded-md bg-brand-teal-dark text-white disabled:opacity-50"
              title="Send input"
              disabled={!input}
              onClick={sendInput}
            >
              <Send className="size-4" />
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

function KeyButton({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-gray-200 bg-white px-2 font-mono text-[11px] text-brand-text-light hover:border-brand-teal-dark hover:text-brand-teal-dark"
      title={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function StatusPill({ tone, label }: { tone: "running" | "input" | "neutral" | "danger"; label: string }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${pillClass(tone)}`}>{label}</span>;
}

function statusTone(status: ConversationTerminal["status"]): "running" | "input" | "neutral" | "danger" {
  if (status === "running") {
    return "running";
  }
  if (status === "awaiting_input") {
    return "input";
  }
  if (status === "exited" || status === "stale") {
    return "neutral";
  }
  return "danger";
}

function pillClass(tone: "running" | "input" | "neutral" | "danger"): string {
  if (tone === "running") {
    return "bg-teal-50 text-brand-teal-dark";
  }
  if (tone === "input") {
    return "bg-amber-100 text-amber-800";
  }
  if (tone === "neutral") {
    return "bg-gray-100 text-gray-700";
  }
  return "bg-red-50 text-red-700";
}

function statusDotClass(status: ConversationTerminal["status"]): string {
  if (status === "running") {
    return "text-brand-teal-dark";
  }
  if (status === "awaiting_input") {
    return "text-amber-500";
  }
  if (status === "exited" || status === "stale") {
    return "text-gray-400";
  }
  return "text-red-500";
}

function isSecretPrompt(prompt: string | undefined): boolean {
  return Boolean(prompt && /(password|token|api\s*key|secret|passphrase)/i.test(prompt));
}
