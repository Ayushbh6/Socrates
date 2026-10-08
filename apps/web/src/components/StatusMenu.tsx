import { Check, ChevronDown, CircleCheck } from "lucide-react";
import { type CSSProperties, type MouseEvent, useState } from "react";
import type { ClosedBy, LedgerStatus } from "../lib/types";
import { Popover } from "./Popover";

const CHOICES: { value: LedgerStatus; label: string; hint: string }[] = [
  { value: "open", label: "Open", hint: "Still being worked on" },
  { value: "completed", label: "Completed", hint: "Done" },
  { value: "superseded", label: "Superseded", hint: "Replaced by other work; no longer pursued" },
];

export const statusLabel = (value: string): string => CHOICES.find((c) => c.value === value)?.label ?? "Open";

/** Who closed a task, in a line for its note: the user, or Socrates with its reason. */
export function closedText(status: string, closed: ClosedBy | null | undefined): string | null {
  if (status === "open" || !closed) return null;
  if (closed.by === "user") return status === "superseded" ? "You marked it superseded." : "You marked it completed.";
  return closed.reason ? `Socrates closed it: ${closed.reason}` : "Socrates closed it.";
}

/**
 * A goal's or task's status, which the user can change (architecture/web.md,
 * "Status"): open, completed, or superseded. Shown as the status itself with
 * a menu, or as a small button in a row of actions.
 */
export function StatusMenu({ value, onChange, what, variant = "pill", align = "left" }: {
  value: string;
  onChange: (status: LedgerStatus) => void;
  /** "task", "goal": named in the button's label. */
  what: string;
  variant?: "pill" | "icon";
  align?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  // The small button sits in a scrolling sidebar that would clip the menu, so its menu is placed in the window, under the button.
  const [place, setPlace] = useState<{ style: CSSProperties; anchor: HTMLElement } | null>(null);
  // Inside a task's summary row, a click must not open or close the row.
  const toggle = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (variant === "icon") {
      const r = e.currentTarget.getBoundingClientRect();
      setPlace({ anchor: e.currentTarget, style: { position: "fixed", top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - 248)), right: "auto" } });
    }
    setOpen(!open);
  };
  const choose = (e: MouseEvent, status: LedgerStatus) => {
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    if (status !== value) onChange(status);
  };
  return (
    <span className="status-menu">
      {variant === "pill" ? (
        <button type="button" className="note-status status-pill" data-status={value} aria-haspopup="menu" aria-expanded={open} aria-label={`Status of this ${what}: ${statusLabel(value)}. Change it`} onClick={toggle}>
          <i aria-hidden />{statusLabel(value)}<ChevronDown aria-hidden />
        </button>
      ) : (
        <button type="button" className="icon-button" aria-haspopup="menu" aria-expanded={open} aria-label={`Status of this ${what}: ${statusLabel(value)}. Change it`} title={`Status: ${statusLabel(value)}`} onClick={toggle}>
          <CircleCheck aria-hidden />
        </button>
      )}
      {open && (
        <Popover align={align} onClose={() => setOpen(false)} className="status-popover" {...(place ? place : {})}>
          {CHOICES.map((c) => (
            <button key={c.value} type="button" role="menuitemradio" aria-checked={c.value === value} onClick={(e) => choose(e, c.value)}>
              <span><strong>{c.label}</strong><small>{c.hint}</small></span>
              {c.value === value && <Check aria-hidden />}
            </button>
          ))}
        </Popover>
      )}
    </span>
  );
}
