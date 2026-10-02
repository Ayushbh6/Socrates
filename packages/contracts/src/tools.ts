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
  path: Path.describe("Workspace-relative path of one UTF-8 text file."),
  offset: z.number().int().min(1).optional().describe("1-based first line. Default 1."),
  limit: z.number().int().min(1).optional().describe("Maximum lines. Default 2000."),
});

export const GlobInput = z.strictObject({
  pattern: z.string().min(1).max(1000).describe('Glob such as "**/*.ts" or "src/**/index.ts" (ripgrep/gitignore glob dialect).'),
  path: Path.optional().describe("Directory to search. Defaults to the workspace root."),
  limit: z.number().int().min(1).optional().describe("Maximum paths per page. Default 200."),
  cursor: Cursor.optional().describe("next_cursor from the preceding identical call."),
});

export const GrepInput = z.strictObject({
  pattern: z.string().min(1).max(1000).describe("Regular expression (Rust regex syntax), or exact text with literal: true."),
  path: Path.optional().describe("File or directory to search. Defaults to the workspace root."),
  glob: z.string().min(1).max(1000).optional().describe('One inclusion filter such as "*.ts" or "**/*.test.ts".'),
  case_sensitive: z.boolean().optional().describe("Default true."),
  literal: z.boolean().optional().describe("Treat pattern as exact text. Default false."),
  limit: z.number().int().min(1).optional().describe("Maximum matches per page. Default 100."),
  cursor: Cursor.optional().describe("next_cursor from the preceding identical call."),
});

export const EditInput = z.strictObject({
  path: Path.describe("Workspace-relative path of an existing file."),
  old_text: z.string().min(1).describe("Exact text to replace; must occur exactly once unless replace_all is true."),
  new_text: z.string().describe("Replacement text."),
  replace_all: z.boolean().optional().describe("Replace every occurrence. Default false."),
});

export const ApplyPatchInput = z.strictObject({
  patch: z.string().min(1).describe("The complete patch, from *** Begin Patch to *** End Patch."),
});

export const TerminalKey = z.enum(["ENTER", "TAB", "ESCAPE", "CTRL_C", "CTRL_D", "UP", "DOWN", "LEFT", "RIGHT"]);
export const TerminalSignal = z.enum(["SIGINT", "SIGTERM", "SIGHUP", "SIGTSTP", "SIGKILL"]);
const TerminalName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "Use letters, digits, dot, dash, or underscore (max 64).");

export const TerminalInput = z.strictObject({
  command: z.string().min(1).max(20_000).describe("Shell command to run."),
  cwd: Path.optional().describe("Working directory. Defaults to the workspace root."),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional().describe("Extra environment variables."),
  timeout_ms: z.number().int().min(0).optional().describe("Execution deadline. 0 requests no deadline (needs approval)."),
  yield_ms: z.number().int().min(250).optional().describe("How long to wait before returning a live session. Default 10000, max 30000."),
  pty: z.boolean().optional().describe("Run in a pseudo-terminal. Not yet available."),
  background: z.boolean().optional().describe("Return once the process starts, or once `ready` resolves."),
  name: TerminalName.optional().describe("Stable session name such as dev-server."),
  ready: z
    .strictObject({
      pattern: z.string().min(1).max(500).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      timeout_ms: z.number().int().min(1).optional(),
    })
    .optional()
    .describe("Readiness condition for services: an output regex and/or a local TCP port."),
});

const Selector = z.string().min(1).max(64).describe("Terminal name or session id.");

export const TerminalControlInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("read"), terminal: Selector, cursor: Cursor.optional(), limit_lines: z.number().int().min(1).optional() }),
  z.strictObject({
    action: z.literal("wait"),
    terminal: Selector,
    event: z.enum(["ready", "output", "input_required", "exit", "pattern"]),
    pattern: z.string().min(1).max(500).optional(),
  }),
  z.strictObject({
    action: z.literal("write"),
    terminal: Selector,
    input: z.string().max(20_000).optional(),
    submit: z.boolean().optional(),
    keys: z.array(TerminalKey).max(64).optional(),
  }),
  z.strictObject({ action: z.literal("signal"), terminal: Selector, signal: TerminalSignal }),
  z.strictObject({ action: z.literal("terminate"), terminal: Selector }),
  z.strictObject({ action: z.literal("restart"), terminal: Selector }),
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
    target: z.string().min(1).max(32).optional().describe("current_task | current_goal | all_goals | gN | tN | gN/tN"),
    from: IsoDate.optional(),
    to: IsoDate.optional(),
    top_n: z.number().int().min(1).optional(),
    cursor: Cursor.optional(),
  }),
  z.strictObject({
    action: z.literal("inspect"),
    ref: z.string().min(1).max(32).optional().describe("gN, tN, gN/tN, rN, eN, gN/tN/eN, or hc-N"),
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
