import type { EventPayloads, ToolCall, ToolDefinition, ToolErrorBody } from "@socrates/contracts";
import { abortable, countTokens } from "@socrates/shared";
import type { SemanticSearch } from "@socrates/retrieval";
import type { LedgerStore, TaskRefs } from "@socrates/store";
import { type AccessPolicy, isProtected, protectedPath, within } from "./access";
import { RESULT_CEILING_TOKENS, headTail } from "./bounds";
import { type CapabilityCatalog, StaticCatalog } from "./catalog";
import { type ApprovalRequest, type Approve, type HandlerContext, type RunState, type ToolBinding, throwIfCancelled, requireWorkspace } from "./context";
import { toDefinition } from "./definitions";
import { INTERNAL_ERROR, ToolError, renderError } from "./errors";
import type { ToolHandler, ToolOutput } from "./handler";
import { TerminalSupervisor, type SupervisorOptions } from "./terminals";
import { applyPatchTool } from "./tools/apply-patch";
import { CapabilityRuntime, capabilityControlTool, capabilitySearchTool } from "./tools/capabilities";
import { contextRetrieveTool } from "./tools/context-retrieve";
import { editTool } from "./tools/edit";
import { readTool } from "./tools/read";
import { globTool, grepTool } from "./tools/search";
import { terminalControlTool, terminalTool } from "./tools/terminal";
import type { WorkspaceRoot } from "./workspace";

export interface ToolRunnerOptions {
  store: LedgerStore;
  approve: Approve;
  /** IANA time zone for dates shown by context_retrieve. */
  timeZone: string;
  catalog?: CapabilityCatalog;
  /** Meaning-based memory search for context_retrieve. */
  semantic?: SemanticSearch;
  terminals?: SupervisorOptions;
  /**
   * Where tools may work and when they ask (agent-harness.md, "Access"), read
   * at the start of every call so a change applies to the next one. Without
   * it, the goal's workspace is the boundary and the classic approvals apply.
   */
  access?: () => AccessPolicy | null;
  /** Receives internal diagnostics of infrastructure failures. Never shown to a model. */
  log?: (message: string) => void;
}

/** Where one call runs: its task binding, workspace, run state, and cancellation. */
export interface CallScope {
  binding: ToolBinding;
  workspace: WorkspaceRoot | null;
  run: RunState;
  signal: AbortSignal;
}

export interface ToolCallResult {
  callId: string;
  name: string;
  /** Permanent evidence handle within the task, such as "e12". */
  handle: string;
  isError: boolean;
  /** Model-facing content, never above the result ceiling. */
  content: string;
}

/**
 * The shared tool runner (agent-harness.md, "Corrective tool errors"). Every
 * call goes through one path: persist the call, validate its input, apply the
 * access and approval policy, execute, normalize any failure into the one
 * corrective-error shape, bound the result, and persist the result with its
 * file mutations. Invalid calls have no side effects beyond their own record.
 */
export class ToolRunner {
  /** The ten permanent tools, in their fixed order. */
  readonly definitions: ToolDefinition[];
  private readonly handlers: Map<string, ToolHandler>;
  private readonly supervisors = new Map<string, TerminalSupervisor>();
  /** Goal-scoped capability state: active MCP schemas, Skill revalidation, and MCP dispatch. */
  readonly capabilities: CapabilityRuntime;
  private readonly catalog: CapabilityCatalog;
  /** Emitted order belongs to a turn; one lane's tool or approval cannot block another. */
  private readonly serial = new Map<string | null, Promise<unknown>>();

  constructor(private readonly options: ToolRunnerOptions) {
    this.catalog = options.catalog ?? new StaticCatalog();
    this.capabilities = new CapabilityRuntime(options.store, this.catalog);
    const handlers: ToolHandler[] = [
      readTool,
      globTool,
      grepTool,
      editTool,
      applyPatchTool,
      terminalTool,
      terminalControlTool,
      contextRetrieveTool,
      capabilitySearchTool,
      capabilityControlTool(this.capabilities),
    ] as ToolHandler[];
    this.handlers = new Map(handlers.map((h) => [h.name, h]));
    this.definitions = handlers.map(toDefinition);
  }

  /** Whether calls to this tool may run in parallel. Unknown and MCP tools are serial. */
  concurrency(name: string): "parallel" | "serial" {
    return this.handlers.get(name)?.concurrency ?? "serial";
  }

  /** Schemas of MCP tools active for a goal, appended after the permanent tools. */
  mcpDefinitions(goalId: string, signal?: AbortSignal): Promise<ToolDefinition[]> {
    return this.capabilities.definitions(goalId, signal);
  }

  /** The terminal supervisor that owns processes started in one workspace. */
  terminals(workspace: WorkspaceRoot): TerminalSupervisor {
    let supervisor = this.supervisors.get(workspace.root);
    if (!supervisor) {
      supervisor = new TerminalSupervisor(this.options.terminals);
      this.supervisors.set(workspace.root, supervisor);
    }
    return supervisor;
  }

  async run(call: ToolCall, scope: CallScope): Promise<ToolCallResult> {
    const handler = this.handlers.get(call.name);
    const execute = () => this.execute(call, scope, handler);
    if (handler?.concurrency === "parallel") return execute();
    // Keep each turn's serial calls ordered while independent lanes work.
    // File mutation freshness/write sections still share the workspace lock.
    const key = scope.binding.turnId;
    const previous = this.serial.get(key) ?? Promise.resolve();
    const next = previous.then(execute, execute);
    const tail = next.catch(() => {});
    this.serial.set(key, tail);
    try { return await next; }
    finally { if (this.serial.get(key) === tail) this.serial.delete(key); }
  }

  async close(): Promise<void> {
    await Promise.all([...this.supervisors.values()].map((s) => s.shutdown()));
    this.supervisors.clear();
  }

  private async execute(call: ToolCall, scope: CallScope, permanent: ToolHandler | undefined): Promise<ToolCallResult> {
    const { store } = this.options;
    const refs: TaskRefs = { goal_id: scope.binding.goalId, task_id: scope.binding.taskId, chat_id: scope.binding.chatId, turn_id: scope.binding.turnId };
    const started = Date.now();
    const evidence = store.recordToolCall(refs, { callId: call.id, tool: call.name, input: call.input });

    let output: ToolOutput | null = null;
    let error: ToolErrorBody | null = null;
    let diagnostics: string | null = null;
    let failureDetail: unknown = null;
    let handler = permanent;
    try {
      throwIfCancelled(scope.signal);
      if (!handler) {
        const mcp = await this.capabilities.resolve(scope.binding.goalId, call.name, scope.signal);
        if (mcp) handler = this.capabilities.mcpHandler(call.name, mcp.name, mcp.tool, scope.binding.goalId) as ToolHandler;
      }
      if (!handler) {
        throw new ToolError("unknown_tool", `There is no tool named ${call.name}.`, `Use one of: ${[...this.handlers.keys()].join(", ")}, or an MCP tool activated with capability_control.`);
      }
      const parsed = handler.schema.safeParse(normalizeInput(call.input));
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`);
        throw new ToolError("invalid_parameters", `Invalid ${call.name} input — ${issues.join("; ")}`, `Fix the listed parameters and call ${call.name} again.`);
      }
      throwIfCancelled(scope.signal);
      const policy = this.options.access?.() ?? null;
      const ctx = this.context(scope, refs, call.name, policy);
      const mutating = typeof handler.mutating === "function" ? handler.mutating(parsed.data) : handler.mutating;
      if (mutating && policy?.approvals === "ask") {
        const input = (parsed.data ?? {}) as Record<string, unknown>;
        await ctx.requireApproval({ kind: "action", tool: call.name, detail: actionDetail(call.name, input), ...preview(call.name, input) });
      } else if (mutating && !policy && scope.workspace && store.firstMutationGatePending(scope.binding.taskId)) {
        await ctx.requireApproval({ kind: "first_mutation", tool: call.name, detail: `First change in workspace ${scope.workspace.name}: ${describe(call)}` });
      }
      output = await handler.execute(parsed.data, ctx);
      for (const m of output.mutations ?? []) {
        store.recordFileChange(refs, { call_id: call.id, path: m.path, action: m.action, from_path: m.fromPath, before: m.before, after: m.after });
      }
    } catch (caught) {
      if (scope.signal.aborted && !(caught instanceof ToolError)) caught = new ToolError("cancelled", "The call was cancelled.", "Inspect the recorded outcome before deciding whether to retry.", false);
      if (caught instanceof ToolError) {
        error = caught.body();
        failureDetail = caught.detail;
      }
      else {
        error = INTERNAL_ERROR;
        diagnostics = caught instanceof Error ? `${caught.name}: ${caught.message}\n${caught.stack ?? ""}` : String(caught);
        this.options.log?.(`tool ${call.name} (${evidence.handle}) failed: ${diagnostics}`);
      }
    }

    let content = error ? renderError(error) : output!.content;
    if (countTokens(content) > RESULT_CEILING_TOKENS) {
      content = headTail(content, RESULT_CEILING_TOKENS - 100, `the complete result is stored as ${evidence.handle}`).text;
    }
    const payload: EventPayloads["tool_completed"] = {
      call_id: call.id,
      handle: evidence.handle,
      tool: call.name,
      status: error ? "error" : "ok",
      content,
      result: output?.result ?? null,
      ...(error ? { failure_detail: failureDetail } : {}),
      error,
      diagnostics,
      observed: output?.observed ?? [],
      facts: output?.facts ?? [],
      wall_time_ms: Date.now() - started,
    };
    store.recordToolResult(refs, payload);
    return { callId: call.id, name: call.name, handle: evidence.handle, isError: error !== null, content };
  }

  private context(scope: CallScope, refs: TaskRefs, tool: string, policy: AccessPolicy | null): HandlerContext {
    const { store, approve, timeZone } = this.options;
    const ctx: HandlerContext = {
      store,
      binding: scope.binding,
      workspace: scope.workspace,
      run: scope.run,
      signal: scope.signal,
      approve,
      timeZone,
      catalog: this.catalog,
      access: policy,
      ...(this.options.semantic ? { semantic: this.options.semantic } : {}),
      resolveReadPath: async (input) => {
        throwIfCancelled(scope.signal);
        const resource = await this.capabilities.resourcePath(scope.binding.goalId, input, scope.signal);
        throwIfCancelled(scope.signal);
        return resource ?? ctx.path(input);
      },
      path: async (input, use = "read") => {
        const workspace = requireWorkspace(scope);
        if (!policy) return workspace.resolve(input, { write: use === "write" });
        const resolved = workspace.resolve(input, { write: use === "write", anywhere: true });
        if (isProtected(policy, resolved.abs)) throw protectedPath(input);
        const write = use !== "read";
        if (policy.folders && !policy.folders.some((folder) => within(folder, resolved.abs)) && !scope.run.granted(resolved.abs, write)) {
          const verb = use === "run" ? "Run commands in" : use === "write" ? "Change" : "Read";
          await ctx.requireApproval({ kind: "outside_folder", tool, detail: `${verb} ${resolved.abs}, outside your folders` });
          scope.run.grant(resolved.abs, write);
        }
        return resolved;
      },
      visible: (abs) => !policy || !isProtected(policy, abs),
      terminals: scope.workspace ? this.terminals(scope.workspace) : null,
      async requireApproval(request: ApprovalRequest) {
        // With an access policy, "ask" mode already asked about the whole call.
        if (policy && (request.kind === "sigkill" || request.kind === "no_deadline" || request.kind === "mcp_tool")) return;
        throwIfCancelled(scope.signal);
        const granted = await abortable(approve(request, scope.binding), scope.signal).catch(error => {
          throwIfCancelled(scope.signal);
          throw error;
        });
        throwIfCancelled(scope.signal);
        store.recordApproval(refs, { kind: request.kind, granted, detail: request.detail, ...(request.subject ? { subject: request.subject } : {}) });
        throwIfCancelled(scope.signal);
        if (!granted) {
          throw new ToolError("approval_denied", `The user declined: ${request.detail}`, "Do not retry this action. Continue another way, or ask the user how to proceed.", false);
        }
      },
    };
    return ctx;
  }
}

/** Providers sometimes deliver arguments as a JSON string. */
function normalizeInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}

const APPROVAL_PREVIEW_CHARS = 20_000;

/** One line naming what a changing call is about to do, for the user to approve. */
function actionDetail(tool: string, input: Record<string, unknown>): string {
  const text = (value: unknown) => String(value ?? "").slice(0, 300);
  switch (tool) {
    case "edit":
      return `Edit ${text(input.path)}${input.replace_all ? " (every occurrence)" : ""}`;
    case "apply_patch": {
      const files = [...String(input.patch).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => `${m[1]!.toLowerCase()} ${m[2]!.trim()}`);
      return `Apply a patch: ${files.join(", ").slice(0, 300) || "no files"}`;
    }
    case "terminal":
      return `Run ${text(input.command)}${input.cwd ? ` in ${text(input.cwd)}` : ""}${input.background ? " (in the background)" : ""}${input.timeout_ms === 0 ? " (without a deadline)" : ""}`;
    case "terminal_control":
      return input.action === "write" ? `Type into terminal ${text(input.terminal)}`
        : input.action === "signal" ? `Send ${text(input.signal)} to terminal ${text(input.terminal)}`
        : `${input.action === "restart" ? "Restart" : "Stop"} terminal ${text(input.terminal)}`;
    default:
      return `Use ${tool} ${JSON.stringify(input).slice(0, 200)}`;
  }
}

/** The text a changing call writes, when there is one to show before approving. */
function preview(tool: string, input: Record<string, unknown>): { preview?: string } {
  const text = tool === "edit" ? `--- replace\n${String(input.old_text)}\n+++ with\n${String(input.new_text)}`
    : tool === "apply_patch" ? String(input.patch)
    : tool === "terminal_control" && typeof input.input === "string" ? input.input
    : null;
  return text === null ? {} : { preview: text.slice(0, APPROVAL_PREVIEW_CHARS) };
}

function describe(call: ToolCall): string {
  const input = normalizeInput(call.input) as Record<string, unknown> | null;
  const detail = input && typeof input === "object" ? (input.command ?? input.path ?? "") : "";
  return `${call.name}${detail ? ` ${String(detail).slice(0, 200)}` : ""}`;
}
