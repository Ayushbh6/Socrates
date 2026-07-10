import { describe, expect, it } from "vitest"
import { memoryAgentJournalOutputSchema, readMemoryJournalToolInputSchema } from "./memoryJournal"

const validOutput = {
  summary: "Observed a repeatable context-first workflow.",
  patternsObserved: [{ name: "Context first", finding: "The user investigates before authorizing edits.", evidenceTurnIds: ["turn-1", "turn-2"] }],
  skillsAffected: [{ skillId: "global:context-first", action: "proposed_create" as const, note: "Proposed the repeated workflow." }],
  decisions: ["Kept project-specific details out of global profile memory."],
  openInvestigations: [{ title: "Verification gate", currentUnderstanding: "The final gate may vary by project.", evidenceTurnIds: ["turn-2"], nextStep: "Inspect the next completed workflow." }],
  nextRunFocus: ["Check whether the verification gate repeats."],
}

describe("memory journal contracts", () => {
  it("accepts the agreed strict structured handoff", () => {
    expect(memoryAgentJournalOutputSchema.safeParse(validOutput).success).toBe(true)
  })

  it("rejects oversized evidence, unknown skill actions, and extra keys", () => {
    expect(memoryAgentJournalOutputSchema.safeParse({ ...validOutput, patternsObserved: [{ ...validOutput.patternsObserved[0], evidenceTurnIds: ["1", "2", "3", "4", "5", "6"] }] }).success).toBe(false)
    expect(memoryAgentJournalOutputSchema.safeParse({ ...validOutput, skillsAffected: [{ action: "created", note: "bad" }] }).success).toBe(false)
    expect(memoryAgentJournalOutputSchema.safeParse({ ...validOutput, extra: true }).success).toBe(false)
  })

  it("enforces bounded list/read-only journal access", () => {
    expect(readMemoryJournalToolInputSchema.safeParse({ operation: "list", limit: 10, charLimit: 20_000 }).success).toBe(true)
    expect(readMemoryJournalToolInputSchema.safeParse({ operation: "list", limit: 11 }).success).toBe(false)
    expect(readMemoryJournalToolInputSchema.safeParse({ operation: "read", runId: "memjob_1", charLimit: 20_001 }).success).toBe(false)
    expect(readMemoryJournalToolInputSchema.safeParse({ operation: "delete", runId: "memjob_1" }).success).toBe(false)
  })
})
