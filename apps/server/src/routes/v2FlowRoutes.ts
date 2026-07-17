import fs from "node:fs"
import type { FastifyInstance, FastifyReply } from "fastify"
import "@fastify/multipart"
import { z } from "zod"
import {
  MAX_MESSAGE_ATTACHMENTS,
  V2_FLOW_MESSAGE_PAGE_MAX,
  V2_FLOW_SNAPSHOT_MESSAGE_LIMIT,
  v2EnsureFlowRequestSchema,
  v2EnsureFlowResponseSchema,
  v2GetFlowResponseSchema,
  v2ListFlowMessagesResponseSchema,
} from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { fail, ok, toApiError } from "../http"
import type { V2FlowStore } from "../services/v2/flowStore"

const projectParamsSchema = z.object({ projectId: z.string().min(1) }).strict()
const flowParamsSchema = projectParamsSchema.extend({ flowId: z.string().min(1) }).strict()
const attachmentParamsSchema = flowParamsSchema.extend({ attachmentId: z.string().min(1) }).strict()
const goalParamsSchema = flowParamsSchema.extend({ goalId: z.string().min(1) }).strict()
const classicConversationParamsSchema = projectParamsSchema.extend({ conversationId: z.string().min(1) }).strict()
const timelineQuerySchema = z
  .object({
    afterSequence: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(2_000).default(500),
  })
  .strict()
const messagesQuerySchema = z
  .object({
    beforeOrdinal: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(V2_FLOW_MESSAGE_PAGE_MAX).default(V2_FLOW_SNAPSHOT_MESSAGE_LIMIT),
  })
  .strict()
const evidenceRetrieveSchema = z
  .object({ evidenceIds: z.array(z.string().min(1)).min(1).max(50) })
  .strict()

const parse = <T>(schema: z.ZodType<T>, value: unknown, code: string): T => {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new SocratesError(code, "Request did not match the V2 Flow contract.", {
      details: parsed.error.flatten(),
      recoverable: true,
    })
  }
  return parsed.data
}

const routeError = (error: unknown) => {
  const api = toApiError(error)
  const statusCode =
    api.code === "invalid_route_params" ||
    api.code === "invalid_query" ||
    api.code === "invalid_request" ||
    api.code.startsWith("attachment_type_") ||
    api.code === "attachment_upload_limit_exceeded"
      ? 400
      : api.code.includes("too_large") || api.code.includes("limit_exceeded")
        ? 413
        : api.code.endsWith("_not_found") || api.code === "project_workspace_path_missing"
          ? 404
          : api.code === "v2_turn_already_active" || api.code === "v2_client_message_conflict" || api.code.includes("owned_by") || api.code === "v2_focus_still_active"
            ? 409
            : 500
  return { statusCode, response: fail(api) }
}

const sendRouteError = (reply: FastifyReply, error: unknown) => {
  const { statusCode, response } = routeError(error)
  return reply.code(statusCode).send(response)
}

/**
 * Registers only V2 Flow HTTP resources. The caller decides whether the V2
 * feature flag is enabled; this module never mounts Classic routes or creates a
 * Classic conversation as a side effect.
 */
export const registerV2FlowRoutes = async (app: FastifyInstance, store: V2FlowStore): Promise<void> => {
  app.post("/api/v2/projects/:projectId/flow", async (request, reply) => {
    try {
      const { projectId } = parse(projectParamsSchema, request.params, "invalid_route_params")
      parse(v2EnsureFlowRequestSchema, request.body ?? {}, "invalid_request")
      return ok(v2EnsureFlowResponseSchema.parse({ snapshot: store.ensureFlow(projectId) }))
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.get("/api/v2/projects/:projectId/flow", async (request, reply) => {
    try {
      const { projectId } = parse(projectParamsSchema, request.params, "invalid_route_params")
      return ok(v2GetFlowResponseSchema.parse({ snapshot: store.getSnapshot(projectId) }))
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.post("/api/v2/projects/:projectId/flows/:flowId/goals/:goalId/open-in-classic", async (request, reply) => {
    try {
      const scope = parse(goalParamsSchema, request.params, "invalid_route_params")
      const bridge = store.openFocusInClassic(scope.projectId, scope.flowId, scope.goalId)
      return ok({ bridge, href: `/projects/${encodeURIComponent(scope.projectId)}/chats/${encodeURIComponent(bridge.conversationId)}` })
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.post("/api/v2/projects/:projectId/bridge/classic/:conversationId/continue", async (request, reply) => {
    try {
      const scope = parse(classicConversationParamsSchema, request.params, "invalid_route_params")
      const snapshot = store.continueClassicConversationInSeamless(scope.projectId, scope.conversationId)
      return ok({ snapshot, href: `/seamless/projects/${encodeURIComponent(scope.projectId)}` })
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.get("/api/v2/projects/:projectId/flows/:flowId/events", async (request, reply) => {
    try {
      const scope = parse(flowParamsSchema, request.params, "invalid_route_params")
      const query = parse(timelineQuerySchema, request.query, "invalid_query")
      const events = store.listRuntimeEvents(scope.projectId, scope.flowId, query.afterSequence, query.limit)
      return ok({
        events,
        nextSequence: events.at(-1)?.sequence ?? query.afterSequence,
      })
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.get("/api/v2/projects/:projectId/flows/:flowId/messages", async (request, reply) => {
    try {
      const scope = parse(flowParamsSchema, request.params, "invalid_route_params")
      const query = parse(messagesQuerySchema, request.query, "invalid_query")
      const page = store.listMessages(scope.projectId, scope.flowId, query.beforeOrdinal, query.limit)
      return ok(v2ListFlowMessagesResponseSchema.parse(page))
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.get("/api/v2/projects/:projectId/flows/:flowId/context", async (request, reply) => {
    try {
      const scope = parse(flowParamsSchema, request.params, "invalid_route_params")
      store.getFlow(scope.projectId, scope.flowId)
      return ok({
        state: { evidence: [], items: store.getActiveContextItems(scope.flowId) },
        counts: store.getContextCounts(scope.flowId),
      })
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.post("/api/v2/projects/:projectId/flows/:flowId/evidence/retrieve", async (request, reply) => {
    try {
      const scope = parse(flowParamsSchema, request.params, "invalid_route_params")
      store.getFlow(scope.projectId, scope.flowId)
      const { evidenceIds } = parse(evidenceRetrieveSchema, request.body, "invalid_request")
      return ok({ evidence: store.retrieveExactEvidence(scope.flowId, evidenceIds) })
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.post("/api/v2/projects/:projectId/flows/:flowId/attachments/upload", async (request, reply) => {
    try {
      const scope = parse(flowParamsSchema, request.params, "invalid_route_params")
      store.getFlow(scope.projectId, scope.flowId)
      const inputs: Array<{ originalName: string; data: Buffer; mimeType?: string }> = []
      for await (const part of request.files()) {
        if (inputs.length >= MAX_MESSAGE_ATTACHMENTS) {
          throw new SocratesError(
            "attachment_upload_limit_exceeded",
            `Attach up to ${MAX_MESSAGE_ATTACHMENTS} files to one message.`,
            { recoverable: true },
          )
        }
        const data = await part.toBuffer()
        inputs.push({
          originalName: part.filename,
          data,
          ...(part.mimetype ? { mimeType: part.mimetype } : {}),
        })
      }
      if (inputs.length === 0) {
        throw new SocratesError("attachment_file_required", "Choose at least one file to attach.", { recoverable: true })
      }
      return ok({ attachments: store.createDraftAttachments(scope.projectId, scope.flowId, inputs) })
    } catch (error) {
      return sendRouteError(reply, error)
    }
  })

  app.get(
    "/api/v2/projects/:projectId/flows/:flowId/attachments/:attachmentId/content",
    async (request, reply) => {
      try {
        const scope = parse(attachmentParamsSchema, request.params, "invalid_route_params")
        const attachment = store.getAttachmentContent(scope.projectId, scope.flowId, scope.attachmentId)
        const data = fs.readFileSync(attachment.uri)
        reply.header("Content-Type", attachment.mimeType)
        reply.header("Content-Length", String(data.byteLength))
        reply.header("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`)
        return reply.send(data)
      } catch (error) {
        return sendRouteError(reply, error)
      }
    },
  )
}
