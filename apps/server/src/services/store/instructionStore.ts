import type { ProjectInstructions, UpsertProjectInstructionsRequest } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { and, desc, eq } from "drizzle-orm"
import { projectInstructions } from "../../db/schema"
import { mapProjectInstructions } from "../../db/mappers"
import { StoreBase } from "./shared"

export class InstructionStore extends StoreBase {
  upsertProjectInstructions(projectId: string, input: UpsertProjectInstructionsRequest): ProjectInstructions {
    this.mustGetProjectRow(projectId)
    const now = nowIso()
    const existing = this.getActiveInstructionsRow(projectId)

    const id = existing?.id ?? createId("pins")
    if (existing) {
      this.handle.db
        .update(projectInstructions)
        .set({
          content: input.content,
          updatedAt: now,
        })
        .where(eq(projectInstructions.id, existing.id))
        .run()
    } else {
      this.handle.db
        .insert(projectInstructions)
        .values({
          id,
          projectId,
          content: input.content,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }

    this.appendEvent({
      projectId,
      type: "project.instructions.updated",
      source: "server",
      payload: { projectId, instructionsId: id },
    })

    return mapProjectInstructions(this.mustGetInstructionsRow(id))
  }

  getActiveInstructionsRow(projectId: string): typeof projectInstructions.$inferSelect | undefined {
    return this.handle.db
      .select()
      .from(projectInstructions)
      .where(and(eq(projectInstructions.projectId, projectId), eq(projectInstructions.status, "active")))
      .orderBy(desc(projectInstructions.updatedAt))
      .limit(1)
      .get()
  }

  private mustGetInstructionsRow(id: string): typeof projectInstructions.$inferSelect {
    const row = this.handle.db.select().from(projectInstructions).where(eq(projectInstructions.id, id)).get()
    if (!row) {
      throw new SocratesError("project_instructions_not_found", "Project instructions not found", {
        details: { instructionsId: id },
      })
    }
    return row
  }
}
