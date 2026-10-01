import { AskUserInput, LedgerQueryInput, type ToolDefinition } from "@socrates/contracts";
import { type LedgerStore, LedgerQueryError, renderLedgerRow, runLedgerQuery } from "@socrates/store";
import { z } from "zod";
import type { SeenSelectors } from "./validate";

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const LEDGER_QUERY_TOOL: ToolDefinition = {
  name: "ledger_query",
  description:
    "Read-only structured search over the work ledger: one row per task with date, workspace, goal and task selectors, " +
    "title, status, and a note excerpt. Use for references outside RECENT_ACTIVITY or KNOWN_GOALS, such as " +
    '"what we did last month". Filters: from/to (YYYY-MM-DD, by last update), match (words), workspace (name), ' +
    "goal (gN or title words), task (gN/tN or title words), status, limit (default 10, max 20). At most 3 calls per routing decision.",
  inputSchema: jsonSchema(LedgerQueryInput),
};

export const ASK_USER_TOOL: ToolDefinition = {
  name: "ask_user",
  description:
    "End routing with one short clarification question when two or more goals or workspaces are plausible and a wrong " +
    "choice would materially change the work. Enumerate the candidates you considered, best guess first with " +
    "suggested: true, each with a one-line detail. Set allow_new: true to let the user start something new.",
  inputSchema: jsonSchema(AskUserInput),
};

export interface ToolError {
  code: string;
  message: string;
  correction: string;
  retryable: boolean;
}

/** The harness-wide corrective tool error shape (agent-harness.md, "Corrective tool errors"). */
export function renderToolError(error: ToolError): string {
  return JSON.stringify({ error });
}

export function executeLedgerQuery(
  store: LedgerStore,
  input: unknown,
  timeZone: string,
  seen: SeenSelectors,
): { ok: true; content: string } | { ok: false; content: string } {
  const parsed = LedgerQueryInput.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      content: renderToolError({
        code: "invalid_parameters",
        message: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
        correction: "Fix the listed parameters and call ledger_query again.",
        retryable: true,
      }),
    };
  }
  try {
    const rows = runLedgerQuery(store, parsed.data, timeZone);
    for (const row of rows) {
      seen.goals.add(Number(row.goalSelector.slice(1)));
      seen.tasks.add(row.taskSelector);
    }
    if (rows.length === 0) return { ok: true, content: "No matching ledger rows." };
    return { ok: true, content: rows.map(renderLedgerRow).join("\n") };
  } catch (error) {
    if (error instanceof LedgerQueryError) {
      return {
        ok: false,
        content: renderToolError({ code: error.code, message: error.message, correction: error.correction, retryable: true }),
      };
    }
    throw error;
  }
}
