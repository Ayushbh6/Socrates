import type {
  MemoryAgentGlobalSettings,
  MemoryAgentGlobalState,
  ProviderId,
  ThinkingEffort,
  UpdateMemoryAgentGlobalSettingsRequest,
} from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { eq } from "drizzle-orm"
import { memoryAgentGlobalSettings, memoryAgentGlobalState } from "../../db/schema"
import {
  DEFAULT_MEMORY_AGENT_MODEL_ID,
  DEFAULT_MEMORY_AGENT_PROVIDER_ID,
  DEFAULT_MEMORY_AGENT_THINKING_EFFORT,
  DEFAULT_MEMORY_AGENT_THINKING_ENABLED,
} from "./memoryAgentDefaults"
import { StoreBase } from "./shared"

const GLOBAL_ROW_ID = "global"
export const DEFAULT_MEMORY_AGENT_ENABLED = true
export const DEFAULT_MEMORY_AGENT_CADENCE_MINUTES = 10
export type MemoryAgentGlobalStatePatch = Partial<Omit<MemoryAgentGlobalState, "id" | "updatedAt" | "lastCheckedAt" | "lastRealRunAt" | "activeJobId" | "lastJobId" | "error">> & {
  lastCheckedAt?: string | null
  lastRealRunAt?: string | null
  activeJobId?: string | null
  lastJobId?: string | null
  error?: string | null
}

export class MemoryAgentGlobalSettingsStore extends StoreBase {
  ensureSettings(): MemoryAgentGlobalSettings {
    const existing = this.getSettingsRow()
    if (existing) {
      return mapSettings(existing)
    }
    const now = nowIso()
    this.handle.db
      .insert(memoryAgentGlobalSettings)
      .values({
        id: createId("memcfg"),
        providerId: DEFAULT_MEMORY_AGENT_PROVIDER_ID,
        modelId: DEFAULT_MEMORY_AGENT_MODEL_ID,
        thinkingEnabled: DEFAULT_MEMORY_AGENT_THINKING_ENABLED,
        thinkingEffort: DEFAULT_MEMORY_AGENT_THINKING_EFFORT ?? null,
        enabled: DEFAULT_MEMORY_AGENT_ENABLED,
        cadenceMinutes: DEFAULT_MEMORY_AGENT_CADENCE_MINUTES,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return mapSettings(this.mustGetSettingsRow())
  }

  updateSettings(input: UpdateMemoryAgentGlobalSettingsRequest): MemoryAgentGlobalSettings {
    const current = this.ensureSettings()
    const modelId = input.modelId?.trim() ?? current.modelId
    if (!modelId) {
      throw new SocratesError("memory_agent_model_required", "Memory agent model is required.", { recoverable: true })
    }
    const thinkingEnabled = input.thinkingEnabled ?? current.thinkingEnabled
    const requestedThinkingEffort = input.thinkingEffort !== undefined ? input.thinkingEffort : input.thinkingEnabled !== undefined ? undefined : current.thinkingEffort
    const thinkingEffort = normalizeThinkingEffort(thinkingEnabled, requestedThinkingEffort)
    const cadenceMinutes = input.cadenceMinutes ?? current.cadenceMinutes
    if (cadenceMinutes <= 0) {
      throw new SocratesError("memory_agent_cadence_invalid", "Memory agent cadence must be positive.", { recoverable: true })
    }
    this.handle.db
      .update(memoryAgentGlobalSettings)
      .set({
        providerId: input.providerId ?? current.providerId,
        modelId,
        thinkingEnabled,
        thinkingEffort: thinkingEffort ?? null,
        enabled: input.enabled ?? current.enabled,
        cadenceMinutes,
        updatedAt: nowIso(),
      })
      .where(eq(memoryAgentGlobalSettings.id, current.id))
      .run()
    return mapSettings(this.mustGetSettingsRow())
  }

  ensureState(): MemoryAgentGlobalState {
    const existing = this.getStateRow()
    if (existing) {
      return mapState(existing)
    }
    const now = nowIso()
    this.handle.db
      .insert(memoryAgentGlobalState)
      .values({
        id: GLOBAL_ROW_ID,
        lastProcessedEventSequence: 0,
        status: "idle",
        createdAt: now,
        updatedAt: now,
      })
      .run()
    return mapState(this.mustGetStateRow())
  }

  updateState(input: MemoryAgentGlobalStatePatch): MemoryAgentGlobalState {
    this.ensureState()
    this.handle.db
      .update(memoryAgentGlobalState)
      .set({
        ...(input.lastProcessedEventSequence === undefined ? {} : { lastProcessedEventSequence: input.lastProcessedEventSequence }),
        ...(input.lastCheckedAt === undefined ? {} : { lastCheckedAt: input.lastCheckedAt ?? null }),
        ...(input.lastRealRunAt === undefined ? {} : { lastRealRunAt: input.lastRealRunAt ?? null }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.activeJobId === undefined ? {} : { activeJobId: input.activeJobId ?? null }),
        ...(input.lastJobId === undefined ? {} : { lastJobId: input.lastJobId ?? null }),
        ...(input.error === undefined ? {} : { error: input.error ?? null }),
        updatedAt: nowIso(),
      })
      .where(eq(memoryAgentGlobalState.id, GLOBAL_ROW_ID))
      .run()
    return mapState(this.mustGetStateRow())
  }

  private getSettingsRow(): typeof memoryAgentGlobalSettings.$inferSelect | undefined {
    return this.handle.db.select().from(memoryAgentGlobalSettings).limit(1).get()
  }

  private mustGetSettingsRow(): typeof memoryAgentGlobalSettings.$inferSelect {
    const row = this.getSettingsRow()
    if (!row) {
      throw new SocratesError("memory_agent_settings_not_found", "Global memory agent settings were not found after creation.")
    }
    return row
  }

  private getStateRow(): typeof memoryAgentGlobalState.$inferSelect | undefined {
    return this.handle.db.select().from(memoryAgentGlobalState).where(eq(memoryAgentGlobalState.id, GLOBAL_ROW_ID)).limit(1).get()
  }

  private mustGetStateRow(): typeof memoryAgentGlobalState.$inferSelect {
    const row = this.getStateRow()
    if (!row) {
      throw new SocratesError("memory_agent_state_not_found", "Global memory agent state was not found after creation.")
    }
    return row
  }
}

const normalizeThinkingEffort = (thinkingEnabled: boolean, thinkingEffort: ThinkingEffort | undefined): ThinkingEffort | undefined =>
  thinkingEnabled ? thinkingEffort && thinkingEffort !== "none" ? thinkingEffort : undefined : thinkingEffort

const mapSettings = (row: typeof memoryAgentGlobalSettings.$inferSelect): MemoryAgentGlobalSettings => ({
  id: row.id,
  providerId: row.providerId as ProviderId,
  modelId: row.modelId,
  thinkingEnabled: row.thinkingEnabled,
  ...(row.thinkingEffort ? { thinkingEffort: row.thinkingEffort as ThinkingEffort } : {}),
  enabled: row.enabled,
  cadenceMinutes: row.cadenceMinutes,
  updatedAt: row.updatedAt,
})

const mapState = (row: typeof memoryAgentGlobalState.$inferSelect): MemoryAgentGlobalState => ({
  id: "global",
  lastProcessedEventSequence: row.lastProcessedEventSequence,
  ...(row.lastCheckedAt || row.lastRunAt ? { lastCheckedAt: row.lastCheckedAt ?? row.lastRunAt ?? undefined } : {}),
  ...(row.lastRealRunAt || row.lastRunAt ? { lastRealRunAt: row.lastRealRunAt ?? row.lastRunAt ?? undefined } : {}),
  status: row.status as MemoryAgentGlobalState["status"],
  ...(row.activeJobId ? { activeJobId: row.activeJobId } : {}),
  ...(row.lastJobId ? { lastJobId: row.lastJobId } : {}),
  ...(row.error ? { error: row.error } : {}),
  updatedAt: row.updatedAt,
})
