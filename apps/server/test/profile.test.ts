import { describe, expect, it } from "vitest";
import { createGoal } from "../../../packages/router/test/helpers";
import { final } from "../../../packages/agent/test/helpers";
import { Responder, SCRIPTED, home, server } from "./helpers";

describe("the profile", () => {
  it("starts empty and not onboarded, keeps the name and the flag across a restart, and is in the status", async () => {
    const config = home({ settings: SCRIPTED });
    const { rt, request } = await server(config);
    expect(rt.settings.profile).toEqual({ name: null, onboarded: false });
    expect((await request("GET", "/api/status")).json().profile).toEqual({ name: null, onboarded: false });
    const saved = await request("PUT", "/api/settings", { profile: { name: "  Ada  ", onboarded: true } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().profile).toEqual({ name: "Ada", onboarded: true });
    expect((await request("GET", "/api/status")).json().profile).toEqual({ name: "Ada", onboarded: true });
    await rt.close();
    const again = await server(config);
    expect(again.rt.settings.profile).toEqual({ name: "Ada", onboarded: true });
  });

  it("merges a partial change, clears the name with null, and refuses what is not a profile", async () => {
    const { request } = await server(home({ settings: { ...SCRIPTED, profile: { name: "Ada", onboarded: true } } }));
    expect((await request("PUT", "/api/settings", { profile: { name: "Grace" } })).json().profile).toEqual({ name: "Grace", onboarded: true });
    expect((await request("PUT", "/api/settings", { profile: { name: null } })).json().profile).toEqual({ name: null, onboarded: true });
    expect((await request("PUT", "/api/settings", { profile: { nickname: "x" } })).statusCode).toBe(400);
    expect((await request("PUT", "/api/settings", { profile: { name: "x".repeat(81) } })).statusCode).toBe(400);
  });

  it("changes without rebuilding Socrates, even while it works", async () => {
    let release!: () => void;
    const held = new Promise<void>((done) => (release = done));
    let calls = 0;
    const agent = new Responder("a", async () => (calls++ === 0 ? (await held, final()) : final()));
    const { rt, request } = await server(home({ settings: SCRIPTED }), { makeModel: (_p, model) => (model === "router" ? new Responder("r", () => createGoal("Work", "Do it")) : agent) });
    const socrates = rt.socrates;
    const running = socrates!.handle("Do the work.");
    while (!rt.busy()) await new Promise((r) => setTimeout(r, 5));
    expect((await request("PUT", "/api/settings", { profile: { name: "Ada", onboarded: true } })).statusCode).toBe(200);
    expect(rt.socrates).toBe(socrates);
    release();
    await running;
  });
});
