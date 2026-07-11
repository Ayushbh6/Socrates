import { describe, expect, it } from "vitest"
import { SOCRATES_SURFACES, buildSocratesSystemPrompt, renderSocratesSurfaceMap } from "../index"

describe("Socrates surface registry", () => {
  it("renders every registered surface exactly once into the compact map", () => {
    const map = renderSocratesSurfaceMap()
    expect(SOCRATES_SURFACES).toHaveLength(9)
    for (const surface of SOCRATES_SURFACES) {
      expect(map.split(surface.path)).toHaveLength(2)
    }
    expect(map).toContain("write=backend")
    expect(map).toContain("load=on_demand")
  })

  it("keeps dynamic project context out of the byte-stable system prompt", () => {
    const first = buildSocratesSystemPrompt({ userDisplayName: "One", projectName: "Alpha" })
    const second = buildSocratesSystemPrompt({ userDisplayName: "Two", projectName: "Beta" })
    expect(first).toBe(second)
    expect(first).not.toContain("Alpha")
    expect(first).not.toContain("Beta")
  })
})
