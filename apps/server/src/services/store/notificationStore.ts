import type { Notification } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import fs from "node:fs"
import { desc, eq, isNull } from "drizzle-orm"
import { mapNotification } from "../../db/mappers"
import { memoryAgentActions, notifications } from "../../db/schema"
import { StoreBase } from "./shared"

const skillProposalStatus = (action: { status: string; targetPath: string } | undefined): string => {
  if (!action) {
    return "missing"
  }
  if (action.status === "proposed") {
    return "pending"
  }
  if (action.status === "applied") {
    return fs.existsSync(action.targetPath) ? "approved" : "deleted"
  }
  return action.status
}

export class NotificationStore extends StoreBase {
  listNotifications(input: { unreadOnly?: boolean; limit?: number } = {}): { notifications: Notification[]; unreadCount: number } {
    const limit = Math.min(input.limit ?? 50, 100)
    const base = this.handle.db.select().from(notifications)
    const rows = (input.unreadOnly ? base.where(isNull(notifications.readAt)) : base).orderBy(desc(notifications.createdAt)).limit(limit).all()
    return {
      notifications: rows.map((row) => this.withLivePayload(mapNotification(row))),
      unreadCount: this.unreadCount(),
    }
  }

  createNotification(input: {
    projectId?: string
    conversationId?: string
    turnId?: string
    type: string
    title: string
    body?: string
    severity?: Notification["severity"]
    payload?: unknown
  }): Notification {
    const now = nowIso()
    const id = createId("note")
    this.handle.db
      .insert(notifications)
      .values({
        id,
        projectId: input.projectId,
        conversationId: input.conversationId,
        turnId: input.turnId,
        type: input.type,
        title: input.title,
        body: input.body,
        severity: input.severity ?? "info",
        payloadJson: input.payload === undefined ? undefined : JSON.stringify(input.payload),
        createdAt: now,
      })
      .run()
    const row = this.handle.db.select().from(notifications).where(eq(notifications.id, id)).get()
    if (!row) {
      throw new SocratesError("notification_not_found", "Notification was not found after creation.", { details: { notificationId: id } })
    }
    const notification = this.withLivePayload(mapNotification(row))
    this.appendEvent({
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.turnId ? { turnId: input.turnId } : {}),
      type: "notification.created",
      source: "server",
      payload: { notification },
    })
    return notification
  }

  markRead(notificationId: string): { notification: Notification; unreadCount: number } {
    const now = nowIso()
    this.handle.db.update(notifications).set({ readAt: now }).where(eq(notifications.id, notificationId)).run()
    const row = this.handle.db.select().from(notifications).where(eq(notifications.id, notificationId)).get()
    if (!row) {
      throw new SocratesError("notification_not_found", "Notification was not found.", { details: { notificationId } })
    }
    const unreadCount = this.unreadCount()
    this.appendEvent({
      ...(row.projectId ? { projectId: row.projectId } : {}),
      ...(row.conversationId ? { conversationId: row.conversationId } : {}),
      ...(row.turnId ? { turnId: row.turnId } : {}),
      type: "notification.read",
      source: "server",
      payload: { notificationId, unreadCount },
    })
    return { notification: this.withLivePayload(mapNotification(row)), unreadCount }
  }

  markAllRead(): { notifications: Notification[]; unreadCount: number } {
    const now = nowIso()
    this.handle.db.update(notifications).set({ readAt: now }).where(isNull(notifications.readAt)).run()
    return this.listNotifications()
  }

  unreadCount(): number {
    const row = this.handle.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE read_at IS NULL").get() as { count: number }
    return row.count
  }

  markSkillProposalNotificationsRead(actionId: string): void {
    const rows = this.handle.sqlite
      .prepare("SELECT id, payload_json AS payloadJson FROM notifications WHERE type = 'memory.skill.proposed' AND read_at IS NULL")
      .all() as Array<{ id: string; payloadJson: string | null }>
    for (const row of rows) {
      if (payloadActionId(row.payloadJson) === actionId) {
        this.markRead(row.id)
      }
    }
  }

  private withLivePayload(notification: Notification): Notification {
    if (notification.type !== "memory.skill.proposed") {
      return notification
    }
    const payload = notification.payload && typeof notification.payload === "object" ? (notification.payload as Record<string, unknown>) : undefined
    const actionId = typeof payload?.actionId === "string" ? payload.actionId : undefined
    if (!actionId) {
      return notification
    }
    const action = this.handle.db
      .select({
        status: memoryAgentActions.status,
        targetPath: memoryAgentActions.targetPath,
      })
      .from(memoryAgentActions)
      .where(eq(memoryAgentActions.id, actionId))
      .limit(1)
      .get()
    const proposalStatus = skillProposalStatus(action)
    return {
      ...notification,
      payload: {
        ...payload,
        actionStatus: action?.status ?? "missing",
        proposalStatus,
        skillExists: action ? fs.existsSync(action.targetPath) : false,
      },
    }
  }
}

const payloadActionId = (payloadJson: string | null): string | undefined => {
  if (!payloadJson) {
    return undefined
  }
  try {
    const payload = JSON.parse(payloadJson) as unknown
    return payload && typeof payload === "object" && typeof (payload as { actionId?: unknown }).actionId === "string"
      ? (payload as { actionId: string }).actionId
      : undefined
  } catch {
    return undefined
  }
}
