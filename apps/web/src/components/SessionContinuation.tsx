import { ArrowLeft, Link2 } from "lucide-react";

/** A session boundary does not create a new task or change the user's request. */
export function SessionContinuation({ onBack, handover, sequence }: { onBack?: () => void; handover?: unknown; sequence: number }) {
  const note = handover && typeof handover === "object" ? handover as Record<string, unknown> : null;
  const fields = [
    ["Verified progress", note?.verified_progress],
    ["Still to do", note?.outstanding_requests],
    ["Next action", note?.next_action],
    ["Decisions", note?.decisions],
    ["Constraints", note?.constraints],
    ["Files and checks", note?.files_and_tests],
    ["Blockers", note?.blockers],
    ["Evidence", note?.key_evidence],
    ["Coverage", note?.omitted_details],
  ] as const;
  return <aside className="continued-note" aria-label="Continued from the previous chat">
    <div className="session-continuation-content">
      <span className="session-continuation-title"><Link2 size={15} aria-hidden /> Session {sequence} · Same task, fresh context</span>
      <small>Linked to the previous session after five context compactions.</small>
      {handover != null && <details><summary>View handover</summary>
        <div className="session-handover">
          {note ? fields.filter(([, value]) => value != null && value !== "" && (!Array.isArray(value) || value.length > 0)).map(([label, value]) => <section key={label}><strong>{label}</strong><p>{readable(value)}</p></section>) : <p>{String(handover)}</p>}
        </div>
      </details>}
    </div>
    {onBack && <button type="button" className="quiet-button" onClick={onBack}><ArrowLeft size={14} aria-hidden /> Previous session</button>}
  </aside>;
}

function readable(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(readable).join("\n");
  if (value && typeof value === "object") return Object.entries(value).map(([key, entry]) => `${key.replaceAll("_", " ")}: ${readable(entry)}`).join(" · ");
  return String(value ?? "");
}
