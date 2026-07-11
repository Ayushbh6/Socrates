import crypto from "node:crypto"
import fs from "node:fs"
import {
  MAX_IMAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENT_BYTES,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_BYTES,
  type MessageAttachment,
} from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { storeAttachmentFile } from "@socrates/workspace"
import { and, eq, inArray } from "drizzle-orm"
import { artifacts, messageAttachments } from "../../db/schema"
import { mapMessageAttachment } from "../../db/mappers"
import { StoreBase } from "./shared"
import type { UploadedAttachmentInput } from "./types"

const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic", "image/svg+xml"])
const textMimeTypes = new Set(["text/plain"])

export class AttachmentStore extends StoreBase {
  createDraftAttachments(projectId: string, conversationId: string, inputs: UploadedAttachmentInput[]): MessageAttachment[] {
    this.mustGetConversationRow(projectId, conversationId)
    if (inputs.length === 0) {
      throw new SocratesError("attachment_file_required", "Upload an image or text file to attach it to the message", { recoverable: true })
    }
    if (inputs.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new SocratesError("attachment_upload_limit_exceeded", `Attach up to ${MAX_MESSAGE_ATTACHMENTS} files to one message`, {
        details: { maxFiles: MAX_MESSAGE_ATTACHMENTS, receivedFiles: inputs.length },
        recoverable: true,
      })
    }
    const totalBytes = inputs.reduce((sum, input) => sum + input.data.byteLength, 0)
    if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new SocratesError("attachment_total_too_large", "Attachments for one message must be 20 MB or smaller in total.", {
        details: { sizeBytes: totalBytes, maxAttachmentBytes: MAX_MESSAGE_ATTACHMENT_BYTES },
        recoverable: true,
      })
    }

    const workspace = this.mustGetPrimaryWorkspaceRow(projectId)
    if (!workspace.path) {
      throw new SocratesError("project_workspace_path_missing", "Project does not have a primary workspace path", {
        details: { projectId },
      })
    }

    const now = nowIso()
    const attachmentIds: string[] = []
    for (const input of inputs) {
      const mimeType = normalizeMimeType(input.mimeType, input.originalName)
      const kind = imageMimeTypes.has(mimeType) ? "image" : textMimeTypes.has(mimeType) ? "text" : undefined
      if (!kind) {
        throw new SocratesError("attachment_type_not_supported", "Chat attachments support images and plain-text files only.", {
          details: { fileName: input.originalName, mimeType },
          recoverable: true,
        })
      }
      const maxBytes = kind === "image" ? MAX_IMAGE_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES
      if (input.data.byteLength > maxBytes) {
        throw new SocratesError("attachment_too_large", `${kind === "image" ? "Image" : "Text"} attachments must be 5 MB or smaller.`, {
          details: { fileName: input.originalName, sizeBytes: input.data.byteLength, maxAttachmentBytes: maxBytes },
          recoverable: true,
        })
      }

      const stored = storeAttachmentFile({ workspacePath: workspace.path, originalName: input.originalName, data: input.data })
      const artifactId = createId("art")
      const attachmentId = createId("att")

      this.handle.db
        .insert(artifacts)
        .values({
          id: artifactId,
          projectId,
          conversationId,
          kind: "message_attachment",
          path: stored.path,
          contentHash: crypto.createHash("sha256").update(input.data).digest("hex"),
          mimeType,
          sizeBytes: input.data.byteLength,
          createdAt: now,
        })
        .run()

      this.handle.db
        .insert(messageAttachments)
        .values({
          id: attachmentId,
          projectId,
          conversationId,
          artifactId,
          kind,
          fileName: stored.fileName,
          mimeType,
          sizeBytes: input.data.byteLength,
          uri: stored.path,
          status: "draft",
          createdAt: now,
          updatedAt: now,
        })
        .run()
      attachmentIds.push(attachmentId)
    }

    return this.getAttachmentsByIds(projectId, conversationId, attachmentIds)
  }

  attachToMessage(input: {
    projectId: string
    conversationId: string
    sessionId: string
    turnId: string
    messageId: string
    attachmentIds: string[]
  }): MessageAttachment[] {
    if (input.attachmentIds.length === 0) {
      return []
    }
    if (input.attachmentIds.length > MAX_MESSAGE_ATTACHMENTS) {
      throw new SocratesError("attachment_upload_limit_exceeded", `Attach up to ${MAX_MESSAGE_ATTACHMENTS} files to one message`, {
        details: { maxFiles: MAX_MESSAGE_ATTACHMENTS, receivedFiles: input.attachmentIds.length },
        recoverable: true,
      })
    }

    const rows = this.getAttachmentRowsByIds(input.projectId, input.conversationId, input.attachmentIds)
    if (rows.length !== new Set(input.attachmentIds).size) {
      throw new SocratesError("attachment_not_found", "One or more attachments could not be found.", { recoverable: true })
    }
    const invalid = rows.find((row) => row.status !== "draft")
    if (invalid) {
      throw new SocratesError("attachment_not_attachable", "One or more attachments are no longer attachable.", {
        details: { attachmentId: invalid.id, status: invalid.status },
        recoverable: true,
      })
    }
    const totalBytes = rows.reduce((sum, row) => sum + row.sizeBytes, 0)
    if (totalBytes > MAX_MESSAGE_ATTACHMENT_BYTES) {
      throw new SocratesError("attachment_total_too_large", "Attachments for one message must be 20 MB or smaller in total.", {
        details: { sizeBytes: totalBytes, maxAttachmentBytes: MAX_MESSAGE_ATTACHMENT_BYTES },
        recoverable: true,
      })
    }

    const now = nowIso()
    for (const row of rows) {
      this.handle.db
        .update(messageAttachments)
        .set({
          sessionId: input.sessionId,
          turnId: input.turnId,
          messageId: input.messageId,
          status: "attached",
          updatedAt: now,
        })
        .where(eq(messageAttachments.id, row.id))
        .run()
      this.handle.db
        .update(artifacts)
        .set({ sessionId: input.sessionId, turnId: input.turnId })
        .where(eq(artifacts.id, row.artifactId))
        .run()
    }

    return this.getAttachmentsByIds(input.projectId, input.conversationId, input.attachmentIds)
  }

  getAttachmentsForMessages(messageIds: string[]): Map<string, MessageAttachment[]> {
    const unique = Array.from(new Set(messageIds))
    if (unique.length === 0) {
      return new Map()
    }
    const rows = this.handle.db
      .select()
      .from(messageAttachments)
      .where(inArray(messageAttachments.messageId, unique))
      .all()
      .filter((row) => row.status === "attached")
      .map(mapMessageAttachment)

    const grouped = new Map<string, MessageAttachment[]>()
    for (const row of rows) {
      if (!row.messageId) {
        continue
      }
      grouped.set(row.messageId, [...(grouped.get(row.messageId) ?? []), row])
    }
    return grouped
  }

  readAttachmentDataUrl(attachment: MessageAttachment): string | undefined {
    try {
      const data = fs.readFileSync(attachment.uri)
      return `data:${attachment.mimeType};base64,${data.toString("base64")}`
    } catch {
      return undefined
    }
  }

  getAttachmentForContent(projectId: string, conversationId: string, attachmentId: string): MessageAttachment {
    const row = this.handle.db
      .select()
      .from(messageAttachments)
      .where(and(eq(messageAttachments.projectId, projectId), eq(messageAttachments.conversationId, conversationId), eq(messageAttachments.id, attachmentId)))
      .get()
    if (!row || row.status === "deleted") {
      throw new SocratesError("attachment_not_found", "Attachment not found.", { recoverable: true })
    }
    return mapMessageAttachment(row)
  }

  private getAttachmentsByIds(projectId: string, conversationId: string, attachmentIds: string[]): MessageAttachment[] {
    return this.getAttachmentRowsByIds(projectId, conversationId, attachmentIds).map(mapMessageAttachment)
  }

  private getAttachmentRowsByIds(projectId: string, conversationId: string, attachmentIds: string[]) {
    const unique = Array.from(new Set(attachmentIds))
    if (unique.length === 0) {
      return []
    }
    return this.handle.db
      .select()
      .from(messageAttachments)
      .where(and(eq(messageAttachments.projectId, projectId), eq(messageAttachments.conversationId, conversationId), inArray(messageAttachments.id, unique)))
      .all()
  }
}

const normalizeMimeType = (mimeType: string | undefined, fileName: string): string => {
  if (mimeType && mimeType !== "application/octet-stream") {
    return mimeType.toLowerCase()
  }
  const lower = fileName.toLowerCase()
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".gif")) return "image/gif"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".heic")) return "image/heic"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (lower.endsWith(".txt") || lower.endsWith(".md") || lower.endsWith(".log")) return "text/plain"
  return mimeType?.toLowerCase() ?? "application/octet-stream"
}
