import { describe, expect, it } from "vitest";
import { filterModels } from "../src/lib/models";

describe("the model picker's search", () => {
  const models = [{ id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" }, { id: "google/gemini-3.8-flash" }, { id: "anthropic/claude-opus-5.5", name: "Claude Opus 5.5" }];

  it("matches every word in the id or the name, and says how many more there are", () => {
    expect(filterModels(models, "flash", 10).shown.map((m) => m.id)).toEqual(["z-ai/glm-5.3-flash", "google/gemini-3.8-flash"]);
    expect(filterModels(models, "claude opus", 10).shown.map((m) => m.id)).toEqual(["anthropic/claude-opus-5.5"]);
    expect(filterModels(models, "GLM flash", 10).shown).toHaveLength(1);
    expect(filterModels(models, "", 2)).toEqual({ shown: models.slice(0, 2), more: 1 });
    expect(filterModels(models, "nothing", 5)).toEqual({ shown: [], more: 0 });
  });
});
