import type { ToolErrorBody } from "@socrates/contracts";

/**
 * An expected, correctable tool failure (agent-harness.md, "Corrective tool
 * errors"). Handlers throw it with domain facts and a recovery hint; the
 * runner turns it into the one model-facing error shape. Anything else a
 * handler throws is an infrastructure failure.
 */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly correction: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "ToolError";
  }

  body(): ToolErrorBody {
    return { code: this.code, message: this.message, correction: this.correction, retryable: this.retryable };
  }
}

/** The safe body returned for an unexpected failure; its diagnostics stay internal. */
export const INTERNAL_ERROR: ToolErrorBody = {
  code: "internal_error",
  message: "The tool failed unexpectedly. The failure was logged.",
  correction: "Retry once. If it fails again, continue without this call or tell the user what could not be done.",
  retryable: true,
};

export function renderError(body: ToolErrorBody): string {
  return JSON.stringify({ error: body });
}
