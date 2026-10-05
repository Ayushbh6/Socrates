import { mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGoal } from "../../../packages/router/test/helpers";
import { call, final } from "../../../packages/agent/test/helpers";
import { Responder, SCRIPTED, home, server, tempDir } from "./helpers";

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((done) => (open = done));
  return { open, opened };
}

describe("access settings", () => {
  it("default to the user's folders and asking first, merge partial changes, and validate folders", async () => {
    const { rt, request } = await server(home({ settings: SCRIPTED }));
    expect((await request("GET", "/api/settings")).json().access).toEqual({ scope: "folders", folders: [], approvals: "ask" });
    const project = tempDir();
    const alias = path.join(tempDir(), "alias");
    symlinkSync(project, alias);
    const set = await request("PUT", "/api/settings", { access: { folders: [project, alias] } });
    expect(set.statusCode).toBe(200);
    expect(set.json().access).toEqual({ scope: "folders", folders: [project], approvals: "ask" });
    expect((await request("PUT", "/api/settings", { access: { approvals: "auto" } })).json().access).toEqual({ scope: "folders", folders: [project], approvals: "auto" });
    expect(JSON.parse(readFileSync(rt.config.settingsPath, "utf8")).access).toEqual({ scope: "folders", folders: [project], approvals: "auto" });
    for (const folder of [homedir(), rt.config.home, "relative/folder", path.join(project, "missing")]) {
      const refused = await request("PUT", "/api/settings", { access: { folders: [folder] } });
      expect(refused.statusCode).toBe(400);
    }
    expect((await request("PUT", "/api/settings", { access: { scope: "everywhere" } })).statusCode).toBe(400);
    expect(rt.settings.access).toEqual({ scope: "folders", folders: [project], approvals: "auto" });
    expect(rt.accessPolicy()).toEqual({ folders: [project], approvals: "auto", protected: [rt.config.home, path.join(homedir(), ".socrates")] });
    expect((await request("PUT", "/api/settings", { access: { scope: "full" } })).json().access.scope).toBe("full");
    expect(rt.accessPolicy().folders).toBeNull();
  });

  it("adds the chosen working folder to the folders", async () => {
    const { rt, request } = await server(home({ settings: SCRIPTED }));
    const project = tempDir();
    const workspace = (await request("POST", "/api/workspaces", { path: project })).json();
    await request("PUT", "/api/settings", { workingFolder: workspace.id });
    await request("PUT", "/api/settings", { workingFolder: workspace.id });
    expect(rt.settings.access.folders).toEqual([project]);
  });

  it("validates the folder limit after adding the chosen working folder", async () => {
    const { rt, request } = await server(home({ settings: SCRIPTED }));
    const parent = tempDir();
    const folders = Array.from({ length: 50 }, (_, i) => path.join(parent, `folder-${i}`));
    for (const folder of folders) mkdirSync(folder);
    const project = tempDir();
    const workspace = (await request("POST", "/api/workspaces", { path: project })).json();
    expect((await request("PUT", "/api/settings", { access: { folders } })).statusCode).toBe(200);
    expect((await request("PUT", "/api/settings", { workingFolder: workspace.id })).statusCode).toBe(400);
    expect(rt.settings.workingFolder).toBeNull();
    expect(JSON.parse(readFileSync(rt.config.settingsPath, "utf8")).access.folders).toEqual(folders);
  });

  it("does not reuse stored folder permission after its path becomes a different alias", async () => {
    const { rt, request } = await server(home({ settings: SCRIPTED }));
    const parent = tempDir();
    const project = path.join(parent, "project");
    mkdirSync(project);
    await request("PUT", "/api/settings", { access: { folders: [project] } });
    renameSync(project, path.join(parent, "original"));
    symlinkSync(tempDir(), project);
    expect(rt.accessPolicy().folders).toEqual([]);
  });

  it("changes access at once, even while Socrates works, without rebuilding it", async () => {
    const hold = gate();
    let calls = 0;
    const agent = new Responder("a", async () => (calls++ === 0 ? (await hold.opened, final()) : final()));
    const { rt, request } = await server(home({ settings: SCRIPTED }), { makeModel: (_p, model) => (model === "router" ? new Responder("r", () => createGoal("Work", "Do it")) : agent) });
    const socrates = rt.socrates;
    const running = socrates!.handle("Do the work.");
    while (!rt.busy()) await new Promise((r) => setTimeout(r, 5));
    expect((await request("PUT", "/api/settings", { access: { approvals: "auto" } })).statusCode).toBe(200);
    expect((await request("PUT", "/api/settings", { timeZone: "Europe/Berlin" })).statusCode).toBe(409);
    expect(rt.socrates).toBe(socrates);
    hold.open();
    await running;
  });

  it("refuses Socrates' own data in full access, and asks outside the folders, refusing without a page", async () => {
    const outside = tempDir();
    writeFileSync(path.join(outside, "notes.md"), "outside notes\n");
    const project = tempDir();
    let step = 0;
    const config = home({ settings: SCRIPTED, keys: { GEMINI_API_KEY: "private-key-value" } });
    const agent = new Responder("a", () => {
      step++;
      if (step === 1) return { toolCalls: [call("read", { path: path.join(config.home, ".env") }), call("read", { path: path.join(outside, "notes.md") })] };
      if (step === 2) return final({ full_answer: "Read what I could." });
      if (step === 3) return { toolCalls: [call("read", { path: path.join(outside, "notes.md") })] };
      return final({ full_answer: "Refused." });
    });
    const { rt, request } = await server(config, { makeModel: (_p, model) => (model === "router" ? new Responder("r", () => createGoal("Notes", "Read notes")) : agent) });
    const workspace = (await request("POST", "/api/workspaces", { path: project })).json();
    await request("PUT", "/api/settings", { workingFolder: workspace.id, access: { scope: "full", approvals: "auto" } });
    expect(rt.settings.access.folders).toEqual([project]);
    const first = await rt.socrates!.handle("Read the notes.");
    if (first.kind !== "answered") throw new Error("expected an answer");
    const [secret, notes] = rt.store.evidenceForTurn(first.parts[0]!.turn.id);
    expect(secret!.result?.error?.code).toBe("protected_path");
    expect(JSON.stringify(secret)).not.toContain("private-key-value");
    expect(notes!.status).toBe("ok");
    expect(rt.store.listEvents({ type: "approval_decided" })).toEqual([]);

    await request("PUT", "/api/settings", { access: { scope: "folders" } });
    const second = await rt.socrates!.handle("Read the notes again.");
    if (second.kind !== "answered") throw new Error("expected an answer");
    expect(rt.store.evidenceForTurn(second.parts[0]!.turn.id)[0]!.result?.error?.code).toBe("approval_denied");
    expect(rt.store.listEvents({ type: "approval_decided" }).map((e) => e.payload)).toEqual([
      { kind: "outside_folder", granted: false, detail: `Read ${outside}/notes.md, outside your folders` },
    ]);
  });

  it("lets a folder added in the middle of a chat count from the very next message, and a removed one stop", async () => {
    const outside = tempDir();
    writeFileSync(path.join(outside, "notes.md"), "outside notes\n");
    const project = tempDir();
    const agent = new Responder("a", (_m, request) => {
      // Each message reads the same file once, then answers.
      const answered = request.messages.some((m) => m.role === "tool");
      return answered ? final({ full_answer: "Done." }) : { toolCalls: [call("read", { path: path.join(outside, "notes.md") })] };
    });
    const { rt, request } = await server(home({ settings: SCRIPTED }), { makeModel: (_p, model) => (model === "router" ? new Responder("r", () => createGoal("Notes", "Read notes")) : agent) });
    const workspace = (await request("POST", "/api/workspaces", { path: project })).json();
    await request("PUT", "/api/settings", { workingFolder: workspace.id });
    const codeOf = async (message: string) => {
      const result = await rt.socrates!.handle(message);
      if (result.kind !== "answered") throw new Error("expected an answer");
      return rt.store.evidenceForTurn(result.parts[0]!.turn.id)[0]!.result?.error?.code ?? "ok";
    };
    // Outside the folders, with nobody to ask: refused.
    expect(await codeOf("Read the notes.")).toBe("approval_denied");
    // The folder is added between two messages; the next one reads it, asking nothing.
    const asked = rt.store.listEvents({ type: "approval_decided" }).length;
    expect((await request("PUT", "/api/settings", { access: { folders: [project, outside] } })).statusCode).toBe(200);
    expect(await codeOf("Read the notes again.")).toBe("ok");
    expect(rt.store.listEvents({ type: "approval_decided" })).toHaveLength(asked);
    // And taking it away counts from the next message too.
    await request("PUT", "/api/settings", { access: { folders: [project] } });
    expect(await codeOf("Read the notes a third time.")).toBe("approval_denied");
  });
});
