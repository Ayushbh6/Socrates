import { describe, expect, it } from "vitest";
import { THEME_KEY, readChoice, resolveTheme } from "../src/lib/theme";

describe("theme", () => {
  it("follows the system until the user chooses", () => {
    expect(readChoice({ getItem: () => null })).toBe("system");
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("keeps a choice over the system's", () => {
    expect(readChoice({ getItem: (k) => (k === THEME_KEY ? "dark" : null) })).toBe("dark");
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });

  it("ignores anything else stored, or storage that throws", () => {
    expect(readChoice({ getItem: () => "sepia" })).toBe("system");
    expect(readChoice({ getItem: () => { throw new Error("blocked"); } })).toBe("system");
  });
});
