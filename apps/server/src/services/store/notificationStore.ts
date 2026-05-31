import type { Notification } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { desc, eq, isNull } from "drizzle-orm"
import { mapNotification } from "../../db/mappers"
import { notifications } from "../../db/schema"
import { StoreBase } from "./shared"

export class NotificationStore extends StoreBase {
  listNotifications(input: { unreadOnly?: boolean; limit?: number } = {}): { notifications: Notification[]; unreadCount: number } {
    const limit = Math.min(input.limit ?? 50, 100)
    const base = this.handle.db.select().from(notifications)
    const rows = (input.unreadOnly ? base.where(isNull(notifications.readAt)) : base).orderBy(desc(notifications.createdAt)).limit(limit).all()
    return {
      notifications: rows.map(mapNotification),
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
    const notification = mapNotification(row)
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
    return { notification: mapNotification(row), unreadCount }
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
}
