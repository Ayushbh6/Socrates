import type { SemanticSearch } from "@socrates/retrieval";
import type { LedgerStore } from "@socrates/store";
import type { CapabilityCatalog } from "./catalog";
import { ToolError } from "./errors";
import type { TerminalSupervisor } from "./terminals";
import type { WorkspaceRoot, ResolvedPath } from "./workspace";

/** The goal, task, chat, and turn a tool call belongs to. */
export interface ToolBinding {
  goalId: string;
  taskId: string;
  chatId: string | null;
  turnId: string | null;
}

export type ApprovalKind = "first_mutation" | "sigkill" | "no_deadline" | "mcp_tool";

export interface ApprovalRequest {
  kind: ApprovalKind;
  tool: string;
  /** One line shown to the user, such as the command or file about to change. */
  detail: string;
  /** What a remembered approval covers: an MCP tool's catalog name. */
  subject?: string;
}

/** Where an approval request comes from, so the application can show it in the right place. */
export interface ApprovalOrigin extends ToolBinding {
  /** The lane the run belongs to; null for the main conversation. */
  laneId?: string | null;
}

/** Application-owned approval (agent-harness.md, "Safety and long-running work"). */
export type Approve = (request: ApprovalRequest, origin?: ApprovalOrigin) => Promise<boolean>;

/** What a run-scoped short reference (`r1`, `c1`) points at. */
export type RunRef =
  | { kind: "turn"; turnId: string }
  | { kind: "capability"; entryKind: "skill" | "mcp"; name: string; goalId: string };

/**
 * State scoped to one agent run (one turn, or one compound part): the frozen
 * result sets behind cursors and the short references issued by searches.
 */
export class RunState {
  private readonly cursors = new Map<string, { key: string; items: unknown[]; offset: number; capped: boolean }>();
  private readonly refs = new Map<string, RunRef>();
  private cursorCounter = 0;
  private readonly refCounters = new Map<string, number>();

  constructor(private readonly maxCursors = 64) {}

  /** Freeze the remainder of a result set and return the cursor that continues it. */
  saveCursor(key: string, items: unknown[], offset: number, capped = false): string {
    const id = `k${++this.cursorCounter}`;
    this.cursors.set(id, { key, items, offset, capped });
    while (this.cursors.size > this.maxCursors) this.cursors.delete(this.cursors.keys().next().value!);
    return id;
  }

  /** The frozen set behind a cursor, which must have been issued for the same request. */
  takeCursor<T>(id: string, key: string): { items: T[]; offset: number; capped: boolean } {
    const entry = this.cursors.get(id);
    if (!entry) throw new ToolError("cursor_expired", `Cursor ${id} is unknown or expired.`, "Repeat the call without cursor to start a new result set.");
    if (entry.key !== key) {
      throw new ToolError("cursor_mismatch", `Cursor ${id} belongs to a different request.`, "Present a cursor only with the exact parameters of the call that returned it, or omit cursor to search again.");
    }
    return { items: entry.items as T[], offset: entry.offset, capped: entry.capped };
  }

  /** Issue the next short reference with the given prefix, such as r1 or c3. */
  issueRef(prefix: "r" | "c", target: RunRef): string {
    const n = (this.refCounters.get(prefix) ?? 0) + 1;
    this.refCounters.set(prefix, n);
    const ref = `${prefix}${n}`;
    this.refs.set(ref, target);
    return ref;
  }

  ref(id: string): RunRef | undefined {
    return this.refs.get(id);
  }
}

/** Everything a tool handler may use for one call. */
export interface HandlerContext {
  store: LedgerStore;
  binding: ToolBinding;
  workspace: WorkspaceRoot | null;
  run: RunState;
  signal: AbortSignal;
  approve: Approve;
  timeZone: string;
  catalog: CapabilityCatalog;
  /** Meaning-based search over memory; absent or unavailable means keyword search alone. */
  semantic?: SemanticSearch;
  /** Resolve read-only access to an active Skill resource, or fall back to workspace policy. */
  resolveReadPath?: (input: string) => Promise<ResolvedPath>;
  /** The terminal supervisor of the selected workspace, when there is one. */
  terminals: TerminalSupervisor | null;
  /** Ask the user, record the decision, and fail with a corrective error when denied or cancelled. */
  requireApproval(request: ApprovalRequest): Promise<void>;
}

/** Fail with the corrective cancellation error once the call has been cancelled. */
export function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError("cancelled", "The call was cancelled before it changed anything.", "No action needed.", false);
}

export function requireWorkspace(ctx: Pick<HandlerContext, "workspace">): WorkspaceRoot {
  if (!ctx.workspace) {
    throw new ToolError(
      "no_workspace",
      "This work has no workspace yet, so files and commands are unavailable.",
      "Answer without filesystem tools, or ask the user which project folder this work belongs to.",
      false,
    );
  }
  return ctx.workspace;
}
