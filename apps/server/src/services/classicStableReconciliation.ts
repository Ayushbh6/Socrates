import { and, eq, isNotNull } from "drizzle-orm"
import { nowIso } from "@socrates/shared"
import type { DatabaseHandle } from "../db/client"
import {
  schemaMigrations,
  v2Turns,
} from "../db/schema"
import { V2FlowStore } from "./v2/flowStore"

// Keep this outside the sequential schema-migration range: this records a
// one-time data repair, not a Drizzle schema migration.
const CLASSIC_STABLE_RECONCILIATION_VERSION = 2_026_091_601
const CLASSIC_STABLE_RECONCILIATION_NAME = "classic_stable_release_reconciliation"

export type ClassicStableReconciliationResult = {
  alreadyApplied: boolean
  recoveredTurns: number
  releasedConversations: number
}

/**
 * One-time compatibility work for users who opened the experimental Flow in
 * v0.1.19. Visible completed Flow turns are projected into their Classic
 * conversation idempotently, then every bridge is handed back to Classic.
 * Historical v2_* data remains untouched so a future experimental build can
 * migrate it deliberately; normal stable runtime code never starts Flow.
 */
export const reconcileClassicStableRelease = (
  handle: DatabaseHandle,
): ClassicStableReconciliationResult => {
  const applied = handle.db
    .select({ version: schemaMigrations.version })
    .from(schemaMigrations)
    .where(eq(schemaMigrations.version, CLASSIC_STABLE_RECONCILIATION_VERSION))
    .limit(1)
    .get()
  if (applied) {
    return {
      alreadyApplied: true,
      recoveredTurns: 0,
      releasedConversations: releaseInactiveBridges(handle),
    }
  }

  const store = new V2FlowStore(handle)
  const candidates = handle.db
    .select({
      id: v2Turns.id,
      projectId: v2Turns.projectId,
      flowId: v2Turns.flowId,
    })
    .from(v2Turns)
    .where(and(
      eq(v2Turns.status, "completed"),
      isNotNull(v2Turns.goalId),
      isNotNull(v2Turns.userMessageId),
      isNotNull(v2Turns.assistantMessageId),
    ))
    .all()

  let recoveredTurns = 0
  for (const turn of candidates) {
    const before = handle.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
           FROM v2_classic_message_links links
           JOIN v2_messages messages ON messages.id = links.v2_message_id
          WHERE messages.turn_id = ?`,
      )
      .get(turn.id) as { count: number }
    store.mirrorV2TurnToClassic(turn.projectId, turn.flowId, turn.id, { allowClassicOwner: true })
    const after = handle.sqlite
      .prepare(
        `SELECT COUNT(*) AS count
           FROM v2_classic_message_links links
           JOIN v2_messages messages ON messages.id = links.v2_message_id
          WHERE messages.turn_id = ?`,
      )
      .get(turn.id) as { count: number }
    if (after.count > before.count) recoveredTurns += 1
  }

  const releasedConversations = releaseInactiveBridges(handle)

  handle.db.insert(schemaMigrations).values({
    version: CLASSIC_STABLE_RECONCILIATION_VERSION,
    name: CLASSIC_STABLE_RECONCILIATION_NAME,
    appliedAt: nowIso(),
  }).run()

  return { alreadyApplied: false, recoveredTurns, releasedConversations }
}

const releaseInactiveBridges = (handle: DatabaseHandle): number => handle.sqlite
  .prepare(
    `UPDATE v2_classic_conversation_bridges
        SET active_owner = 'classic', updated_at = ?
      WHERE active_owner = 'v2'
        AND NOT EXISTS (
          SELECT 1
            FROM v2_turns
           WHERE v2_turns.flow_id = v2_classic_conversation_bridges.flow_id
             AND v2_turns.goal_id = v2_classic_conversation_bridges.goal_id
             AND v2_turns.status IN ('queued','routing','awaiting_clarification','running','waiting')
        )`,
  )
  .run(nowIso()).changes
