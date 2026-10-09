import { z } from "zod";

/**
 * Inputs of the ten permanent working-agent tools (agent-harness.md, "The
 * permanent tool surface"). These schemas are structural; workspace access,
 * selector resolution, and every other contextual rule is enforced by the
 * tool runner and the individual handlers.
 */

const Path = z.string().min(1).max(4096);
const Cursor = z.string().min(1).max(64);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").refine((day) => {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}, "Use a real calendar date.");

export const ReadInput = z.strictObject({
  path: Path,
  offset: z.number().int().min(1).optional().describe("First line, from 1. Default 1."),
  limit: z.number().int().min(1).optional(),
});

const SearchSort = z.enum(["path", "modified"]);
const IncludeIgnored = z.boolean().optional().describe("Include files .gitignore excludes (node_modules, build output).");
const Root = "Default: the workspace root.";
const NextCursor = "next_cursor of the same call.";

export const GlobInput = z.strictObject({
  pattern: z.string().min(1).max(1000),
  path: Path.optional().describe(`Directory. ${Root}`),
  sort: SearchSort.optional().describe("Default modified (newest first)."),
  include_ignored: IncludeIgnored,
  limit: z.number().int().min(1).optional(),
  cursor: Cursor.optional().describe(NextCursor),
});

const ContextLines = z.number().int().min(0).max(50);

export const GrepInput = z.strictObject({
  pattern: z.string().min(1).max(1000),
  path: Path.optional().describe(`File or directory. ${Root}`),
  glob: z.string().min(1).max(1000).optional().describe('File filter: "*.ts", "*.{ts,tsx}", or an exclusion "!**/fixtures/**".'),
  type: z.string().regex(/^[A-Za-z0-9_+-]{1,40}$/).optional().describe('ripgrep file type: "ts", "py", "rust".'),
  output: z.enum(["content", "files", "count"]).optional().describe("content (default): matching lines with path and line number; files: matching paths; count: matching lines per file."),
  context_before: ContextLines.optional().describe("Lines before each match (content)."),
  context_after: ContextLines.optional().describe("Lines after each match (content)."),
  context: ContextLines.optional().describe("Lines before and after; context_before and context_after override it."),
  multiline: z.boolean().optional().describe("Pattern may span lines; . matches newlines."),
  case_sensitive: z.boolean().optional().describe("Default true."),
  literal: z.boolean().optional().describe("Pattern is exact text."),
  sort: SearchSort.optional().describe("Default path for content, modified (newest first) for files and count."),
  include_ignored: IncludeIgnored,
  limit: z.number().int().min(1).optional(),
  cursor: Cursor.optional().describe(NextCursor),
});

/** At most this many replacements in one edit call. */
export const EDIT_MAX_EDITS = 50;

const OneEdit = z.strictObject({
  old_text: z.string(),
  new_text: z.string(),
  replace_all: z.boolean().optional(),
});

export const EditInput = z.strictObject({
  path: Path,
  old_text: z.string().optional().describe("Exact text to replace; empty to create the file."),
  new_text: z.string().optional().describe("Replacement, or the new file's content."),
  replace_all: z.boolean().optional().describe("Replace every occurrence."),
  edits: z.array(OneEdit).min(1).max(EDIT_MAX_EDITS).optional().describe("Several replacements, instead of old_text and new_text."),
});

export const ApplyPatchInput = z.strictObject({
  patch: z.string().min(1),
});

export const TerminalKey = z.enum(["ENTER", "TAB", "ESCAPE", "BACKSPACE", "DELETE", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "PAGE_UP", "PAGE_DOWN", "CTRL_C", "CTRL_D", "CTRL_L", "CTRL_Z"]);
export const TerminalSignal = z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP", "SIGKILL"]);
const TerminalName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Use letters, digits, dot, dash, or underscore (max 64).");

export const TerminalInput = z.strictObject({
  command: z.string().min(1).max(20_000),
  cwd: Path.optional().describe(Root),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  timeout_ms: z.number().int().min(0).optional().describe("Deadline; 0: none (asks the user)."),
  yield_ms: z.number().int().min(250).optional().describe("Wait before returning a running session."),
  pty: z.boolean().optional().describe("120×40 pseudo-terminal for interactive programs."),
  background: z.boolean().optional().describe("Return once started, or once ready."),
  name: TerminalName.optional().describe('Session name, such as "dev-server".'),
  ready: z
    .strictObject({
      pattern: z.string().min(1).max(500).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      timeout_ms: z.number().int().min(1).optional(),
    })
    .optional()
    .describe("Ready when output matches pattern (regex) and/or port is open."),
});

const Selector = z.string().min(1).max(64);

export const TerminalControlInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("read"),
    terminal: Selector,
    cursor: Cursor.optional(),
    limit_lines: z.number().int().min(1).optional(),
    filter: z.string().min(1).max(500).optional(),
  }),
  z.strictObject({
    action: z.literal("screen"),
    terminal: Selector,
  }),
  z.strictObject({
    action: z.literal("wait"),
    terminal: Selector.optional(),
    terminals: z.array(Selector).min(2).max(16).optional(),
    event: z.enum(["ready", "output", "input_required", "exit", "pattern", "idle", "port_open", "port_closed"]),
    pattern: z.string().min(1).max(500).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    idle_ms: z.number().int().min(250).max(600_000).optional(),
    timeout_ms: z.number().int().min(250).max(600_000).optional(),
  }),
  z.strictObject({
    action: z.literal("write"),
    terminal: Selector,
    input: z.string().max(20_000).optional(),
    submit: z.boolean().optional(),
    keys: z.array(TerminalKey).max(64).optional(),
    settle_ms: z.number().int().min(0).max(5000).optional(),
  }),
  z.strictObject({ action: z.literal("signal"), terminal: Selector, signal: TerminalSignal }),
  z.strictObject({ action: z.literal("terminate"), terminal: Selector }),
  z.strictObject({ action: z.literal("restart"), terminal: Selector }),
  z.strictObject({ action: z.literal("resize"), terminal: Selector, cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }),
]);

export const ContextRetrieveInput = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("ledger_search"),
    query: z.string().min(1).max(500).optional(),
    entity: z.enum(["goals", "tasks", "both"]).optional(),
    scope: z.enum(["current_goal", "all_goals"]).optional(),
    status: z.enum(["open", "completed", "superseded", "any"]).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    match: z.enum(["hybrid", "exact"]).optional(),
    limit: z.number().int().min(1).optional(),
    cursor: Cursor.optional(),
  }),
  z.strictObject({
    action: z.literal("search"),
    query: z.string().min(1).max(500).optional(),
    match: z.enum(["hybrid", "exact"]).optional(),
    target: z.string().min(1).max(32).optional(),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    top_n: z.number().int().min(1).optional(),
    cursor: Cursor.optional(),
  }),
  z.strictObject({
    action: z.literal("inspect"),
    ref: z.string().min(1).max(32).optional(),
    turn_number: z.number().int().min(1).optional(),
  }),
]);

export const CapabilitySearchInput = z.strictObject({
  query: z.string().min(1).max(500),
  kind: z.enum(["any", "skill", "mcp"]).optional(),
  limit: z.number().int().min(1).optional(),
});

export const CapabilityControlInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("activate"), ref: z.string().min(1).max(32) }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("deactivate"), name: z.string().min(1).max(200) }),
]);

export type ReadInput = z.infer<typeof ReadInput>;
export type GlobInput = z.infer<typeof GlobInput>;
export type GrepInput = z.infer<typeof GrepInput>;
export type EditInput = z.infer<typeof EditInput>;
export type ApplyPatchInput = z.infer<typeof ApplyPatchInput>;
export type TerminalInput = z.infer<typeof TerminalInput>;
export type TerminalControlInput = z.infer<typeof TerminalControlInput>;
export type ContextRetrieveInput = z.infer<typeof ContextRetrieveInput>;
export type CapabilitySearchInput = z.infer<typeof CapabilitySearchInput>;
export type CapabilityControlInput = z.infer<typeof CapabilityControlInput>;

/** The one model-facing failure shape (agent-harness.md, "Corrective tool errors"). */
export interface ToolErrorBody {
  code: string;
  message: string;
  correction: string;
  retryable: boolean;
}
