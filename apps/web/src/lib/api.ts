"use client";

import {
  apiResponseSchema,
  completeOnboardingResponseSchema,
  createConversationResponseSchema,
  createProjectResponseSchema,
  createProjectResourceResponseSchema,
  getMeResponseSchema,
  getProjectResponseSchema,
  listProjectsResponseSchema,
  pickWorkspaceFolderResponseSchema,
  type ApiError,
  type ApiResponse,
  type CompleteOnboardingRequest,
  type CompleteOnboardingResponse,
  type CreateConversationRequest,
  type CreateConversationResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type CreateProjectResourceResponse,
  type GetMeResponse,
  type GetProjectResponse,
  type ListProjectsResponse,
  type PickWorkspaceFolderRequest,
  type PickWorkspaceFolderResponse,
} from "@socrates/contracts";
import type { z } from "zod";

const directApiBaseUrl = process.env.NEXT_PUBLIC_SOCRATES_API_BASE_URL ?? "http://127.0.0.1:4000";

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
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
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

  createConversation: (projectId: string, input: CreateConversationRequest) =>
    request<typeof createConversationResponseSchema>(
      `/api/projects/${projectId}/conversations`,
      createConversationResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<CreateConversationResponse>,

  uploadProjectResource: (projectId: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    return uploadRequest(
      `/api/projects/${projectId}/resources/upload`,
      createProjectResourceResponseSchema,
      body,
    ) as Promise<CreateProjectResourceResponse>;
  },
};

export type { GetMeResponse };
