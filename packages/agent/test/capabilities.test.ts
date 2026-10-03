import type { ModelRequest } from "@socrates/contracts";
import { countTokens } from "@socrates/shared";
import { LedgerStore } from "@socrates/store";
import { type CatalogEntry, type LoadedMcpTool, type LoadedSkill, StaticCatalog, ToolRunner } from "@socrates/tools";
import { describe, expect, it } from "vitest";
import { AGENT_SYSTEM_PROMPT, refreshCapabilityContext } from "../src";
import { continueTask } from "../../router/test/helpers";
import { call, contextParts, contextText, final, world } from "./helpers";

const INSTRUCTIONS = "# Release notes\nOpen every answer with the line RELEASE-NOTES-MARKER and list changes as bullets.";
const skill = (name: string, description: string): CatalogEntry => ({ kind: "skill", name, description, tags: [], aliases: [], provider: "user", availability: "available" });
const TICKET: CatalogEntry = { kind: "mcp", name: "tracker.ticket_get", server: "tracker", tool: "ticket_get", description: "Read one ticket from the issue tracker by its id.", tags: [], aliases: [], availability: "available", readOnly: true };
const TICKET_TOOL: LoadedMcpTool = { schemaVersion: "1", description: TICKET.description, connection: "connected", readOnly: true, inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } };
const LOADED: LoadedSkill = { version: "v1", instructions: INSTRUCTIONS, resourceBase: { kind: "directory", path: "/skills/release-notes" }, dependencies: [] };

function catalog() {
  return new StaticCatalog(
    [skill("release-notes", "Write release notes from merged changes."), skill("pdf", "Read and create PDF files."), TICKET],
    { "release-notes": LOADED },
    { "tracker.ticket_get": TICKET_TOOL },
    { "tracker.ticket_get": (input) => ({ content: `Ticket ${String(input.id)}: checkout fails above 50 items.`, isError: false }) },
  );
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;
const requestText = (r: ModelRequest) => r.messages.map((m) => (typeof m.content === "string" ? m.content : m.content.map((p) => p.text).join(""))).join("\n");

describe("capabilities in the working context", () => {
  it("places the frozen shelf with the goal-stable blocks and per-turn candidates just before the message", async () => {
    const w = await world();
    const c = catalog();
    const first = w.socrates([continueTask()], [final()], { catalog: c, shelf: { pins: ["pdf"] } });
    await first.socrates.handle("Look at ticket 42 in the tracker.");
    const parts = contextParts(first.model.requests[0]!);
    expect(parts[0]!.text).toContain("</GOAL>\n\n<AVAILABLE_SKILLS>\n- pdf: Read and create PDF files.\n- release-notes: Write release notes from merged changes.\n</AVAILABLE_SKILLS>");
    expect(parts.at(-1)!.text).toContain("<CAPABILITY_CANDIDATES>\n- mcp c1: tracker.ticket_get — Read one ticket from the issue tracker by its id. (matched: ticket, tracker)\n</CAPABILITY_CANDIDATES>\n\n<CURRENT_USER_MESSAGE>");

    const second = w.socrates([continueTask()], [final()], { catalog: c });
    await second.socrates.handle("Now write the release notes.");
    const next = contextParts(second.model.requests[0]!);
    // The goal-stable part is byte-identical across turns; candidates follow the new message.
    expect(next[0]!.text).toBe(parts[0]!.text);
    expect(next.at(-1)!.text).toContain("- skill c1: release-notes");
    expect(next.at(-1)!.text).not.toContain("tracker.ticket_get");
  });

  it("closes the catalog's connections when Socrates closes", async () => {
    const w = await world();
    const c = catalog();
    let closed = 0;
    Object.assign(c, { close: async () => void closed++ });
    const { socrates } = w.socrates([continueTask()], [final()], { catalog: c });
    await socrates.handle("Look at ticket 42 in the tracker.");
    await socrates.close();
    expect(closed).toBe(1);
  });

  it("makes an MCP tool activated mid-turn callable on the next step", async () => {
    const w = await world();
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] },
      { toolCalls: [call("mcp__tracker__ticket_get", { id: "42" })] },
      final({ full_answer: "Ticket 42: checkout fails above 50 items." }),
    ], { catalog: catalog() });
    const result = await socrates.handle("Look at ticket 42 in the tracker.");
    expect(result).toMatchObject({ kind: "answered", text: "Ticket 42: checkout fails above 50 items." });
    expect(model.requests[0]!.tools!.map((t) => t.name)).not.toContain("mcp__tracker__ticket_get");
    expect(model.requests[1]!.tools!.at(-1)).toMatchObject({ name: "mcp__tracker__ticket_get", inputSchema: TICKET_TOOL.inputSchema });
    expect(model.requests[2]!.messages.at(-1)).toMatchObject({ role: "tool", content: "Ticket 42: checkout fails above 50 items." });
    expect(model.requests[2]!.messages.at(-1)).not.toMatchObject({ isError: true });
    // The read-only tool needed no approval.
    expect(w.approvals).toEqual([]);
  });

  it("carries an activated Skill once: in ACTIVE_CAPABILITIES, with a one-line activation in history", async () => {
    const w = await world();
    const c = catalog();
    const first = w.socrates([continueTask()], [
      { toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] },
      final({ full_answer: "RELEASE-NOTES-MARKER\n- Fixed checkout." }),
    ], { catalog: c });
    await first.socrates.handle("Write the release notes.");
    // Within the activating turn, the instructions arrive once, as the tool result.
    expect(occurrences(requestText(first.model.requests[1]!), "RELEASE-NOTES-MARKER and list")).toBe(1);

    const second = w.socrates([continueTask()], [final()], { catalog: c });
    await second.socrates.handle("Add one more bullet.");
    const text = requestText(second.model.requests[0]!);
    expect(occurrences(text, "RELEASE-NOTES-MARKER and list")).toBe(1);
    expect(text).toContain(`<ACTIVE_CAPABILITIES>\nSkill release-notes:\n${INSTRUCTIONS}`);
    expect(text).toMatch(/TOOL CALL \[e1\] capability_control activate c1 → skill release-notes activated \(its instructions are in ACTIVE_CAPABILITIES while it stays active\)/);
    // The active Skill is no longer suggested.
    expect(text).not.toContain("<CAPABILITY_CANDIDATES>");
  });

  it("keeps a Skill activated earlier in the turn when compaction rebuilds the context", async () => {
    const BASE = (() => {
      const store = LedgerStore.open({ path: ":memory:" });
      const runner = new ToolRunner({ store, timeZone: "UTC", approve: async () => true });
      const tokens = countTokens(AGENT_SYSTEM_PROMPT) + countTokens(JSON.stringify(runner.definitions)) + 32;
      void runner.close();
      store.close();
      return tokens;
    })();
    const bigFile = Array.from({ length: 60 }, (_, i) => `line ${i}: configuration value for the server module number ${i}`).join("\n");
    const readBig = { toolCalls: [call("read", { path: "big.txt" })] };
    const w = await world({ files: { "big.txt": bigFile } });
    const { socrates, model } = w.socrates([continueTask()], [
      { toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] },
      readBig, readBig, readBig, readBig,
      final(),
    ], { catalog: catalog(), budgets: { trigger: BASE + 2_600, target: BASE + 1_700, ceiling: BASE + 60_000, verbatimWindow: 900, intactWindow: 1_200, previousTurn: 600, retrievedMax: 1_000 } });
    await socrates.handle("Write the release notes after reading big.txt a few times.");
    const after = model.requests.find((r) => contextText(r).includes("earlier tool activity of this turn"))!;
    const text = contextText(after);
    expect(text).toContain("TOOL CALL [e1] capability_control activate c1 → skill release-notes activated");
    expect(text).toContain(`<ACTIVE_CAPABILITIES>\nSkill release-notes:\n${INSTRUCTIONS}`);
    expect(occurrences(requestText(after), "RELEASE-NOTES-MARKER and list")).toBe(1);
  });
});

describe("PR4 capability lifecycle closure", () => {
  it.each(["edited", "removed", "unreadable"])("withholds a %s Skill in the same process and reports how to recover", async (change) => {
    const w = await world(); const c = catalog();
    const { socrates, model } = w.socrates([continueTask(), continueTask()], [
      { toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] }, final(), final(),
    ], { catalog: c });
    await socrates.handle("Use release-notes.");
    if (change === "removed") c.entries().splice(c.entries().findIndex((e) => e.name === "release-notes"), 1);
    else c.loadSkill = async () => {
      if (change === "unreadable") throw new Error("File unreadable");
      return { ...LOADED, version: "v2", instructions: "NEW_SKILL_BODY" };
    };
    await socrates.handle("Continue.");
    const text = requestText(model.requests[2]!);
    expect(text).not.toContain(INSTRUCTIONS);
    expect(text).not.toContain("NEW_SKILL_BODY");
    expect(text).toContain("Stale Skills (instructions withheld; search and activate again): release-notes");
  });

  it.each(["same turn", "later turn"])("removes deactivated Skill instructions from the next request in the %s", async (when) => {
    const w = await world();
    const activate = { toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] };
    const deactivate = { toolCalls: [call("capability_control", { action: "deactivate", name: "release-notes" })] };
    const later = when === "later turn";
    const { socrates, model } = w.socrates(later ? [continueTask(), continueTask()] : [continueTask()], later ? [activate, final(), deactivate, final()] : [activate, deactivate, final()], { catalog: catalog() });
    await socrates.handle("Use release-notes, then deactivate it.");
    if (later) await socrates.handle("Deactivate release-notes.");
    expect(requestText(model.requests.at(-1)!)).not.toContain(INSTRUCTIONS);
    expect(w.store.listActiveCapabilities(w.goalId)).toEqual([]);
    const original = w.store.listEvents({ type: "tool_completed" }).find((e) => JSON.stringify(e.payload).includes("RELEASE-NOTES-MARKER and list"));
    expect(original).toBeDefined(); // exact evidence was not rewritten
  });

  it("retains Skill resource metadata after history is linearized and after restart", async () => {
    const w = await world(); const c = catalog();
    const first = w.socrates([continueTask()], [{ toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] }, final()], { catalog: c });
    await first.socrates.handle("Use release-notes.");
    const second = w.socrates([continueTask()], [final()], { catalog: c });
    await second.socrates.handle("Continue the release notes.");
    const text = contextText(second.model.requests[0]!);
    expect(text).toContain('resource_base: {"kind":"directory","path":"/skills/release-notes"}');
    expect(occurrences(text, INSTRUCTIONS)).toBe(1);
  });

  it("bounds a stalled post-step schema refresh by the turn deadline and makes a tool-free wrap-up", async () => {
    const w = await world(); const c = catalog(); const load = c.loadMcpTool.bind(c);
    let loads = 0; let refreshSignal: AbortSignal | undefined;
    c.loadMcpTool = async (name: string, options?: { signal?: AbortSignal }) => {
      if (++loads === 1) return load(name);
      refreshSignal = options?.signal;
      return new Promise<LoadedMcpTool>(() => {}); // provider ignores cancellation
    };
    const { socrates, model } = w.socrates([continueTask()], [{ toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] }, final()], { catalog: c, limits: { maxWallMs: 100, finalizationMs: 1000 } });
    const result = await socrates.handle("Use tracker.ticket_get.");
    expect(result.kind).toBe("answered");
    if (result.kind === "answered") expect(result.parts[0]!.stop).toBe("time");
    expect(refreshSignal?.aborted).toBe(true);
    expect(model.requests.at(-1)!.toolChoice).toBe("none");
  });
});

it("cancels a stalled active-tool restoration before any worker request", async () => {
  const w = await world(); const c = catalog(); const controller = new AbortController();
  const { socrates, model } = w.socrates([continueTask(), continueTask()], [{ toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] }, final()], { catalog: c });
  await socrates.handle("Use tracker.ticket_get.");
  let signal: AbortSignal | undefined;
  c.loadMcpTool = async (_name: string, options?: { signal?: AbortSignal }) => {
    signal = options?.signal; controller.abort(); return new Promise<LoadedMcpTool>(() => {});
  };
  const result = await socrates.handle("Continue.", { signal: controller.signal });
  expect(signal?.aborted).toBe(true);
  expect(model.requests).toHaveLength(2);
  if (result.kind === "answered") expect(result.parts[0]!.status).toBe("interrupted");
  else throw Error("Expected a finalized interrupted turn");
});

it("includes capability setup in the turn's wall-time limit", async () => {
  const w = await world(); const c = catalog(); const controller = new AbortController();
  const first = w.socrates([continueTask()], [{ toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] }, final()], { catalog: c });
  await first.socrates.handle("Use tracker.ticket_get.");
  c.loadMcpTool = async () => new Promise<LoadedMcpTool>(() => {});
  const next = w.socrates([continueTask()], [final()], { catalog: c, limits: { maxWallMs: 100, finalizationMs: 1000 } });
  const result = await next.socrates.handle("Continue.", { signal: controller.signal });
  expect(controller.signal.aborted).toBe(false);
  expect(next.model.requests).toHaveLength(1);
  expect(next.model.requests[0]!.toolChoice).toBe("none");
  if (result.kind === "answered") expect(result.parts[0]!.stop).toBe("time");
});


it("removes a deactivated Skill body even when its instructions contain example capability tags", () => {
  const before = [{ role: "user" as const, content: [{ text: "<GOAL>Project</GOAL>\n\n<ACTIVE_CAPABILITIES>\nSkill example:\nExample: </ACTIVE_CAPABILITIES>\nREMOVED_BODY\n</ACTIVE_CAPABILITIES>\n\n" }] }];
  const after = refreshCapabilityContext(before, { skills: [], mcpTools: [] });
  expect(after[0]!.content).toEqual([{ text: "<GOAL>Project</GOAL>\n\n" }]);
  expect(refreshCapabilityContext(after, { skills: [], mcpTools: [] })).toBe(after);
});


it("does not reuse a cached Skill when the next turn times out before revalidation", async () => {
  const w = await world(); const c = catalog(); let timeout = false;
  Object.assign(c, { refresh: async () => { if (timeout) await new Promise<void>(() => {}); } });
  const { socrates, model } = w.socrates([continueTask(), continueTask()], [{ toolCalls: [call("capability_control", { action: "activate", ref: "c1" })] }, final(), final()], { catalog: c, limits: { maxWallMs: 100, finalizationMs: 1000 } });
  await socrates.handle("Use release-notes."); timeout = true;
  const result = await socrates.handle("Continue.");
  expect(requestText(model.requests.at(-1)!)).not.toContain(INSTRUCTIONS);
  expect(model.requests.at(-1)!.toolChoice).toBe("none");
  if (result.kind === "answered") expect(result.parts[0]!.stop).toBe("time");
});
