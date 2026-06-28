import type {
  ProviderId,
  ThinkingEffort,
  UpdateWorkerModelSettingsRequest,
  WorkerModelRole,
  WorkerModelSettings,
} from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { eq } from "drizzle-orm"
import { workerModelSettings } from "../../db/schema"
import { StoreBase } from "./shared"

export const DEFAULT_WORKER_MODEL_SETTINGS: Record<WorkerModelRole, Omit<WorkerModelSettings, "updatedAt">> = {
  skill_writer: {
    workerId: "skill_writer",
    providerId: "openrouter",
    modelId: "xiaomi/mimo-v2.5-pro",
    thinkingEnabled: false,
  },
  context_compactor: {
    workerId: "context_compactor",
    providerId: "openrouter",
    modelId: "deepseek/deepseek-v4-flash",
    thinkingEnabled: false,
  },
  title_generator: {
    workerId: "title_generator",
    providerId: "openrouter",
    modelId: "meta-llama/llama-4-maverick",
    thinkingEnabled: false,
  },
}

const workerOrder: WorkerModelRole[] = ["skill_writer", "context_compactor", "title_generator"]

export class WorkerModelSettingsStore extends StoreBase {
  ensureAll(): WorkerModelSettings[] {
    return workerOrder.map((workerId) => this.ensureSetting(workerId))
  }

  ensureSetting(workerId: WorkerModelRole): WorkerModelSettings {
    const existing = this.getSettingRow(workerId)
    if (existing) {
      return mapSetting(existing)
    }
    const defaults = DEFAULT_WORKER_MODEL_SETTINGS[workerId]
    const now = nowIso()
    this.handle.db
      .insert(workerModelSettings)
      .values({
        id: createId("wms"),
        workerId,
        providerId: defaults.providerId,
        modelId: defaults.modelId,
        thinkingEnabled: defaults.thinkingEnabled,
        thinkingEffort: defaults.thinkingEffort ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return mapSetting(this.mustGetSettingRow(workerId))
  }

  updateSetting(workerId: WorkerModelRole, input: UpdateWorkerModelSettingsRequest): WorkerModelSettings {
    this.ensureSetting(workerId)
    const row = this.mustGetSettingRow(workerId)
    const modelId = input.modelId.trim()
    if (!modelId) {
      throw new SocratesError("worker_model_required", "Worker model is required.", { recoverable: true })
    }
    const thinkingEffort = normalizeThinkingEffort(input.thinkingEnabled, input.thinkingEffort)
    this.handle.db
      .update(workerModelSettings)
      .set({
        providerId: input.providerId,
        modelId,
        thinkingEnabled: input.thinkingEnabled,
        thinkingEffort: thinkingEffort ?? null,
        updatedAt: nowIso(),
      })
      .where(eq(workerModelSettings.id, row.id))
      .run()
    return mapSetting(this.mustGetSettingRow(workerId))
  }

  private getSettingRow(workerId: WorkerModelRole): typeof workerModelSettings.$inferSelect | undefined {
    return this.handle.db.select().from(workerModelSettings).where(eq(workerModelSettings.workerId, workerId)).limit(1).get()
  }

  private mustGetSettingRow(workerId: WorkerModelRole): typeof workerModelSettings.$inferSelect {
    const row = this.getSettingRow(workerId)
    if (!row) {
      throw new SocratesError("worker_model_settings_not_found", "Worker model settings were not found after creation.", {
        details: { workerId },
      })
    }
    return row
  }
}

const normalizeThinkingEffort = (thinkingEnabled: boolean, thinkingEffort: ThinkingEffort | undefined): ThinkingEffort | undefined =>
  thinkingEnabled ? thinkingEffort && thinkingEffort !== "none" ? thinkingEffort : undefined : thinkingEffort

const mapSetting = (row: typeof workerModelSettings.$inferSelect): WorkerModelSettings => ({
  workerId: row.workerId as WorkerModelRole,
  providerId: row.providerId as ProviderId,
  modelId: row.modelId,
  thinkingEnabled: row.thinkingEnabled,
  ...(row.thinkingEffort ? { thinkingEffort: row.thinkingEffort as ThinkingEffort } : {}),
  updatedAt: row.updatedAt,
})
