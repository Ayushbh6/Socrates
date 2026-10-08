import { describe, expect, it } from "vitest";
import { closedText, statusLabel } from "../src/components/StatusMenu";

describe("a closed task's note", () => {
  it("says who closed it, with Socrates' reason", () => {
    const at = "2026-10-08T10:00:00Z";
    expect(closedText("completed", { by: "user", reason: null, at })).toBe("You marked it completed.");
    expect(closedText("superseded", { by: "user", reason: null, at })).toBe("You marked it superseded.");
    expect(closedText("completed", { by: "socrates", reason: "The tests pass.", at })).toBe("Socrates closed it: The tests pass.");
    expect(closedText("open", { by: "user", reason: null, at })).toBeNull();
    expect(closedText("completed", null)).toBeNull();
  });

  it("names each status", () => {
    expect(["open", "completed", "superseded", "other"].map(statusLabel)).toEqual(["Open", "Completed", "Superseded", "Open"]);
  });
});
