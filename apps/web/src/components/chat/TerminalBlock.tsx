import type { ReactNode } from "react";

interface TerminalBlockProps {
  command?: string;
  cwd?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  status?: "running" | "exited" | "failed" | "stale" | "awaiting_input";
  shell?: string;
  // Optional chrome for the persistent Terminal panel; omitted for inline tool output.
  name?: string;
  statusLabel?: string;
  headerActions?: ReactNode;
  children?: ReactNode;
}

// A self-contained, premium terminal surface: a window title bar, a prompt line, a
// scrollable output body (stdout + stderr), and a compact metadata footer. Shared by the
// inline tool timeline and the persistent conversation Terminal panel.
export function TerminalBlock({
  command,
  cwd,
  stdout,
  stderr,
  exitCode,
  signal,
  durationMs,
  status,
  shell,
  name,
  statusLabel,
  headerActions,
  children,
}: TerminalBlockProps) {
  const awaitingInput = status === "awaiting_input";
  const isRunning = status === "running" || awaitingInput;
  const out = stdout ?? "";
  const err = stderr ?? "";
  const hasOutput = Boolean(out || err);
  const failed = status === "failed" || (typeof exitCode === "number" && exitCode !== 0);
  const showFooter = (cwd || shell || typeof exitCode === "number" || signal || durationMs !== undefined) && !isRunning;

  return (
    <div className="overflow-hidden rounded-xl border border-gray-800 bg-gray-950 shadow-sm ring-1 ring-black/5">
      <div className="flex items-center gap-2 border-b border-white/10 bg-white/5 px-3 py-2">
        <span className="flex shrink-0 items-center gap-1.5" aria-hidden>
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-gray-300">{name ?? "terminal"}</span>
        {isRunning ? (
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
              awaitingInput ? "bg-amber-400/10 text-amber-300" : "bg-teal-400/10 text-teal-300"
            }`}
          >
            <span className="relative flex size-1.5">
              <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-40 ${awaitingInput ? "bg-amber-300" : "bg-teal-300"}`} />
              <span className={`relative inline-flex size-1.5 rounded-full ${awaitingInput ? "bg-amber-300" : "bg-teal-300"}`} />
            </span>
            {statusLabel ?? "running"}
          </span>
        ) : statusLabel ? (
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${failed ? "bg-red-500/10 text-red-300" : "bg-white/10 text-gray-300"}`}>
            {statusLabel}
          </span>
        ) : null}
        {headerActions}
      </div>
      {command ? (
        <div className="border-b border-white/5 px-3 py-2 font-mono text-[12px] leading-relaxed text-gray-200">
          <span className="select-none text-teal-400/80">$ </span>
          <span className="wrap-break-word">{command}</span>
        </div>
      ) : null}
      {hasOutput ? (
        <pre className="max-h-88 overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-3 font-mono text-[12px] leading-relaxed text-gray-100">
          {out}
          {err ? <span className="text-red-300">{out ? `\n${err}` : err}</span> : null}
          {isRunning ? <span className="ml-0.5 inline-block h-[1.05em] w-[7px] translate-y-[2px] animate-pulse bg-gray-300 align-middle" /> : null}
        </pre>
      ) : (
        <div className="px-3 py-5 text-center font-mono text-[12px] text-gray-500">{isRunning ? "Running…" : "No output."}</div>
      )}
      {showFooter ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-white/10 bg-white/3 px-3 py-1.5 font-mono text-[10px] text-gray-400">
          {typeof exitCode === "number" ? (
            <span className={failed ? "text-red-300" : "text-emerald-300"}>exit {exitCode}</span>
          ) : null}
          {signal ? <span className="text-red-300">signal {signal}</span> : null}
          {durationMs !== undefined ? <span>{formatDuration(durationMs)}</span> : null}
          {shell ? <span className="truncate">{shell}</span> : null}
          {cwd ? <span className="min-w-0 truncate text-gray-500">{cwd}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
