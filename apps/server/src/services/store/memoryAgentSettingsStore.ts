import type { MemoryAgentSettings, ProviderId, ThinkingEffort, UpdateProjectMemoryAgentSettingsRequest } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { eq } from "drizzle-orm"
import { projectMemoryAgentSettings, projects } from "../../db/schema"
import { StoreBase } from "./shared"

export const DEFAULT_MEMORY_AGENT_PROVIDER_ID: ProviderId = "openrouter"
export const DEFAULT_MEMORY_AGENT_MODEL_ID = "xiaomi/mimo-v2.5-pro"
export const DEFAULT_MEMORY_AGENT_THINKING_ENABLED = false
export const DEFAULT_MEMORY_AGENT_THINKING_EFFORT: ThinkingEffort | undefined = undefined

export class MemoryAgentSettingsStore extends StoreBase {
  ensureProjectSettings(projectId: string): MemoryAgentSettings {
    const existing = this.getProjectSettingsRow(projectId)
    if (existing) {
      return mapMemoryAgentSettings(existing)
    }
    this.assertProjectExists(projectId)
    const now = nowIso()
    const id = createId("memcfg")
    this.handle.db
      .insert(projectMemoryAgentSettings)
      .values({
        id,
        projectId,
        providerId: DEFAULT_MEMORY_AGENT_PROVIDER_ID,
        modelId: DEFAULT_MEMORY_AGENT_MODEL_ID,
        thinkingEnabled: DEFAULT_MEMORY_AGENT_THINKING_ENABLED,
        thinkingEffort: DEFAULT_MEMORY_AGENT_THINKING_EFFORT ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return mapMemoryAgentSettings(this.mustGetProjectSettingsRow(projectId))
  }

  updateProjectSettings(projectId: string, input: UpdateProjectMemoryAgentSettingsRequest): MemoryAgentSettings {
    this.ensureProjectSettings(projectId)
    const now = nowIso()
    const modelId = input.modelId.trim()
    if (!modelId) {
      throw new SocratesError("memory_agent_model_required", "Memory agent model is required.", { recoverable: true })
    }
    const thinkingEnabled = input.thinkingEnabled
    const thinkingEffort = normalizeThinkingEffort(thinkingEnabled, input.thinkingEffort)
    this.handle.db
      .update(projectMemoryAgentSettings)
      .set({
        providerId: input.providerId,
        modelId,
        thinkingEnabled,
        thinkingEffort: thinkingEffort ?? null,
        updatedAt: now,
      })
      .where(eq(projectMemoryAgentSettings.projectId, projectId))
      .run()
    return mapMemoryAgentSettings(this.mustGetProjectSettingsRow(projectId))
  }

  private getProjectSettingsRow(projectId: string): typeof projectMemoryAgentSettings.$inferSelect | undefined {
    return this.handle.db.select().from(projectMemoryAgentSettings).where(eq(projectMemoryAgentSettings.projectId, projectId)).limit(1).get()
  }

  private mustGetProjectSettingsRow(projectId: string): typeof projectMemoryAgentSettings.$inferSelect {
    const row = this.getProjectSettingsRow(projectId)
    if (!row) {
      throw new SocratesError("memory_agent_settings_not_found", "Memory agent settings were not found after creation.", {
        details: { projectId },
      })
    }
    return row
  }

  private assertProjectExists(projectId: string): void {
    const project = this.handle.db.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).limit(1).get()
    if (!project) {
      throw new SocratesError("project_not_found", "Project was not found", { details: { projectId } })
    }
  }
}

const normalizeThinkingEffort = (thinkingEnabled: boolean, thinkingEffort: ThinkingEffort | undefined): ThinkingEffort | undefined =>
  thinkingEnabled ? thinkingEffort && thinkingEffort !== "none" ? thinkingEffort : undefined : thinkingEffort

const mapMemoryAgentSettings = (row: typeof projectMemoryAgentSettings.$inferSelect): MemoryAgentSettings => ({
  id: row.id,
  projectId: row.projectId,
  providerId: row.providerId as ProviderId,
  modelId: row.modelId,
  thinkingEnabled: row.thinkingEnabled,
  ...(row.thinkingEffort ? { thinkingEffort: row.thinkingEffort as ThinkingEffort } : {}),
  updatedAt: row.updatedAt,
})
