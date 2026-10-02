import type { z } from "zod";
import type { HandlerContext } from "./context";

export interface FileMutation {
  path: string;
  action: "created" | "updated" | "deleted" | "moved";
  fromPath: string | null;
  before: string | null;
  after: string | null;
}

export type TaskFactKind = "file_changed" | "command" | "test" | "capability";

/** A handler's successful output; the runner persists and bounds it. */
export interface ToolOutput {
  /** Model-facing text, already bounded by the handler's own policy. */
  content: string;
  /** The complete structured result, stored in the event log. */
  result: unknown;
  observed?: { path: string; hash: string | null }[];
  facts?: { kind: TaskFactKind; value: string }[];
  mutations?: FileMutation[];
}

export interface ToolHandler<I = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  /** Parallel-safe calls may run concurrently; serial calls run one at a time in emitted order. */
  concurrency: "parallel" | "serial";
  /** Whether a call may change the workspace (first-mutation gate). */
  mutating: boolean | ((input: I) => boolean);
  execute(input: I, ctx: HandlerContext): Promise<ToolOutput>;
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}
