import type { FastifyInstance } from "fastify"
import fs from "node:fs"
import { z } from "zod"
import {
  completeOnboardingRequestSchema,
  approveMemorySkillProposalResponseSchema,
  buildGlobalSkillRequestSchema,
  buildProjectSkillRequestSchema,
  checkProjectEmbeddingsRequestSchema,
  checkMcpServerRequestSchema,
  checkMcpServerResponseSchema,
  checkProviderCredentialRequestSchema,
  configureProjectEmbeddingsRequestSchema,
  createConversationMessageRequestSchema,
  createConversationRequestSchema,
  createProjectRequestSchema,
  createProjectResourceRequestSchema,
  deleteMcpServerRequestSchema,
  deleteMcpServerResponseSchema,
  deleteSkillResponseSchema,
  inspectWorkspaceRequestSchema,
  listMcpServersQuerySchema,
  listMcpServersResponseSchema,
  getMemoryAgentFileContentResponseSchema,
  getMemoryAgentRunResponseSchema,
  listMemoryAgentFilesResponseSchema,
  listMemoryAgentRunsResponseSchema,
  listWorkerModelSettingsResponseSchema,
  memoryAgentFileContentQuerySchema,
  listNotificationsResponseSchema,
  markAllNotificationsReadResponseSchema,
  markNotificationReadResponseSchema,
  patchProjectRequestSchema,
  pickWorkspaceFolderRequestSchema,
  providerIdSchema,
  rejectMemorySkillProposalResponseSchema,
  setProviderCredentialSessionRequestSchema,
  updateMemoryAgentGlobalSettingsRequestSchema,
  updateWorkerModelSettingsRequestSchema,
  updateWorkerModelSettingsResponseSchema,
  updateMcpServerRequestSchema,
  updateMcpServerResponseSchema,
  updateProjectWorkspaceRequestSchema,
  updateConversationRequestSchema,
  upsertMcpServerRequestSchema,
  upsertMcpServerResponseSchema,
  upsertProjectInstructionsRequestSchema,
  workerModelSettingsParamsSchema,
} from "@socrates/contracts"
import { listModels } from "@socrates/core"
import type { McpRuntime } from "@socrates/mcp"
import { SocratesError } from "@socrates/shared"
import { apiError, fail, ok, toApiError } from "../http"
import type { SocratesStore, UploadedResourceInput } from "../services/store"
import type { ProviderCredentialStore } from "../services/providerCredentials"

const projectParamsSchema = z.object({ projectId: z.string().min(1) }).strict()
const resourceParamsSchema = z.object({ projectId: z.string().min(1), resourceId: z.string().min(1) }).strict()
const conversationParamsSchema = z.object({ projectId: z.string().min(1), conversationId: z.string().min(1) }).strict()
const attachmentParamsSchema = z.object({ projectId: z.string().min(1), conversationId: z.string().min(1), attachmentId: z.string().min(1) }).strict()
const providerCredentialParamsSchema = z.object({ providerId: providerIdSchema }).strict()
const notificationParamsSchema = z.object({ notificationId: z.string().min(1) }).strict()
const memoryActionParamsSchema = z.object({ actionId: z.string().min(1) }).strict()
const memoryAgentRunParamsSchema = z.object({ runId: z.string().min(1) }).strict()
const mcpServerParamsSchema = z.object({ serverId: z.string().min(1) }).strict()
const skillParamsSchema = z.object({ skillName: z.string().min(1) }).strict()
const projectSkillParamsSchema = z.object({ projectId: z.string().min(1), skillName: z.string().min(1) }).strict()
const memoryAgentRunsQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().max(100).optional(),
    offset: z.coerce.number().int().nonnegative().optional(),
  })
  .strict()
const notificationsQuerySchema = z
  .object({
    unreadOnly: z.enum(["true", "false"]).optional(),
    limit: z.coerce.number().int().positive().max(100).optional(),
  })
  .strict()

type HttpRouteHooks = {
  onConversationDelete?: (conversationId: string) => void
  onProjectWorkspaceSwitch?: (projectId: string) => void
}

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    throw new SocratesError("invalid_request", "Request body did not match the API contract", {
      details: parsed.error.flatten(),
      recoverable: true,
    })
  }
  return parsed.data
}

const parseParams = <T>(schema: z.ZodType<T>, params: unknown): T => {
  const parsed = schema.safeParse(params)
  if (!parsed.success) {
    throw new SocratesError("invalid_route_params", "Route params did not match the API contract", {
      details: parsed.error.flatten(),
      recoverable: true,
    })
  }
  return parsed.data
}

const requiredProjectId = (projectId: string | undefined): string => {
  if (!projectId) {
    throw new SocratesError("project_id_required", "projectId is required for project-scoped MCP servers.", { recoverable: true })
  }
  return projectId
}

const handleRouteError = (error: unknown) => {
  const api = toApiError(error)
  const statusCode =
    api.code === "invalid_request" ||
    api.code === "invalid_route_params" ||
    api.code === "workspace_path_not_absolute" ||
    api.code === "workspace_path_not_directory" ||
    api.code === "conversation_title_required" ||
    api.code === "message_content_required" ||
    api.code === "project_id_required" ||
    api.code === "mcp_project_workspace_required" ||
    api.code === "mcp_server_not_configured" ||
        api.code === "resource_file_required" ||
        api.code === "attachment_file_required" ||
        api.code === "attachment_type_not_supported" ||
        api.code === "attachment_too_large" ||
        api.code === "resource_upload_limit_exceeded" ||
        api.code === "attachment_upload_limit_exceeded" ||
    api.code === "embedding_check_failed" ||
    api.code === "memory_agent_model_required" ||
    api.code === "memory_agent_cadence_invalid" ||
    api.code === "worker_model_required" ||
    api.code === "workspace_env_file_not_allowed"
      ? 400
      : api.code.endsWith("_not_found")
        ? 404
        : api.code === "user_not_onboarded" ||
            api.code === "workspace_already_attached" ||
            api.code === "workspace_scaffold_action_required" ||
            api.code === "project_workspace_has_active_turn" ||
            api.code === "project_workspace_same_path_reset_denied"
          ? 409
          : api.code === "folder_picker_cancelled"
            ? 499
          : 500

  return { statusCode, response: fail(api) }
}

export const registerHttpRoutes = async (
  app: FastifyInstance,
  store: SocratesStore,
  credentials: ProviderCredentialStore,
  mcpRuntime?: McpRuntime,
  hooks: HttpRouteHooks = {},
): Promise<void> => {
  app.get("/health", async () => ok({ status: "ok" }))

  app.get("/api/me", async () => ok({ user: store.getCurrentUser() }))

  app.get("/api/models", async () => ok(listModels()))

  app.get("/api/worker-model-settings", async (_request, reply) => {
    try {
      return ok(listWorkerModelSettingsResponseSchema.parse(store.listWorkerModelSettings()))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.patch("/api/worker-model-settings/:workerId", async (request, reply) => {
    try {
      const { workerId } = parseParams(workerModelSettingsParamsSchema, request.params)
      const input = parseBody(updateWorkerModelSettingsRequestSchema, request.body)
      return ok(updateWorkerModelSettingsResponseSchema.parse(store.updateWorkerModelSettings(workerId, input)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/mcp", async (request, reply) => {
    try {
      if (!mcpRuntime) {
        throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
      }
      const query = parseBody(listMcpServersQuerySchema, request.query)
      const workspacePath = query.projectId ? store.getPrimaryWorkspacePath(query.projectId) : undefined
      const servers = mcpRuntime.listManagedServers({ workspacePath })
      return ok(listMcpServersResponseSchema.parse({ servers: query.scope ? servers.filter((server) => server.scope === query.scope) : servers }))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/mcp/servers", async (request, reply) => {
    try {
      if (!mcpRuntime) {
        throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
      }
      const input = parseBody(upsertMcpServerRequestSchema, request.body)
      const workspacePath = input.scope === "project" ? store.getPrimaryWorkspacePath(requiredProjectId(input.projectId)) : undefined
      return ok(upsertMcpServerResponseSchema.parse({ server: mcpRuntime.upsertManagedServer(input.scope, input.server, { workspacePath }) }))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.patch("/api/mcp/servers/:serverId", async (request, reply) => {
    try {
      if (!mcpRuntime) {
        throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
      }
      const { serverId } = parseParams(mcpServerParamsSchema, request.params)
      const input = parseBody(updateMcpServerRequestSchema, request.body)
      const workspacePath = input.scope === "project" ? store.getPrimaryWorkspacePath(requiredProjectId(input.projectId)) : undefined
      return ok(updateMcpServerResponseSchema.parse({ server: mcpRuntime.updateManagedServer(input.scope, serverId, input, { workspacePath }) }))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.delete("/api/mcp/servers/:serverId", async (request, reply) => {
    try {
      if (!mcpRuntime) {
        throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
      }
      const { serverId } = parseParams(mcpServerParamsSchema, request.params)
      const input = parseBody(deleteMcpServerRequestSchema, request.body)
      const workspacePath = input.scope === "project" ? store.getPrimaryWorkspacePath(requiredProjectId(input.projectId)) : undefined
      mcpRuntime.deleteManagedServer(input.scope, serverId, { workspacePath })
      return ok(deleteMcpServerResponseSchema.parse({ deletedServerId: serverId, scope: input.scope }))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/mcp/servers/:serverId/check", async (request, reply) => {
    try {
      if (!mcpRuntime) {
        throw new SocratesError("mcp_runtime_unavailable", "MCP runtime is not available.", { recoverable: true })
      }
      const { serverId } = parseParams(mcpServerParamsSchema, request.params)
      const input = parseBody(checkMcpServerRequestSchema, request.body)
      const workspacePath = input.scope === "project" ? store.getPrimaryWorkspacePath(requiredProjectId(input.projectId)) : input.projectId ? store.getPrimaryWorkspacePath(input.projectId) : undefined
      return ok(checkMcpServerResponseSchema.parse(await mcpRuntime.checkManagedServer(serverId, { scope: input.scope, workspacePath })))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/notifications", async (request, reply) => {
    try {
      const query = parseBody(notificationsQuerySchema, request.query)
      return ok(
        listNotificationsResponseSchema.parse(
          store.listNotifications({
            ...(query.unreadOnly === undefined ? {} : { unreadOnly: query.unreadOnly === "true" }),
            ...(query.limit === undefined ? {} : { limit: query.limit }),
          }),
        ),
      )
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/notifications/:notificationId/read", async (request, reply) => {
    try {
      const { notificationId } = parseParams(notificationParamsSchema, request.params)
      return ok(markNotificationReadResponseSchema.parse(store.markNotificationRead(notificationId)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/notifications/read-all", async (_request, reply) => {
    try {
      return ok(markAllNotificationsReadResponseSchema.parse(store.markAllNotificationsRead()))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/memory-agent/skill-proposals/:actionId/approve", async (request, reply) => {
    try {
      const { actionId } = parseParams(memoryActionParamsSchema, request.params)
      return ok(approveMemorySkillProposalResponseSchema.parse(await store.approveMemorySkillProposal(actionId)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/provider-credentials/status", async () => ok(credentials.listStatus()))

  app.post("/api/provider-credentials/check", async (request, reply) => {
    try {
      const input = parseBody(checkProviderCredentialRequestSchema, request.body)
      return ok(credentials.check(input.providerId, input.apiKey))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/provider-credentials/session", async (request, reply) => {
    try {
      const input = parseBody(setProviderCredentialSessionRequestSchema, request.body)
      return ok({ status: credentials.setSessionCredential(input) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.delete("/api/provider-credentials/:providerId", async (request, reply) => {
    try {
      const { providerId } = parseParams(providerCredentialParamsSchema, request.params)
      return ok({ status: credentials.deleteSessionCredential(providerId) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/onboarding", async (request, reply) => {
    try {
      const input = parseBody(completeOnboardingRequestSchema, request.body)
      return ok({ user: store.completeOnboarding(input) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/workspaces/pick-folder", async (request, reply) => {
    try {
      const input = parseBody(pickWorkspaceFolderRequestSchema, request.body)
      return ok(await store.pickWorkspaceFolder(input))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/workspaces/inspect", async (request, reply) => {
    try {
      const input = parseBody(inspectWorkspaceRequestSchema, request.body)
      return ok(store.inspectWorkspace(input))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/memory-agent", async (_request, reply) => {
    try {
      return ok(store.getMemoryAgent())
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/memory-agent/skill-proposals/:actionId/reject", async (request, reply) => {
    try {
      const { actionId } = parseParams(memoryActionParamsSchema, request.params)
      return ok(rejectMemorySkillProposalResponseSchema.parse(store.rejectMemorySkillProposal(actionId)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/memory-agent/runs", async (request, reply) => {
    try {
      const parsedQuery = parseBody(memoryAgentRunsQuerySchema, request.query)
      const query = {
        ...(parsedQuery.limit !== undefined ? { limit: parsedQuery.limit } : {}),
        ...(parsedQuery.offset !== undefined ? { offset: parsedQuery.offset } : {}),
      }
      return ok(listMemoryAgentRunsResponseSchema.parse(store.listMemoryAgentRuns(query)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/memory-agent/runs/:runId", async (request, reply) => {
    try {
      const { runId } = parseParams(memoryAgentRunParamsSchema, request.params)
      return ok(getMemoryAgentRunResponseSchema.parse(store.getMemoryAgentRun(runId)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/memory-agent/files", async (_request, reply) => {
    try {
      return ok(listMemoryAgentFilesResponseSchema.parse(store.listMemoryAgentFiles()))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/memory-agent/files/content", async (request, reply) => {
    try {
      const query = parseBody(memoryAgentFileContentQuerySchema, request.query)
      return ok(getMemoryAgentFileContentResponseSchema.parse(store.getMemoryAgentFileContent(query)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.patch("/api/memory-agent/settings", async (request, reply) => {
    try {
      const input = parseBody(updateMemoryAgentGlobalSettingsRequestSchema, request.body)
      return ok(store.updateMemoryAgentSettings(input))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/memory-agent/run", async (_request, reply) => {
    try {
      return ok(await store.runGlobalMemoryAgent("manual"))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/memory-agent/skills/build", async (request, reply) => {
    try {
      const input = parseBody(buildGlobalSkillRequestSchema, request.body)
      return ok(await store.buildGlobalSkill(input))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.delete("/api/memory-agent/skills/:skillName", async (request, reply) => {
    try {
      const { skillName } = parseParams(skillParamsSchema, request.params)
      return ok(deleteSkillResponseSchema.parse(store.deleteGlobalSkill(skillName)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/projects", async (_request, reply) => {
    try {
      return ok({ projects: store.listProjects() })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects", async (request, reply) => {
    try {
      const input = parseBody(createProjectRequestSchema, request.body)
      return ok(store.createProject(input))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/projects/:projectId", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      return ok(store.getProjectDashboard(projectId))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.patch("/api/projects/:projectId", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const input = parseBody(patchProjectRequestSchema, request.body)
      return ok({ project: store.patchProject(projectId, input) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.patch("/api/projects/:projectId/workspace", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const input = parseBody(updateProjectWorkspaceRequestSchema, request.body)
      const result = store.updateProjectWorkspace(projectId, input)
      hooks.onProjectWorkspaceSwitch?.(projectId)
      return ok(result)
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/projects/:projectId/embeddings/status", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      return ok({ status: store.getProjectEmbeddingStatus(projectId) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/embeddings/check", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const input = parseBody(checkProjectEmbeddingsRequestSchema, request.body)
      return ok(await store.checkProjectEmbeddings(projectId, input))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/embeddings/configure", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const input = parseBody(configureProjectEmbeddingsRequestSchema, request.body)
      return ok({ status: await store.configureProjectEmbeddings(projectId, input) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/embeddings/reindex", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      return ok({ status: store.reindexProjectEmbeddings(projectId) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/projects/:projectId/resources", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      return ok({ resources: store.listResources(projectId) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/resources", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const input = parseBody(createProjectResourceRequestSchema, request.body)
      return ok({ resource: store.createResource(projectId, input) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/resources/upload", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const uploads: UploadedResourceInput[] = []
      for await (const upload of request.files()) {
        if (uploads.length >= 10) {
          throw new SocratesError("resource_upload_limit_exceeded", "Upload up to 10 files at once", {
            details: { maxFiles: 10 },
            recoverable: true,
          })
        }
        uploads.push({
          originalName: upload.filename,
          data: await upload.toBuffer(),
          mimeType: upload.mimetype,
        })
      }

      if (uploads.length === 0) {
        throw new SocratesError("resource_file_required", "Upload a file to add a project resource")
      }

      return ok({ resources: store.createUploadedResources(projectId, uploads) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.delete("/api/projects/:projectId/resources/:resourceId", async (request, reply) => {
    try {
      const { projectId, resourceId } = parseParams(resourceParamsSchema, request.params)
      return ok({ deletedResourceId: store.deleteResource(projectId, resourceId) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.put("/api/projects/:projectId/instructions", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const input = parseBody(upsertProjectInstructionsRequestSchema, request.body)
      return ok({ instructions: store.upsertProjectInstructions(projectId, input) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/skills/build", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const input = parseBody(buildProjectSkillRequestSchema, request.body)
      return ok(await store.buildProjectSkill(projectId, input))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.delete("/api/projects/:projectId/skills/:skillName", async (request, reply) => {
    try {
      const { projectId, skillName } = parseParams(projectSkillParamsSchema, request.params)
      return ok(deleteSkillResponseSchema.parse(store.deleteProjectSkill(projectId, skillName)))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/projects/:projectId/conversations", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      return ok({ conversations: store.listConversations(projectId) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/conversations", async (request, reply) => {
    try {
      const { projectId } = parseParams(projectParamsSchema, request.params)
      const input = parseBody(createConversationRequestSchema, request.body)
      return ok({ conversation: store.createConversation(projectId, input) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/projects/:projectId/conversations/:conversationId", async (request, reply) => {
    try {
      const { projectId, conversationId } = parseParams(conversationParamsSchema, request.params)
      return ok(store.getConversation(projectId, conversationId))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/conversations/:conversationId/attachments/upload", async (request, reply) => {
    try {
      const { projectId, conversationId } = parseParams(conversationParamsSchema, request.params)
      const uploads: UploadedResourceInput[] = []
      for await (const upload of request.files()) {
        if (uploads.length >= 12) {
          throw new SocratesError("attachment_upload_limit_exceeded", "Attach up to 12 images to one message", {
            details: { maxFiles: 12 },
            recoverable: true,
          })
        }
        uploads.push({
          originalName: upload.filename,
          data: await upload.toBuffer(),
          mimeType: upload.mimetype,
        })
      }
      return ok({ attachments: store.createConversationAttachments(projectId, conversationId, uploads) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.get("/api/projects/:projectId/conversations/:conversationId/attachments/:attachmentId/content", async (request, reply) => {
    try {
      const { projectId, conversationId, attachmentId } = parseParams(attachmentParamsSchema, request.params)
      const attachment = store.getConversationAttachmentContent(projectId, conversationId, attachmentId)
      return reply.type(attachment.mimeType).send(fs.createReadStream(attachment.uri))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.patch("/api/projects/:projectId/conversations/:conversationId", async (request, reply) => {
    try {
      const { projectId, conversationId } = parseParams(conversationParamsSchema, request.params)
      const input = parseBody(updateConversationRequestSchema, request.body)
      return ok({ conversation: store.updateConversationTitle(projectId, conversationId, input) })
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.delete("/api/projects/:projectId/conversations/:conversationId", async (request, reply) => {
    try {
      const { projectId, conversationId } = parseParams(conversationParamsSchema, request.params)
      hooks.onConversationDelete?.(conversationId)
      return ok(store.deleteConversation(projectId, conversationId))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.post("/api/projects/:projectId/conversations/:conversationId/messages", async (request, reply) => {
    try {
      const { projectId, conversationId } = parseParams(conversationParamsSchema, request.params)
      const input = parseBody(createConversationMessageRequestSchema, request.body)
      return ok(store.createConversationUserMessage(projectId, conversationId, input))
    } catch (error) {
      const { statusCode, response } = handleRouteError(error)
      return reply.code(statusCode).send(response)
    }
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(fail(apiError("route_not_found", "Route not found")))
  })
}
