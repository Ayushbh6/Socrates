import { describe, expect, it } from "vitest"
import { analyzeTerminalInputEvidence } from "./conversationTerminals"

describe("Terminal input evidence", () => {
  it("does not treat ordinary questions, colons, or prompt-like words in logs as input requests", () => {
    expect(analyzeTerminalInputEvidence("Checking configuration: complete\nWhy did cache miss? continuing\nSelect strategy: automatic\n").kind).toBe("none")
    expect(analyzeTerminalInputEvidence("Password rotation report: healthy\n").kind).toBe("none")
  })

  it("recognizes anchored terminal protocols across a rolling rendered frame", () => {
    expect(analyzeTerminalInputEvidence("Deploy changes? [y/N]").kind).toBe("protocol")
    expect(analyzeTerminalInputEvidence("\u001b[2K? Pick one\n\u001b[36m❯ Alpha\u001b[0m\n  Beta").kind).toBe("protocol")
    expect(analyzeTerminalInputEvidence("\u001b[?25lPassword: ").kind).toBe("protocol")
  })
})
