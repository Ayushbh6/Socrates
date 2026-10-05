import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type CatalogEntry, type LoadedMcpTool, RunState, StaticCatalog, capabilityCandidates, skillShelf } from "../src";
import { harness } from "./helpers";

const skill = (name: string, description: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ kind: "skill", name, description, tags: [], aliases: [], provider: "user", availability: "available", ...extra } as CatalogEntry);
const mcp = (server: string, tool: string, description: string, extra: Partial<CatalogEntry> = {}): CatalogEntry => ({ kind: "mcp", name: `${server}.${tool}`, server, tool, description, tags: [], aliases: [], availability: "available", ...extra } as CatalogEntry);
const SCHEMA: LoadedMcpTool = { schemaVersion: "1", description: "Create a note", connection: "connected", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } };

describe("Skill shelf", () => {
  it("orders pins, then defaults, then usage, then name, freezes the result per goal, and drops uninstalled Skills", () => {
    const entries = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"].map((n) => skill(n, `The ${n} Skill.`));
    const catalog = new StaticCatalog(entries);
    const h = harness({ catalog });
    const other = h.store.createGoal({ title: "Other", objective: "x" }).id;
    for (let i = 0; i < 2; i++) h.store.activateCapability(other, { kind: "skill", name: "golf", version: "1", digest: `d${i}` });
    h.store.activateCapability(other, { kind: "skill", name: "foxtrot", version: "1", digest: "d" });

    const shelf = skillShelf(h.store, catalog, h.binding.goalId, { pins: ["echo"], defaults: ["delta", "missing"] });
    expect(shelf).toBe("<AVAILABLE_SKILLS>\n- echo: The echo Skill.\n- delta: The delta Skill.\n- golf: The golf Skill.\n- foxtrot: The foxtrot Skill.\n- alpha: The alpha Skill.\n</AVAILABLE_SKILLS>");

    // Frozen: new usage and new installs do not reorder an existing goal's shelf.
    for (let i = 0; i < 5; i++) h.store.activateCapability(other, { kind: "skill", name: "bravo", version: "1", digest: `b${i}` });
    entries.push(skill("aardvark", "First by name."));
    expect(skillShelf(h.store, catalog, h.binding.goalId)).toBe(shelf);
    expect(h.store.listEvents({ goalId: h.binding.goalId, type: "skill_shelf_frozen" })).toHaveLength(1);

    // A Skill that is no longer available leaves the rendering without a refreeze.
    entries.splice(entries.findIndex((e) => e.name === "golf"), 1);
    expect(skillShelf(h.store, catalog, h.binding.goalId)).not.toContain("golf");
    // A new goal sees current usage.
    expect(skillShelf(h.store, catalog, h.store.createGoal({ title: "New", objective: "y" }).id)).toContain("- bravo: The bravo Skill.");
  });

  it("does not freeze an empty shelf, so Skills installed later reach the goal", () => {
    const entries: CatalogEntry[] = [];
    const catalog = new StaticCatalog(entries);
    const h = harness({ catalog });
    expect(skillShelf(h.store, catalog, h.binding.goalId)).toBeNull();
    entries.push(skill("pdf", "Read and create PDF files.".padEnd(260, ".")));
    const shelf = skillShelf(h.store, catalog, h.binding.goalId)!;
    expect(shelf.split("\n")[1]!.length).toBeLessThanOrEqual("- pdf: ".length + 200);
    expect(shelf).toContain("…");
  });
});

describe("capability candidates", () => {
  const catalog = () =>
    new StaticCatalog([
      skill("pdf", "Read, render, inspect, and create PDF files.", { tags: ["documents"] }),
      skill("release-notes", "Write release notes from merged changes.", { tags: ["changelog"] }),
      mcp("tracker", "ticket_get", "Read one ticket from the issue tracker by its id.", { readOnly: true }),
      mcp("tracker", "ticket_comment", "Add a comment to a ticket in the issue tracker."),
      mcp("github", "list_repos", "List repositories."),
    ], {}, { "tracker.ticket_get": SCHEMA });

  it("suggests at most one Skill and one MCP tool, each with an activatable ref", async () => {
    const c = catalog();
    const h = harness({ catalog: c });
    const text = capabilityCandidates({ store: h.store, catalog: c, goalId: h.binding.goalId, message: "Read ticket 42 from the tracker and turn the attached report.pdf into notes", run: h.run });
    expect(text).toBe(
      "<CAPABILITY_CANDIDATES>\n- skill c1: pdf — Read, render, inspect, and create PDF files. (named in the message)\n- mcp c2: tracker.ticket_get — Read one ticket from the issue tracker by its id. (matched: read, ticket, tracker)\n</CAPABILITY_CANDIDATES>",
    );
    const activated = await h.call("capability_control", { action: "activate", ref: "c2" });
    expect(activated.json).toMatchObject({ status: "activated", name: "tracker.ticket_get" });
  });

  it("applies a threshold per kind, so a bare server name or incidental words suggest nothing", () => {
    const c = catalog();
    const h = harness({ catalog: c });
    expect(capabilityCandidates({ store: h.store, catalog: c, goalId: h.binding.goalId, message: "What is on github today?", run: h.run })).toBeNull();
    expect(capabilityCandidates({ store: h.store, catalog: c, goalId: h.binding.goalId, message: "Please read the code and tell me what changed.", run: h.run })).toBeNull();
    // A strong Skill match never hides an MCP match, and the reverse.
    const both = capabilityCandidates({ store: h.store, catalog: c, goalId: h.binding.goalId, message: "Write the release notes changelog, then comment on the tracker ticket", run: h.run })!;
    expect(both).toContain("skill c1: release-notes");
    expect(both).toContain("mcp c2: tracker.ticket_comment");
  });

  it("names exactly, skips active and unavailable capabilities, and matches one sentence of a long message", () => {
    const entries = [mcp("tracker", "ticket_get", "Read one ticket."), skill("pdf", "PDF files.", { availability: "offline" } as never)];
    const c = new StaticCatalog(entries);
    const h = harness({ catalog: c });
    const exact = capabilityCandidates({ store: h.store, catalog: c, goalId: h.binding.goalId, message: "Use mcp__tracker__ticket_get please.", run: new RunState() });
    expect(exact).toBe("<CAPABILITY_CANDIDATES>\n- mcp c1: tracker.ticket_get — Read one ticket. (named in the message)\n</CAPABILITY_CANDIDATES>");
    expect(capabilityCandidates({ store: h.store, catalog: c, goalId: h.binding.goalId, message: "Make a pdf.", run: new RunState() })).toBeNull();
    h.store.activateCapability(h.binding.goalId, { kind: "mcp", name: "tracker.ticket_get", version: "1", digest: "d" });
    expect(capabilityCandidates({ store: h.store, catalog: c, goalId: h.binding.goalId, message: "Use ticket_get.", run: new RunState() })).toBeNull();

    const notes = new StaticCatalog([skill("release-notes", "Write release notes from merged changes.")]);
    const filler = "The service handles many requests every day and the team keeps improving its behaviour. ".repeat(40);
    const long = `${filler}At the end, write the release notes for the merged changes. ${filler}`;
    expect(capabilityCandidates({ store: h.store, catalog: notes, goalId: h.binding.goalId, message: long, run: new RunState() })).toContain("skill c1: release-notes");
  });
});

describe("MCP approval", () => {
  it("asks once per tool per goal for a tool that is not read-only, and never for a read-only one", async () => {
    const entries = [mcp("notes", "add", "Add a note"), mcp("notes", "list", "List notes", { readOnly: true })];
    const calls: string[] = [];
    const tools = { "notes.add": SCHEMA, "notes.list": { ...SCHEMA, readOnly: true, inputSchema: { type: "object", properties: {} } } };
    const catalog = new StaticCatalog(entries, {}, tools, { "notes.add": () => (calls.push("add"), { content: "saved", isError: false }), "notes.list": () => (calls.push("list"), { content: "none", isError: false }) });
    const h = harness({ catalog });
    for (const query of ["notes.add", "notes.list"]) {
      const ref = (await h.call("capability_search", { query })).json.matches[0].ref;
      await h.call("capability_control", { action: "activate", ref });
    }
    expect((await h.call("mcp__notes__list", {})).isError).toBe(false);
    expect(h.approvals).toEqual([]);
    expect((await h.call("mcp__notes__add", { text: "one" })).isError).toBe(false);
    expect((await h.call("mcp__notes__add", { text: "two" })).isError).toBe(false);
    expect(h.approvals).toMatchObject([{ kind: "mcp_tool", tool: "mcp__notes__add", subject: "notes.add" }]);
    expect(h.approvals[0]!.detail).toContain('First call: {"text":"one"}');
    expect(calls).toEqual(["list", "add", "add"]);
    expect(h.store.mcpToolApproved(h.binding.goalId, "notes.add")).toBe(true);
    expect(h.store.mcpToolApproved(h.store.createGoal({ title: "Other", objective: "x" }).id, "notes.add")).toBe(false);
  });

  it("does not call the tool when the user declines, and asks again next time", async () => {
    let called = 0;
    const catalog = new StaticCatalog([mcp("notes", "add", "Add a note")], {}, { "notes.add": SCHEMA }, { "notes.add": () => (called++, { content: "saved", isError: false }) });
    const h = harness({ catalog, approve: (r) => r.kind !== "mcp_tool" });
    const ref = (await h.call("capability_search", { query: "notes.add" })).json.matches[0].ref;
    await h.call("capability_control", { action: "activate", ref });
    expect((await h.call("mcp__notes__add", { text: "x" })).json.error).toMatchObject({ code: "approval_denied", retryable: false });
    await h.call("mcp__notes__add", { text: "x" });
    expect(h.approvals.filter((a) => a.kind === "mcp_tool")).toHaveLength(2);
    expect(called).toBe(0);
  });
});

describe("an MCP tool that returns an image", () => {
  const png = readFileSync(path.join(import.meta.dirname, "fixture-label.png"));
  const shot = { content: "[image image/png, about 11000 bytes]", isError: false, images: [{ mediaType: "image/png" as const, data: png.toString("base64") }] };
  async function shotHarness() {
    const catalog = new StaticCatalog([mcp("browser", "screenshot", "Take a screenshot", { readOnly: true })], {}, { "browser.screenshot": { ...SCHEMA, readOnly: true, inputSchema: { type: "object", properties: {} } } }, { "browser.screenshot": () => shot });
    const h = harness({ catalog });
    const ref = (await h.call("capability_search", { query: "browser.screenshot" })).json.matches[0].ref;
    await h.call("capability_control", { action: "activate", ref });
    return h;
  }

  it("shows the screenshot to a model that can see, and keeps its bytes out of the record", async () => {
    const h = await shotHarness();
    const r = await h.call("mcp__browser__screenshot", {}, { vision: true });
    expect(r.isError).toBe(false);
    expect(r.images).toEqual(shot.images);
    expect(r.content).toBe("[image image/png, about 11000 bytes]");
    const stored = JSON.stringify(h.store.listEvents({ type: "tool_completed" }).at(-1)!.payload);
    expect(stored).not.toContain(png.toString("base64").slice(0, 40));
    expect(stored).toContain('"images":1');
  });

  it("tells a model that cannot see that the image's content is unknown, and sends it nothing", async () => {
    const h = await shotHarness();
    const r = await h.call("mcp__browser__screenshot", {});
    expect(r.images).toBeUndefined();
    expect(r.content).toContain("The current model cannot see images, so this image's content is unknown");
  });
});
