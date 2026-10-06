import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const web = new URL("..", import.meta.url);

describe("the tab icon", () => {
  it("is the Socrates logo, linked from the page and shipped with the build", () => {
    const html = readFileSync(new URL("index.html", web), "utf8");
    for (const icon of ["favicon.png", "socrates-512.png", "apple-touch-icon.png"]) {
      expect(html).toContain(`href="/${icon}"`);
      expect(existsSync(new URL(`public/${icon}`, web))).toBe(true);
    }
  });
});
