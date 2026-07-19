import { describe, expect, it } from "vitest"
import { contextDispositionToolInputSchema } from "./tools"

describe("contextDispositionToolInputSchema", () => {
  it("accepts the compact three-field distillation decision", () => {
    expect(contextDispositionToolInputSchema.parse({
      decisions: [{ result: "result_1", action: "distill", summary: "The opening establishes the report scope." }],
    })).toEqual({
      decisions: [{ result: "result_1", action: "distill", summary: "The opening establishes the report scope." }],
    })
  })

  it("requires a summary only for distill and rejects duplicate handles", () => {
    expect(contextDispositionToolInputSchema.safeParse({
      decisions: [{ result: "result_1", action: "distill" }],
    }).success).toBe(false)
    expect(contextDispositionToolInputSchema.safeParse({
      decisions: [{ result: "result_1", action: "release", summary: "not allowed" }],
    }).success).toBe(false)
    expect(contextDispositionToolInputSchema.safeParse({
      decisions: [
        { result: "result_1", action: "keep_exact" },
        { result: "result_1", action: "release" },
      ],
    }).success).toBe(false)
  })
})
