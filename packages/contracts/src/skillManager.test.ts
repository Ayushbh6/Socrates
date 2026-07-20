import { describe, expect, it } from "vitest"
import { skillManagerToolInputSchema, skillManagerToolOutputSchema } from "./tools"

describe("skill manager contracts", () => {
  it("accepts only the compact create and delete inputs", () => {
    expect(skillManagerToolInputSchema.parse({
      operation: "create",
      name: "release-auditor",
      request: "Check release notes for missing verification evidence.",
    })).toEqual({
      operation: "create",
      name: "release-auditor",
      request: "Check release notes for missing verification evidence.",
    })
    expect(skillManagerToolInputSchema.parse({
      operation: "delete",
      name: "release-auditor",
    })).toEqual({ operation: "delete", name: "release-auditor" })
    expect(skillManagerToolInputSchema.safeParse({
      operation: "delete",
      name: "release-auditor",
      reason: "extra field",
    }).success).toBe(false)
  })

  it("keeps the lifecycle result compact and project-scoped", () => {
    expect(skillManagerToolOutputSchema.parse({
      operation: "create",
      name: "release-auditor",
      scope: "project",
      status: "created",
    })).toEqual({
      operation: "create",
      name: "release-auditor",
      scope: "project",
      status: "created",
    })
  })
})
