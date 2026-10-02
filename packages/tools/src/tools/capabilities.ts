import { CapabilityControlInput, CapabilitySearchInput, type ToolDefinition } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import type { LedgerStore } from "@socrates/store";
import { z } from "zod";
import { RESULT_CEILING_TOKENS, head } from "../bounds";
import { type CapabilityCatalog, type CatalogEntry, type LoadedMcpTool, type McpCallResult, type McpToolEntry, mcpPublicName } from "../catalog";
import type { HandlerContext } from "../context";
import { ToolError } from "../errors";
import { hashBytes } from "../files";
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

  /** Load and revalidate every active MCP tool of a goal that this process does not hold. */
  async rehydrate(goalId: string): Promise<void> {
    for (const active of this.store.listActiveCapabilities(goalId)) {
      if (active.kind !== "mcp" || this.get(goalId, active.name)) continue;
      const entry = this.catalog.entries().find((e): e is McpToolEntry => e.kind === "mcp" && e.name === active.name);
      if (!entry || entry.availability !== "available") continue;
      try {
        const tool = await this.catalog.loadMcpTool(entry.name);
        if (validateSchema(entry.name, tool)) continue;
        const digest = hashBytes(JSON.stringify(tool.inputSchema));
        if (digest !== active.digest) this.store.activateCapability(goalId, { kind: "mcp", name: entry.name, version: tool.schemaVersion, digest });
        this.set(goalId, entry.name, mcpPublicName(entry.server, entry.tool), tool);
      } catch {
        // Unreachable now; left out of the tool list and retried on the next request.
      }
    }
  }

  /** Active MCP tool schemas in deterministic public-name order, appended after the permanent tools. */
  async definitions(goalId: string): Promise<ToolDefinition[]> {
    await this.rehydrate(goalId);
    const loaded = this.byGoal.get(goalId);
    return this.store
      .listActiveCapabilities(goalId)
      .flatMap((c) => {
        const entry = c.kind === "mcp" ? loaded?.get(c.name) : undefined;
        return entry ? [{ name: entry.publicName, description: entry.tool.description, inputSchema: entry.tool.inputSchema }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** The active MCP tool of a goal behind a public name, if any. */
  async resolve(goalId: string, publicName: string): Promise<{ name: string; tool: LoadedMcpTool } | null> {
    await this.rehydrate(goalId);
    for (const [name, entry] of this.byGoal.get(goalId) ?? []) if (entry.publicName === publicName) return { name, tool: entry.tool };
    return null;
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
      try {
        const skill = await this.catalog.loadSkill(active.name);
        if (hashBytes(skill.instructions) === active.digest) skills.push({ name: active.name, version: skill.version, instructions: skill.instructions });
        else stale.push(active.name);
      } catch {
        stale.push(active.name);
      }
    }
    return { skills, stale };
  }

  /** A handler that dispatches calls of one active MCP tool to its server. */
  mcpHandler(publicName: string, name: string, tool: LoadedMcpTool, goalId: string): ToolHandler<Record<string, unknown>> {
    const required = Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
    return {
      name: publicName,
      description: tool.description,
      schema: z.record(z.string(), z.unknown()).superRefine((input, issue) => {
        for (const key of required) if (!(key in input)) issue.addIssue({ code: "custom", path: [key], message: "Required." });
      }),
      concurrency: "serial",
      mutating: false,
      execute: async (input, ctx) => {
        let result: McpCallResult;
        try {
          result = await this.catalog.callMcpTool(name, input, ctx.signal);
        } catch {
          this.delete(goalId, name);
          throw new ToolError("capability_unavailable", `${name} could not be reached.`, "Search for it with capability_search and activate it again, or continue without it.");
        }
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
  return null;
}

function terms(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].filter((t) => t.length > 1);
}

/** Deterministic catalog ranking: exact names, then aliases, tags, and description words. */
function score(entry: CatalogEntry, query: string): number {
  const q = query.trim().toLowerCase();
  const name = entry.name.toLowerCase();
  if (name === q || (entry.kind === "mcp" && entry.tool.toLowerCase() === q)) return 1000;
  if (entry.aliases.some((a) => a.toLowerCase() === q)) return 800;
  const words = terms(q);
  let s = name.includes(q) ? 300 : 0;
  const nameTerms = terms(entry.name.replace(/[._-]/g, " "));
  const tagTerms = entry.tags.flatMap((t) => terms(t));
  const descTerms = terms(entry.description);
  for (const w of words) {
    if (nameTerms.includes(w)) s += 40;
    if (entry.aliases.some((a) => terms(a).includes(w))) s += 30;
    if (tagTerms.includes(w)) s += 15;
    if (descTerms.includes(w)) s += 5;
  }
  return s;
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
      .map((entry) => ({ entry, score: score(entry, input.query) }))
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
        const target = active.find((c) => c.name === input.name || loaded.get(goalId, c.name)?.publicName === input.name);
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
        throw new ToolError("authentication_required", `${entry.name} needs the user to sign in before it can be used.`, "Tell the user to connect it in Socrates settings; do not ask for credentials.", false);
      }
      if (entry.availability !== "available") {
        throw new ToolError("capability_unavailable", `${entry.name} is ${entry.availability}.`, "Continue without it, or search for an alternative.", false);
      }
      const current = ctx.store.listActiveCapabilities(goalId);
      const existing = current.find((c) => c.name === entry.name);

      if (entry.kind === "skill") {
        const skill = await ctx.catalog.loadSkill(entry.name);
        if (existing && existing.version === skill.version) {
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
        ctx.store.activateCapability(goalId, { kind: "skill", name: entry.name, version: skill.version, digest: hashBytes(skill.instructions) }, refs);
        const result = { kind: "skill", name: entry.name, status: "activated", version: skill.version, instructions: skill.instructions, resource_base: skill.resourceBase, dependencies };
        return { content: json(result), result, facts: [{ kind: "capability", value: `skill ${entry.name}` }] };
      }

      const tool = await ctx.catalog.loadMcpTool(entry.name);
      const publicName = mcpPublicName(entry.server, entry.tool);
      const invalid = validateSchema(entry.name, tool);
      if (invalid) throw invalid;
      const schemaTokens = countTokens(JSON.stringify(tool.inputSchema));
      const digest = hashBytes(JSON.stringify(tool.inputSchema));
      if (existing && existing.digest === digest && loaded.get(goalId, entry.name)) {
        const result = { kind: "mcp", name: entry.name, status: "already_active", public_name: publicName, schema_version: tool.schemaVersion };
        return { content: json(result), result };
      }
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
