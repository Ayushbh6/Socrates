"use client";

import {
  apiResponseSchema,
  completeOnboardingResponseSchema,
  createConversationMessageResponseSchema,
  createConversationResponseSchema,
  createProjectResponseSchema,
  deleteConversationResponseSchema,
  getMeResponseSchema,
  getConversationResponseSchema,
  getProjectResponseSchema,
  listProjectsResponseSchema,
  listModelsHttpResponseSchema,
  listProjectConversationsResponseSchema,
  pickWorkspaceFolderResponseSchema,
  uploadProjectResourcesResponseSchema,
  updateConversationResponseSchema,
  upsertProjectInstructionsResponseSchema,
  type ApiError,
  type ApiResponse,
  type CompleteOnboardingRequest,
  type CompleteOnboardingResponse,
  type CreateConversationMessageRequest,
  type CreateConversationMessageResponse,
  type CreateConversationRequest,
  type CreateConversationResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type DeleteConversationResponse,
  type GetConversationResponse,
  type GetMeResponse,
  type GetProjectResponse,
  type ListProjectsResponse,
  type ListModelsHttpResponse,
  type ListProjectConversationsResponse,
  type PickWorkspaceFolderRequest,
  type PickWorkspaceFolderResponse,
  type UpdateConversationRequest,
  type UpdateConversationResponse,
  type UploadProjectResourcesResponse,
  type UpsertProjectInstructionsRequest,
  type UpsertProjectInstructionsResponse,
} from "@socrates/contracts";
import type { z } from "zod";

const directApiBaseUrl = process.env.NEXT_PUBLIC_SOCRATES_API_BASE_URL ?? "http://127.0.0.1:4000";

export const socratesApiBaseUrl = directApiBaseUrl;

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const fallback = text.trim() || `${response.status} ${response.statusText}`;
    throw new Error(fallback);
  }
}

export class ApiClientError extends Error {
  readonly error: ApiError;

  constructor(error: ApiError) {
    super(error.message);
    this.name = "ApiClientError";
    this.error = error;
  }
}

async function request<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  init: RequestInit = {},
): Promise<z.infer<TSchema>> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
  });
  const json = await readJsonResponse(response);
  const parsed = apiResponseSchema(schema).parse(json) as ApiResponse<z.infer<TSchema>>;

  if (!parsed.ok) {
    throw new ApiClientError(parsed.error);
  }

  return parsed.data;
}

async function uploadRequest<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  body: FormData,
): Promise<z.infer<TSchema>> {
  const response = await fetch(path, {
    method: "POST",
    body,
    cache: "no-store",
  });
  const json = await readJsonResponse(response);
  const parsed = apiResponseSchema(schema).parse(json) as ApiResponse<z.infer<TSchema>>;

  if (!parsed.ok) {
    throw new ApiClientError(parsed.error);
  }

  return parsed.data;
}

export const api = {
  getMe: () => request<typeof getMeResponseSchema>("/api/me", getMeResponseSchema),

  listModels: () =>
    request<typeof listModelsHttpResponseSchema>("/api/models", listModelsHttpResponseSchema) as Promise<ListModelsHttpResponse>,

  completeOnboarding: (input: CompleteOnboardingRequest) =>
    request<typeof completeOnboardingResponseSchema>("/api/onboarding", completeOnboardingResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    }) as Promise<CompleteOnboardingResponse>,

  listProjects: () =>
    request<typeof listProjectsResponseSchema>("/api/projects", listProjectsResponseSchema) as Promise<ListProjectsResponse>,

  createProject: (input: CreateProjectRequest) =>
    request<typeof createProjectResponseSchema>("/api/projects", createProjectResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    }) as Promise<CreateProjectResponse>,

  pickWorkspaceFolder: (input: PickWorkspaceFolderRequest) =>
    request<typeof pickWorkspaceFolderResponseSchema>(
      `${directApiBaseUrl}/api/workspaces/pick-folder`,
      pickWorkspaceFolderResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<PickWorkspaceFolderResponse>,

  getProject: (projectId: string) =>
    request<typeof getProjectResponseSchema>(`/api/projects/${projectId}`, getProjectResponseSchema) as Promise<GetProjectResponse>,

  listProjectConversations: (projectId: string) =>
    request<typeof listProjectConversationsResponseSchema>(
      `/api/projects/${projectId}/conversations`,
      listProjectConversationsResponseSchema,
    ) as Promise<ListProjectConversationsResponse>,

  createConversation: (projectId: string, input: CreateConversationRequest) =>
    request<typeof createConversationResponseSchema>(
      `/api/projects/${projectId}/conversations`,
      createConversationResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<CreateConversationResponse>,

  getConversation: (projectId: string, conversationId: string) =>
    request<typeof getConversationResponseSchema>(
      `/api/projects/${projectId}/conversations/${conversationId}`,
      getConversationResponseSchema,
    ) as Promise<GetConversationResponse>,

  updateConversation: (projectId: string, conversationId: string, input: UpdateConversationRequest) =>
    request<typeof updateConversationResponseSchema>(
      `/api/projects/${projectId}/conversations/${conversationId}`,
      updateConversationResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ) as Promise<UpdateConversationResponse>,

  deleteConversation: (projectId: string, conversationId: string) =>
    request<typeof deleteConversationResponseSchema>(
      `/api/projects/${projectId}/conversations/${conversationId}`,
      deleteConversationResponseSchema,
      {
        method: "DELETE",
      },
    ) as Promise<DeleteConversationResponse>,

  createConversationMessage: (projectId: string, conversationId: string, input: CreateConversationMessageRequest) =>
    request<typeof createConversationMessageResponseSchema>(
      `/api/projects/${projectId}/conversations/${conversationId}/messages`,
      createConversationMessageResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<CreateConversationMessageResponse>,

  upsertProjectInstructions: (projectId: string, input: UpsertProjectInstructionsRequest) =>
    request<typeof upsertProjectInstructionsResponseSchema>(
      `/api/projects/${projectId}/instructions`,
      upsertProjectInstructionsResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    ) as Promise<UpsertProjectInstructionsResponse>,

  uploadProjectResources: (projectId: string, files: File[]) => {
    const body = new FormData();
    for (const file of files) {
      body.append("files", file);
    }
    return uploadRequest(
      `/api/projects/${projectId}/resources/upload`,
      uploadProjectResourcesResponseSchema,
      body,
    ) as Promise<UploadProjectResourcesResponse>;
  },
};

export type { GetMeResponse };
