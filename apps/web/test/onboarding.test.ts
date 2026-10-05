import { describe, expect, it } from "vitest";
import { needsOnboarding, routeOf } from "../src/App";

const status = (over: Partial<{ ready: boolean; setup: string[]; onboarded: boolean }> = {}) => ({ ready: true, setup: [] as string[], ...over, profile: { onboarded: over.onboarded ?? true } });

describe("the routes", () => {
  it("knows the chat and onboarding pages, and takes anything else to the welcome page", () => {
    expect(routeOf("#/chat")).toBe("chat");
    expect(routeOf("#/onboarding")).toBe("onboarding");
    for (const hash of ["", "#/", "#/welcome", "#/settings", "#/chat/extra"]) expect(routeOf(hash)).toBe("welcome");
  });
});

describe("who must be onboarded before the chat", () => {
  it("is anyone who never finished it, or whose setup is missing again", () => {
    expect(needsOnboarding(null)).toBe(false);
    expect(needsOnboarding(status())).toBe(false);
    expect(needsOnboarding(status({ onboarded: false }))).toBe(true);
    // Not ready because no key is set (any more).
    expect(needsOnboarding(status({ ready: false, setup: ["Add an API key."] }))).toBe(true);
  });

  it("lets a restart after a settings change keep the canvas", () => {
    expect(needsOnboarding(status({ ready: false, setup: [] }))).toBe(false);
  });
});
