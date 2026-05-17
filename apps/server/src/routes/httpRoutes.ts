import type { FastifyInstance } from "fastify"
import { z } from "zod"
import {
  completeOnboardingRequestSchema,
  createConversationRequestSchema,
  createProjectRequestSchema,
  createProjectResourceRequestSchema,
  patchProjectRequestSchema,
  pickWorkspaceFolderRequestSchema,
  upsertProjectInstructionsRequestSchema,
} from "@socrates/contracts"
import { SocratesError } from "@socrates/shared"
import { apiError, fail, ok, toApiError } from "../http"
import type { SocratesStore, UploadedResourceInput } from "../services/store"

const projectParamsSchema = z.object({ projectId: z.string().min(1) }).strict()
const conversationParamsSchema = z.object({ projectId: z.string().min(1), conversationId: z.string().min(1) }).strict()

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

const handleRouteError = (error: unknown) => {
  const api = toApiError(error)
  const statusCode =
    api.code === "invalid_request" ||
    api.code === "invalid_route_params" ||
    api.code === "workspace_path_not_absolute" ||
    api.code === "workspace_path_not_directory" ||
    api.code === "resource_file_required" ||
    api.code === "resource_upload_limit_exceeded"
      ? 400
      : api.code.endsWith("_not_found")
        ? 404
        : api.code === "user_not_onboarded" || api.code === "workspace_already_attached"
          ? 409
          : api.code === "folder_picker_cancelled"
            ? 499
          : 500

  return { statusCode, response: fail(api) }
}

export const registerHttpRoutes = async (app: FastifyInstance, store: SocratesStore): Promise<void> => {
  app.get("/health", async () => ok({ status: "ok" }))

  app.get("/api/me", async () => ok({ user: store.getCurrentUser() }))

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

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).send(fail(apiError("route_not_found", "Route not found")))
  })
}
