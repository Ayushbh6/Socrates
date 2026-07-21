import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerV2FlowRoutes } from "../routes/v2FlowRoutes"
import type { SocratesStore } from "../services/store"
import type { V2FlowStore } from "../services/v2/flowStore"

const runningApps: ReturnType<typeof Fastify>[] = []

afterEach(async () => {
  await Promise.all(runningApps.splice(0).map((app) => app.close()))
})

describe("V2 Flow deletion routes", () => {
  it("removes only the deleted turn from retrieval instead of rebuilding the project index", async () => {
    const app = Fastify({ logger: false })
    runningApps.push(app)
    const deleteTurn = vi.fn(() => ({ deletedTurnId: "v2turn_1" }))
    const deleteV2TurnRetrieval = vi.fn()
    const rebuildProjectRetrieval = vi.fn()

    await registerV2FlowRoutes(
      app,
      { deleteTurn } as unknown as V2FlowStore,
      { deleteV2TurnRetrieval, rebuildProjectRetrieval } as unknown as SocratesStore,
    )

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v2/projects/proj_1/flows/v2flow_1/turns/v2turn_1",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ ok: true, data: { deletedTurnId: "v2turn_1" } })
    expect(deleteTurn).toHaveBeenCalledWith("proj_1", "v2flow_1", "v2turn_1")
    expect(deleteV2TurnRetrieval).toHaveBeenCalledWith("proj_1", "v2turn_1")
    expect(rebuildProjectRetrieval).not.toHaveBeenCalled()
  })

  it("removes only the deleted goal from retrieval instead of rebuilding the project index", async () => {
    const app = Fastify({ logger: false })
    runningApps.push(app)
    const deleteGoal = vi.fn(() => ({ deletedGoalId: "v2goal_2", fallbackGoalId: "v2goal_1" }))
    const deleteV2GoalRetrieval = vi.fn()
    const rebuildProjectRetrieval = vi.fn()

    await registerV2FlowRoutes(
      app,
      { deleteGoal } as unknown as V2FlowStore,
      { deleteV2GoalRetrieval, rebuildProjectRetrieval } as unknown as SocratesStore,
    )

    const response = await app.inject({
      method: "DELETE",
      url: "/api/v2/projects/proj_1/flows/v2flow_1/goals/v2goal_2",
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      ok: true,
      data: { deletedGoalId: "v2goal_2", fallbackGoalId: "v2goal_1" },
    })
    expect(deleteGoal).toHaveBeenCalledWith("proj_1", "v2flow_1", "v2goal_2")
    expect(deleteV2GoalRetrieval).toHaveBeenCalledWith("proj_1", "v2goal_2")
    expect(rebuildProjectRetrieval).not.toHaveBeenCalled()
  })
})
