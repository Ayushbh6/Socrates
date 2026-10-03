import { CapabilityControlInput, CapabilitySearchInput, type ToolDefinition } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import type { LedgerStore } from "@socrates/store";
import { z } from "zod";
import { RESULT_CEILING_TOKENS, head } from "../bounds";
import { type CapabilityCatalog, type CatalogEntry, type LoadedMcpTool, type McpCallResult, type McpToolEntry, mcpPublicName } from "../catalog";
import { type HandlerContext, throwIfCancelled } from "../context";
import { scoreCapability } from "../discovery";
import { ToolError } from "../errors";
import { hashBytes } from "../files";
import { compileToolSchema } from "../schema";
import { type ToolHandler, json } from "../handler";

export const SEARCH_DEFAULT_LIMIT = 3;
export const SEARCH_MAX_LIMIT = 5;
export const MAX_SKILL_TOKENS = 8_000;
export const MAX_MCP_SCHEMA_TOKENS = 4_000;
export const MAX_ACTIVE_MCP_TOOLS = 16;
export const MAX_ACTIVE_MCP_SCHEMA_TOKENS = 16_000;

/**
 * The goal-scoped capability runtime. The active set is persisted in the
 * store; live MCP schemas are held per process and, when missing (a new
 * process, a reconnected server), fetched again from the catalog and
 * revalidated: a changed schema is recorded as a replacement, and a tool
 * that can no longer be loaded is left out until it can.
 */
export class CapabilityRuntime {
  private readonly byGoal = new Map<string, Map<string, { publicName: string; tool: LoadedMcpTool }>>();
  /** Validated instructions of active Skills, by goal and name, so context can be rebuilt mid-turn without loading again. */
  private readonly skillText = new Map<string, Map<string, { digest: string; instructions: string }>>();

  constructor(
    private readonly store: LedgerStore,
    readonly catalog: CapabilityCatalog,
  ) {}

  set(goalId: string, name: string, publicName: string, tool: LoadedMcpTool): void {
    if (!this.byGoal.has(goalId)) this.byGoal.set(goalId, new Map());
    this.byGoal.get(goalId)!.set(name, { publicName, tool });
  }

  delete(goalId: string, name: string): void {
    this.byGoal.get(goalId)?.delete(name);
  }

  get(goalId: string, name: string) {
    return this.byGoal.get(goalId)?.get(name);
  }

  rememberSkill(goalId: string, name: string, digest: string, instructions: string): void {
    if (!this.skillText.has(goalId)) this.skillText.set(goalId, new Map());
    this.skillText.get(goalId)!.set(name, { digest, instructions });
  }

  /**
   * The goal's active Skills and MCP public names as they are now, for
   * `<ACTIVE_CAPABILITIES>`. Synchronous: Skills come from the instructions
   * validated by activeSkills or by activation, so a Skill activated earlier
   * in this turn is present when compaction rebuilds the context.
   */
  current(goalId: string): { skills: { name: string; instructions: string }[]; mcpTools: string[] } {
    const skills: { name: string; instructions: string }[] = [];
    const mcpTools: string[] = [];
    for (const c of this.store.listActiveCapabilities(goalId)) {
      if (c.kind === "skill") {
        const text = this.skillText.get(goalId)?.get(c.name);
        if (text && text.digest === c.digest) skills.push({ name: c.name, instructions: text.instructions });
      } else {
        const loaded = this.get(goalId, c.name);
        if (loaded) mcpTools.push(loaded.publicName);
      }
    }
    return { skills, mcpTools: mcpTools.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) };
  }

  /** Refresh the goal's active schemas for the next model request. */
  async rehydrate(goalId: string): Promise<void> {
    const active = this.store.listActiveCapabilities(goalId).filter((c) => c.kind === "mcp");
    const refreshed: { item: typeof active[number]; entry: McpToolEntry; tool: LoadedMcpTool; digest: string }[] = [];
    let total = 0;
    for (const item of active) {
      const entry = this.catalog.entries().find((e): e is McpToolEntry => e.kind === "mcp" && e.name === item.name);
      if (!entry || entry.availability !== "available") continue;
      let tool: LoadedMcpTool;
      try { tool = await this.catalog.loadMcpTool(entry.name); }
      catch { continue; }
      if (validateSchema(entry.name, tool)) continue;
      total += countTokens(JSON.stringify(tool.inputSchema));
      const digest = hashBytes(JSON.stringify(tool.inputSchema));
      refreshed.push({ item, entry, tool, digest });
    }
    if (active.length > MAX_ACTIVE_MCP_TOOLS || total > MAX_ACTIVE_MCP_SCHEMA_TOKENS) {
      throw new ToolError("too_many_active_tools", "The refreshed active MCP schemas exceed the goal's limits.", "Deactivate tools before continuing.");
    }
    // Validate the complete set before replacing persisted digests or cached
    // definitions, so a failed refresh cannot leave a partial replacement.
    this.byGoal.set(goalId, new Map());
    for (const { item, entry, tool, digest } of refreshed) {
      if (digest !== item.digest || tool.schemaVersion !== item.version) this.store.activateCapability(goalId, { kind: "mcp", name: entry.name, version: tool.schemaVersion, digest });
      this.set(goalId, entry.name, mcpPublicName(entry.server, entry.tool), tool);
    }
  }

  async definitions(goalId: string): Promise<ToolDefinition[]> {
    await this.rehydrate(goalId);
    return this.store.listActiveCapabilities(goalId).flatMap((c) => {
      const entry = c.kind === "mcp" ? this.get(goalId, c.name) : undefined;
      return entry ? [{ name: entry.publicName, description: entry.tool.description, inputSchema: entry.tool.inputSchema }] : [];
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Revalidate at dispatch; a schema changed since surfacing must never execute. */
  async resolve(goalId: string, publicName: string): Promise<{ name: string; tool: LoadedMcpTool } | null> {
    const active = this.store.listActiveCapabilities(goalId).filter((c) => c.kind === "mcp");
    const entries = this.catalog.entries();
    const entry = entries.find((e): e is McpToolEntry => e.kind === "mcp" && mcpPublicName(e.server, e.tool) === publicName && active.some((c) => c.name === e.name));
    if (!entry) return null;
    if (entry.availability !== "available") {
      this.delete(goalId, entry.name);
      throw new ToolError("capability_unavailable", `${entry.name} is ${entry.availability}.`, "Search or activate it again once available.");
    }
    let tool: LoadedMcpTool;
    try { tool = await this.catalog.loadMcpTool(entry.name); }
    catch {
      this.delete(goalId, entry.name);
      throw new ToolError("capability_unavailable", `${entry.name} could not be reached.`, "Search or activate it again.");
    }
    const invalid = validateSchema(entry.name, tool);
    if (invalid) { this.delete(goalId, entry.name); throw invalid; }
    const original = active.find((c) => c.name === entry.name)!;
    if (hashBytes(JSON.stringify(tool.inputSchema)) !== original.digest) {
      this.delete(goalId, entry.name);
      throw new ToolError("tool_schema_changed", `${entry.name} changed its schema since it was made available.`, "Activate it again or refresh the tool definitions before retrying.");
    }
    this.set(goalId, entry.name, publicName, tool);
    return { name: entry.name, tool };
  }

  /**
   * Instructions of the goal's active Skills that are still exactly the
   * activated version, for the goal's context. A Skill whose content changed
   * or cannot be loaded is reported as stale instead of silently replaced.
   */
  async activeSkills(goalId: string): Promise<{ skills: { name: string; version: string; instructions: string }[]; stale: string[] }> {
    const skills: { name: string; version: string; instructions: string }[] = [];
    const stale: string[] = [];
    for (const active of this.store.listActiveCapabilities(goalId)) {
      if (active.kind !== "skill") continue;
      const entry = this.catalog.entries().find((e) => e.kind === "skill" && e.name === active.name);
      if (!entry || entry.availability !== "available") { stale.push(active.name); continue; }
      try {
        const skill = await this.catalog.loadSkill(active.name);
        if (skill.version === active.version && countTokens(skill.instructions) <= MAX_SKILL_TOKENS && hashBytes(skill.instructions) === active.digest) {
          skills.push({ name: active.name, version: skill.version, instructions: skill.instructions });
          this.rememberSkill(goalId, active.name, active.digest, skill.instructions);
        } else stale.push(active.name);
      } catch {
        stale.push(active.name);
      }
    }
    return { skills, stale };
  }

  /** A handler that dispatches calls of one active MCP tool to its server. */
  mcpHandler(publicName: string, name: string, tool: LoadedMcpTool, goalId: string): ToolHandler<Record<string, unknown>> {
    const validate = compileToolSchema(name, tool.inputSchema);
    return {
      name: publicName,
      description: tool.description,
      schema: z.record(z.string(), z.unknown()).superRefine((input, issue) => {
        if (!validate(input)) for (const error of (validate.errors ?? []).slice(0, 8)) {
          issue.addIssue({ code: "custom", message: `${error.instancePath || "(input)"}: ${error.message}` });
        }
      }),
      concurrency: "serial",
      mutating: !tool.readOnly,
      execute: async (input, ctx) => {
        // A tool the server does not mark read-only asks the user once per goal; the answer is remembered.
        if (!tool.readOnly && !ctx.store.mcpToolApproved(goalId, name)) {
          await ctx.requireApproval({ kind: "mcp_tool", tool: publicName, subject: name, detail: `Allow the MCP tool ${name} for this goal? It may change things outside Socrates. First call: ${head(JSON.stringify(input), 60).text}` });
        }
        let result: McpCallResult;
        try {
          result = await this.catalog.callMcpTool(name, input, ctx.signal);
        } catch {
          throwIfCancelled(ctx.signal);
          this.delete(goalId, name);
          throw new ToolError("capability_unavailable", `${name} could not be reached.`, "Search for it with capability_search and activate it again, or continue without it.");
        }
        if (ctx.signal.aborted) throw new ToolError("cancelled", "The MCP call was cancelled.", "Inspect its recorded outcome before deciding whether to retry.", false, result);
        const facts = [{ kind: "capability" as const, value: `mcp ${name}` }];
        if (result.isError) {
          throw new ToolError("mcp_tool_error", `${publicName} returned an error: ${head(result.content, 400).text}`, "Check the input against the tool's schema, or continue without it.", true, { content: result.content });
        }
        const shown = head(result.content, RESULT_CEILING_TOKENS - 200, "the complete result is stored with this call");
        return { content: shown.text, result: { content: result.content, truncated: shown.truncated }, facts };
      },
    };
  }
}

/** A reason the advertised schema cannot be used, or null when it is valid. */
function validateSchema(name: string, tool: LoadedMcpTool): ToolError | null {
  if (tool.inputSchema.type !== "object") {
    return new ToolError("invalid_tool_schema", `${name} advertises an input schema that is not an object.`, "Continue without this tool, or search for an alternative.", false);
  }
  const tokens = countTokens(JSON.stringify(tool.inputSchema));
  if (tokens > MAX_MCP_SCHEMA_TOKENS) {
    return new ToolError("tool_schema_too_large", `${name} has a ${tokens}-token schema, above the ${MAX_MCP_SCHEMA_TOKENS}-token bound.`, "Continue without this tool, or search for an alternative.", false);
  }
  try { compileToolSchema(name, tool.inputSchema); }
  catch (error) { return error as ToolError; }
  return null;
}

function activeNames(ctx: HandlerContext): Set<string> {
  return new Set(ctx.store.listActiveCapabilities(ctx.binding.goalId).map((c) => c.name));
}

export const capabilitySearchTool: ToolHandler<CapabilitySearchInput> = {
  name: "capability_search",
  description: [
    "Search the catalog of installed Skills (instructions for a kind of task) and MCP tools (external callable tools) without loading them.",
    `kind: any (default), skill, or mcp. limit defaults to ${SEARCH_DEFAULT_LIMIT} (max ${SEARCH_MAX_LIMIT}). Each match has a short ref such as c1; activate it with capability_control.`,
    "Use it when the Skill shelf and candidates do not cover a need, for example browser testing or reading an issue tracker.",
  ].join(" "),
  schema: CapabilitySearchInput,
  concurrency: "parallel",
  mutating: false,
  async execute(input, ctx) {
    const kind = input.kind ?? "any";
    const limit = Math.min(input.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
    const ranked = ctx.catalog
      .entries()
      .filter((e) => kind === "any" || e.kind === kind)
      .map((entry) => ({ entry, score: scoreCapability(entry, input.query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name));
    // With kind any, the best result of each kind is reserved so one large catalog cannot starve the other.
    let chosen = ranked.slice(0, limit);
    if (kind === "any" && limit >= 2) {
      const bestSkill = ranked.find((r) => r.entry.kind === "skill");
      const bestMcp = ranked.find((r) => r.entry.kind === "mcp");
      const reserved = [bestSkill, bestMcp].filter((r): r is NonNullable<typeof r> => !!r);
      chosen = [...reserved, ...ranked.filter((r) => !reserved.includes(r))].slice(0, limit).sort((a, b) => b.score - a.score);
    }
    const active = activeNames(ctx);
    const matches = chosen.map(({ entry }) => {
      const ref = ctx.run.issueRef("c", { kind: "capability", entryKind: entry.kind, name: entry.name, goalId: ctx.binding.goalId });
      return entry.kind === "skill"
        ? { ref, name: entry.name, kind: "skill", description: entry.description, provider: entry.provider, availability: entry.availability, active: active.has(entry.name) }
        : { ref, name: entry.name, kind: "mcp", description: entry.description, server: entry.server, tool: entry.tool, availability: entry.availability, active: active.has(entry.name) };
    });
    const result: Record<string, unknown> = { query: input.query, kind, matches, returned: matches.length, more_matches: ranked.length > matches.length };
    if (!matches.length) result.note = "No capability matched. Try a shorter query naming the task or service, for example \"pdf\" or \"github issue\".";
    return { content: json(result), result };
  },
};

export function capabilityControlTool(loaded: CapabilityRuntime): ToolHandler<CapabilityControlInput> {
  return {
    name: "capability_control",
    description: [
      'Activate one capability found by capability_search ({"action":"activate","ref":"c1"}), list the active ones ({"action":"list"}), or deactivate one by name.',
      "Activating a Skill returns its full instructions in the result: follow them. Activating an MCP tool makes it callable from your next step under the returned public_name. Activation lasts for the current goal.",
    ].join(" "),
    schema: CapabilityControlInput,
    concurrency: "serial",
    mutating: false,
    async execute(input, ctx) {
      const goalId = ctx.binding.goalId;
      const refs = { task_id: ctx.binding.taskId, chat_id: ctx.binding.chatId, turn_id: ctx.binding.turnId };
      if (input.action === "list") {
        await loaded.rehydrate(goalId);
        const active = ctx.store.listActiveCapabilities(goalId).map((c) => ({
          kind: c.kind,
          name: c.name,
          version: c.version,
          ...(c.kind === "mcp" ? { public_name: loaded.get(goalId, c.name)?.publicName ?? null } : {}),
        }));
        const result = { action: "list", active };
        return { content: json(result), result };
      }

      if (input.action === "deactivate") {
        const active = ctx.store.listActiveCapabilities(goalId);
        const target = active.find((c) => c.name === input.name || (c.kind === "mcp" && ctx.catalog.entries().some((e) => e.kind === "mcp" && e.name === c.name && mcpPublicName(e.server, e.tool) === input.name)));
        if (!target) {
          throw new ToolError("capability_not_active", `${input.name} is not active for this goal.${active.length ? ` Active: ${active.map((c) => c.name).join(", ")}.` : ""}`, "Use capability_control list to see the active names.");
        }
        ctx.store.deactivateCapability(goalId, target.name, refs);
        loaded.delete(goalId, target.name);
        const result = { action: "deactivate", kind: target.kind, name: target.name, status: "deactivated" };
        return { content: json(result), result };
      }

      const ref = ctx.run.ref(input.ref);
      if (!ref || ref.kind !== "capability" || ref.goalId !== goalId) {
        throw new ToolError("unknown_capability_ref", `${input.ref} is not a capability reference from this run.`, "Search again with capability_search and activate a ref it returns.");
      }
      const entry = ctx.catalog.entries().find((e) => e.kind === ref.entryKind && e.name === ref.name);
      if (!entry) throw new ToolError("capability_unavailable", `${ref.name} is no longer in the catalog.`, "Search again with capability_search.");
      if (entry.availability === "authentication_required") {
        throw new ToolError("authentication_required", `${entry.name} needs credentials before it can be used.`, "Tell the user this server needs its credentials configured in ~/.socrates/mcp.json; do not ask for credentials.", false);
      }
      if (entry.availability !== "available") {
        throw new ToolError("capability_unavailable", `${entry.name} is ${entry.availability}.`, "Continue without it, or search for an alternative.", false);
      }
      const current = ctx.store.listActiveCapabilities(goalId);
      const existing = current.find((c) => c.name === entry.name);

      if (entry.kind === "skill") {
        const skill = await ctx.catalog.loadSkill(entry.name);
        if (existing && existing.version === skill.version && existing.digest === hashBytes(skill.instructions)) {
          const result = { kind: "skill", name: entry.name, status: "already_active", version: skill.version };
          return { content: json(result), result };
        }
        if (countTokens(skill.instructions) > MAX_SKILL_TOKENS) {
          throw new ToolError("skill_too_large", `${entry.name} instructions exceed ${MAX_SKILL_TOKENS} tokens and cannot be loaded whole.`, "Continue without this Skill, or tell the user it needs to be shortened.", false);
        }
        const catalog = ctx.catalog.entries();
        const dependencies = skill.dependencies.map((name) => {
          const dep = catalog.find((e) => e.name === name);
          const status = !dep ? "unavailable" : current.some((c) => c.name === name) ? "active" : dep.availability === "available" ? "inactive" : dep.availability;
          return { kind: dep?.kind ?? "unknown", name, status };
        });
        const result = { kind: "skill", name: entry.name, status: "activated", version: skill.version, instructions: skill.instructions, resource_base: skill.resourceBase, dependencies };
        if (countTokens(json(result)) > RESULT_CEILING_TOKENS) throw new ToolError("skill_too_large", `${entry.name} and its metadata exceed the result ceiling.`, "Shorten the Skill or continue without it.", false);
        throwIfCancelled(ctx.signal);
        ctx.store.activateCapability(goalId, { kind: "skill", name: entry.name, version: skill.version, digest: hashBytes(skill.instructions) }, refs);
        loaded.rememberSkill(goalId, entry.name, hashBytes(skill.instructions), skill.instructions);
        return { content: json(result), result, facts: [{ kind: "capability", value: `skill ${entry.name}` }] };
      }

      let tool: LoadedMcpTool;
      try { tool = await ctx.catalog.loadMcpTool(entry.name, { fresh: true }); }
      catch { throw new ToolError("capability_unavailable", `${entry.name} could not be reached.`, "Continue without it, or search for an alternative.", false); }
      const publicName = mcpPublicName(entry.server, entry.tool);
      const invalid = validateSchema(entry.name, tool);
      if (invalid) throw invalid;
      const schemaTokens = countTokens(JSON.stringify(tool.inputSchema));
      const digest = hashBytes(JSON.stringify(tool.inputSchema));
      if (existing && existing.digest === digest && existing.version === tool.schemaVersion && loaded.get(goalId, entry.name)) {
        const result = { kind: "mcp", name: entry.name, status: "already_active", public_name: publicName, schema_version: tool.schemaVersion };
        return { content: json(result), result };
      }
      await loaded.rehydrate(goalId);
      throwIfCancelled(ctx.signal);
      const otherMcp = current.filter((c) => c.kind === "mcp" && c.name !== entry.name);
      const otherTokens = otherMcp.reduce((sum, c) => sum + countTokens(JSON.stringify(loaded.get(goalId, c.name)?.tool.inputSchema ?? {})), 0);
      if (otherMcp.length >= MAX_ACTIVE_MCP_TOOLS || otherTokens + schemaTokens > MAX_ACTIVE_MCP_SCHEMA_TOKENS) {
        throw new ToolError(
          "too_many_active_tools",
          `Activating ${entry.name} would exceed the active MCP tool limit (${MAX_ACTIVE_MCP_TOOLS} tools, ${MAX_ACTIVE_MCP_SCHEMA_TOKENS} schema tokens). Active: ${otherMcp.map((c) => c.name).join(", ")}.`,
          "Deactivate tools you no longer need with capability_control deactivate, then retry.",
        );
      }
      ctx.store.activateCapability(goalId, { kind: "mcp", name: entry.name, version: tool.schemaVersion, digest }, refs);
      loaded.set(goalId, entry.name, publicName, tool);
      const result = { kind: "mcp", name: entry.name, status: "activated", server: entry.server, tool: entry.tool, public_name: publicName, connection: tool.connection, schema_version: tool.schemaVersion, available_on_next_step: true };
      return { content: json(result), result, facts: [{ kind: "capability", value: `mcp ${entry.name}` }] };
    },
  };
}
