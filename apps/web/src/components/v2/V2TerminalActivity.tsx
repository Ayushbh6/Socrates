"use client";

import { Save, Send, SquareTerminal } from "lucide-react";
import { useState } from "react";
import type { FlowTerminalActivityView } from "./types";
import styles from "./seamless.module.css";

interface V2TerminalActivityProps {
  terminal: FlowTerminalActivityView;
  onInput?: (terminalId: string, text: string) => void;
  onStop?: (terminalId: string) => void;
  onRename?: (terminalId: string, name: string) => void;
}

const interactiveStatuses = new Set(["starting", "running", "awaiting_input", "detached"]);

export function V2TerminalActivity({ terminal, onInput, onStop, onRename }: V2TerminalActivityProps) {
  const [input, setInput] = useState("");
  const [name, setName] = useState(terminal.name);
  const [isOpen, setIsOpen] = useState(terminal.awaitingInput);
  const isInteractive = interactiveStatuses.has(terminal.status);

  return (
    <details
      className={styles.terminalActivity}
      open={isOpen}
      onToggle={(event) => setIsOpen(event.currentTarget.open)}
    >
      <summary>
        <span>
          <SquareTerminal aria-hidden="true" />
          <strong>{terminal.name}</strong>
        </span>
        <small>{terminal.status.replaceAll("_", " ")}</small>
      </summary>

      <div className={styles.terminalActivityBody}>
        <p title={terminal.command}>{terminal.command}</p>
        <small title={terminal.cwd}>{terminal.cwd}</small>
        <pre aria-live={terminal.awaitingInput ? "polite" : "off"}>
          {terminal.output || "No output captured in the recent Flow activity window."}
        </pre>

        {isInteractive && (
          <form
            className={styles.terminalInputRow}
            onSubmit={(event) => {
              event.preventDefault();
              if (!input) return;
              onInput?.(terminal.id, input);
              setInput("");
            }}
          >
            <label className={styles.srOnly} htmlFor={`terminal-input-${terminal.id}`}>Terminal input</label>
            <input
              id={`terminal-input-${terminal.id}`}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={terminal.awaitingInput ? "This process is waiting for input" : "Send terminal input"}
              disabled={!onInput}
            />
            <button type="submit" disabled={!onInput || !input} aria-label="Send terminal input">
              <Send aria-hidden="true" />
            </button>
          </form>
        )}

        <div className={styles.terminalControlRow}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const nextName = name.trim();
              if (!nextName || nextName === terminal.name) return;
              onRename?.(terminal.id, nextName);
            }}
          >
            <label className={styles.srOnly} htmlFor={`terminal-name-${terminal.id}`}>Terminal name</label>
            <input
              id={`terminal-name-${terminal.id}`}
              value={name}
              maxLength={96}
              onChange={(event) => setName(event.target.value)}
              disabled={!onRename}
            />
            <button type="submit" disabled={!onRename || !name.trim() || name.trim() === terminal.name}>
              <Save aria-hidden="true" />
              Rename
            </button>
          </form>
          {isInteractive && (
            <button type="button" className={styles.terminalStop} disabled={!onStop} onClick={() => onStop?.(terminal.id)}>
              Stop
            </button>
          )}
        </div>
      </div>
    </details>
  );
}
