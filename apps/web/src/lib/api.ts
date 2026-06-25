"use client";

import {
  apiResponseSchema,
  buildGlobalSkillResponseSchema,
  buildProjectSkillResponseSchema,
  checkProjectEmbeddingsResponseSchema,
  checkProviderCredentialResponseSchema,
  checkMcpServerResponseSchema,
  completeOnboardingResponseSchema,
  configureProjectEmbeddingsResponseSchema,
  createConversationMessageResponseSchema,
  createConversationResponseSchema,
  createProjectResponseSchema,
  deleteConversationResponseSchema,
  deleteMcpServerResponseSchema,
  deleteProviderCredentialResponseSchema,
  deleteProjectResourceResponseSchema,
  getMeResponseSchema,
  getConversationResponseSchema,
  getMemoryAgentFileContentResponseSchema,
  getMemoryAgentResponseSchema,
  getMemoryAgentRunResponseSchema,
  getProjectEmbeddingsStatusResponseSchema,
  getProviderCredentialsStatusResponseSchema,
  getProjectResponseSchema,
  inspectWorkspaceResponseSchema,
  listNotificationsResponseSchema,
  listMemoryAgentFilesResponseSchema,
  listMemoryAgentRunsResponseSchema,
  listMcpServersResponseSchema,
  listProjectsResponseSchema,
  listModelsHttpResponseSchema,
  listProjectConversationsResponseSchema,
  markAllNotificationsReadResponseSchema,
  markNotificationReadResponseSchema,
  pickWorkspaceFolderResponseSchema,
  reindexProjectEmbeddingsResponseSchema,
  setProviderCredentialSessionResponseSchema,
  updateMemoryAgentGlobalSettingsResponseSchema,
  updateMcpServerResponseSchema,
  triggerMemoryAgentRunResponseSchema,
  uploadProjectResourcesResponseSchema,
  updateProjectWorkspaceResponseSchema,
  updateConversationResponseSchema,
  uploadConversationAttachmentsResponseSchema,
  upsertMcpServerResponseSchema,
  upsertProjectInstructionsResponseSchema,
  type ApiError,
  type ApiResponse,
  type BuildGlobalSkillRequest,
  type BuildGlobalSkillResponse,
  type BuildProjectSkillRequest,
  type BuildProjectSkillResponse,
  type CheckProjectEmbeddingsRequest,
  type CheckProjectEmbeddingsResponse,
  type CheckMcpServerRequest,
  type CheckMcpServerResponse,
  type CheckProviderCredentialRequest,
  type CheckProviderCredentialResponse,
  type CompleteOnboardingRequest,
  type CompleteOnboardingResponse,
  type ConfigureProjectEmbeddingsRequest,
  type ConfigureProjectEmbeddingsResponse,
  type CreateConversationMessageRequest,
  type CreateConversationMessageResponse,
  type CreateConversationRequest,
  type CreateConversationResponse,
  type CreateProjectRequest,
  type CreateProjectResponse,
  type DeleteConversationResponse,
  type DeleteMcpServerRequest,
  type DeleteMcpServerResponse,
  type DeleteProviderCredentialResponse,
  type DeleteProjectResourceResponse,
  type GetConversationResponse,
  type GetMemoryAgentFileContentResponse,
  type GetMemoryAgentResponse,
  type GetMemoryAgentRunResponse,
  type GetMeResponse,
  type GetProjectEmbeddingsStatusResponse,
  type GetProjectResponse,
  type GetProviderCredentialsStatusResponse,
  type InspectWorkspaceRequest,
  type InspectWorkspaceResponse,
  type ListNotificationsResponse,
  type ListMemoryAgentFilesResponse,
  type ListMemoryAgentRunsResponse,
  type ListMcpServersResponse,
  type ListProjectsResponse,
  type MarkAllNotificationsReadResponse,
  type MarkNotificationReadResponse,
  type ListModelsHttpResponse,
  type ListProjectConversationsResponse,
  type PickWorkspaceFolderRequest,
  type PickWorkspaceFolderResponse,
  type ReindexProjectEmbeddingsResponse,
  type SetProviderCredentialSessionRequest,
  type SetProviderCredentialSessionResponse,
  type UpdateMemoryAgentGlobalSettingsRequest,
  type UpdateMemoryAgentGlobalSettingsResponse,
  type UpdateMcpServerRequest,
  type UpdateMcpServerResponse,
  type TriggerMemoryAgentRunResponse,
  type UpdateProjectWorkspaceRequest,
  type UpdateProjectWorkspaceResponse,
  type UpdateConversationRequest,
  type UpdateConversationResponse,
  type UploadConversationAttachmentsResponse,
  type UploadProjectResourcesResponse,
  type UpsertMcpServerRequest,
  type UpsertMcpServerResponse,
  type UpsertProjectInstructionsRequest,
  type UpsertProjectInstructionsResponse,
} from "@socrates/contracts";
import type { z } from "zod";

declare global {
  interface Window {
    __SOCRATES_CONFIG__?: {
      apiBaseUrl?: string;
    };
  }
}

const directApiBaseUrl = process.env.NEXT_PUBLIC_SOCRATES_API_BASE_URL ?? "http://127.0.0.1:4000";

export const socratesApiBaseUrl = (): string => {
  if (typeof window !== "undefined") {
    return window.__SOCRATES_CONFIG__?.apiBaseUrl ?? directApiBaseUrl;
  }
  return directApiBaseUrl;
};

const apiUrl = (path: string): string => {
  if (/^https?:\/\//.test(path)) {
    return path;
  }
  if (path.startsWith("/api/")) {
    return `${socratesApiBaseUrl()}${path}`;
  }
  return path;
};

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

  const response = await fetch(apiUrl(path), {
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
  const response = await fetch(apiUrl(path), {
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

  listNotifications: (input: { unreadOnly?: boolean; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (input.unreadOnly !== undefined) {
      params.set("unreadOnly", input.unreadOnly ? "true" : "false");
    }
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    const query = params.toString();
    return request<typeof listNotificationsResponseSchema>(
      `/api/notifications${query ? `?${query}` : ""}`,
      listNotificationsResponseSchema,
    ) as Promise<ListNotificationsResponse>;
  },

  markNotificationRead: (notificationId: string) =>
    request<typeof markNotificationReadResponseSchema>(
      `/api/notifications/${encodeURIComponent(notificationId)}/read`,
      markNotificationReadResponseSchema,
      { method: "POST" },
    ) as Promise<MarkNotificationReadResponse>,

  markAllNotificationsRead: () =>
    request<typeof markAllNotificationsReadResponseSchema>(
      "/api/notifications/read-all",
      markAllNotificationsReadResponseSchema,
      { method: "POST" },
    ) as Promise<MarkAllNotificationsReadResponse>,

  getProviderCredentialStatus: () =>
    request<typeof getProviderCredentialsStatusResponseSchema>(
      "/api/provider-credentials/status",
      getProviderCredentialsStatusResponseSchema,
    ) as Promise<GetProviderCredentialsStatusResponse>,

  checkProviderCredential: (input: CheckProviderCredentialRequest) =>
    request<typeof checkProviderCredentialResponseSchema>(
      "/api/provider-credentials/check",
      checkProviderCredentialResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<CheckProviderCredentialResponse>,

  setProviderCredentialSession: (input: SetProviderCredentialSessionRequest) =>
    request<typeof setProviderCredentialSessionResponseSchema>(
      "/api/provider-credentials/session",
      setProviderCredentialSessionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<SetProviderCredentialSessionResponse>,

  deleteProviderCredentialSession: (providerId: string) =>
    request<typeof deleteProviderCredentialResponseSchema>(
      `/api/provider-credentials/${providerId}`,
      deleteProviderCredentialResponseSchema,
      {
        method: "DELETE",
      },
    ) as Promise<DeleteProviderCredentialResponse>,

  getMemoryAgent: () =>
    request<typeof getMemoryAgentResponseSchema>("/api/memory-agent", getMemoryAgentResponseSchema) as Promise<GetMemoryAgentResponse>,

  listMemoryAgentRuns: (input: { limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    if (input.offset !== undefined) {
      params.set("offset", String(input.offset));
    }
    const query = params.toString();
    return request<typeof listMemoryAgentRunsResponseSchema>(
      `/api/memory-agent/runs${query ? `?${query}` : ""}`,
      listMemoryAgentRunsResponseSchema,
    ) as Promise<ListMemoryAgentRunsResponse>;
  },

  getMemoryAgentRun: (runId: string) =>
    request<typeof getMemoryAgentRunResponseSchema>(
      `/api/memory-agent/runs/${encodeURIComponent(runId)}`,
      getMemoryAgentRunResponseSchema,
    ) as Promise<GetMemoryAgentRunResponse>,

  listMemoryAgentFiles: () =>
    request<typeof listMemoryAgentFilesResponseSchema>(
      "/api/memory-agent/files",
      listMemoryAgentFilesResponseSchema,
    ) as Promise<ListMemoryAgentFilesResponse>,

  getMemoryAgentFileContent: (input: { kind: string; path: string; scope?: string }) => {
    const params = new URLSearchParams();
    params.set("kind", input.kind);
    params.set("path", input.path);
    if (input.scope) {
      params.set("scope", input.scope);
    }
    return request<typeof getMemoryAgentFileContentResponseSchema>(
      `/api/memory-agent/files/content?${params.toString()}`,
      getMemoryAgentFileContentResponseSchema,
    ) as Promise<GetMemoryAgentFileContentResponse>;
  },

  updateMemoryAgentSettings: (input: UpdateMemoryAgentGlobalSettingsRequest) =>
    request<typeof updateMemoryAgentGlobalSettingsResponseSchema>(
      "/api/memory-agent/settings",
      updateMemoryAgentGlobalSettingsResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ) as Promise<UpdateMemoryAgentGlobalSettingsResponse>,

  runMemoryAgent: () =>
    request<typeof triggerMemoryAgentRunResponseSchema>("/api/memory-agent/run", triggerMemoryAgentRunResponseSchema, {
      method: "POST",
    }) as Promise<TriggerMemoryAgentRunResponse>,

  buildGlobalSkill: (input: BuildGlobalSkillRequest) =>
    request<typeof buildGlobalSkillResponseSchema>(
      "/api/memory-agent/skills/build",
      buildGlobalSkillResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<BuildGlobalSkillResponse>,

  listMcpServers: (input: { projectId?: string; scope?: "global" | "project" } = {}) => {
    const params = new URLSearchParams();
    if (input.projectId) {
      params.set("projectId", input.projectId);
    }
    if (input.scope) {
      params.set("scope", input.scope);
    }
    const query = params.toString();
    return request<typeof listMcpServersResponseSchema>(
      `/api/mcp${query ? `?${query}` : ""}`,
      listMcpServersResponseSchema,
    ) as Promise<ListMcpServersResponse>;
  },

  upsertMcpServer: (input: UpsertMcpServerRequest) =>
    request<typeof upsertMcpServerResponseSchema>("/api/mcp/servers", upsertMcpServerResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    }) as Promise<UpsertMcpServerResponse>,

  updateMcpServer: (serverId: string, input: UpdateMcpServerRequest) =>
    request<typeof updateMcpServerResponseSchema>(
      `/api/mcp/servers/${encodeURIComponent(serverId)}`,
      updateMcpServerResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ) as Promise<UpdateMcpServerResponse>,

  deleteMcpServer: (serverId: string, input: DeleteMcpServerRequest) =>
    request<typeof deleteMcpServerResponseSchema>(
      `/api/mcp/servers/${encodeURIComponent(serverId)}`,
      deleteMcpServerResponseSchema,
      {
        method: "DELETE",
        body: JSON.stringify(input),
      },
    ) as Promise<DeleteMcpServerResponse>,

  checkMcpServer: (serverId: string, input: CheckMcpServerRequest) =>
    request<typeof checkMcpServerResponseSchema>(
      `/api/mcp/servers/${encodeURIComponent(serverId)}/check`,
      checkMcpServerResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<CheckMcpServerResponse>,

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
      `${socratesApiBaseUrl()}/api/workspaces/pick-folder`,
      pickWorkspaceFolderResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<PickWorkspaceFolderResponse>,

  inspectWorkspace: (input: InspectWorkspaceRequest) =>
    request<typeof inspectWorkspaceResponseSchema>(
      `${socratesApiBaseUrl()}/api/workspaces/inspect`,
      inspectWorkspaceResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<InspectWorkspaceResponse>,

  getProject: (projectId: string) =>
    request<typeof getProjectResponseSchema>(`/api/projects/${projectId}`, getProjectResponseSchema) as Promise<GetProjectResponse>,

  updateProjectWorkspace: (projectId: string, input: UpdateProjectWorkspaceRequest) =>
    request<typeof updateProjectWorkspaceResponseSchema>(
      `/api/projects/${projectId}/workspace`,
      updateProjectWorkspaceResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ) as Promise<UpdateProjectWorkspaceResponse>,

  getProjectEmbeddingStatus: (projectId: string) =>
    request<typeof getProjectEmbeddingsStatusResponseSchema>(
      `/api/projects/${projectId}/embeddings/status`,
      getProjectEmbeddingsStatusResponseSchema,
    ) as Promise<GetProjectEmbeddingsStatusResponse>,

  checkProjectEmbeddings: (projectId: string, input: CheckProjectEmbeddingsRequest) =>
    request<typeof checkProjectEmbeddingsResponseSchema>(
      `/api/projects/${projectId}/embeddings/check`,
      checkProjectEmbeddingsResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<CheckProjectEmbeddingsResponse>,

  configureProjectEmbeddings: (projectId: string, input: ConfigureProjectEmbeddingsRequest) =>
    request<typeof configureProjectEmbeddingsResponseSchema>(
      `/api/projects/${projectId}/embeddings/configure`,
      configureProjectEmbeddingsResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<ConfigureProjectEmbeddingsResponse>,

  reindexProjectEmbeddings: (projectId: string) =>
    request<typeof reindexProjectEmbeddingsResponseSchema>(
      `/api/projects/${projectId}/embeddings/reindex`,
      reindexProjectEmbeddingsResponseSchema,
      {
        method: "POST",
      },
    ) as Promise<ReindexProjectEmbeddingsResponse>,

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

  uploadConversationAttachments: (projectId: string, conversationId: string, files: File[]) => {
    const body = new FormData();
    for (const file of files) {
      body.append("files", file);
    }
    return uploadRequest(
      `/api/projects/${projectId}/conversations/${conversationId}/attachments/upload`,
      uploadConversationAttachmentsResponseSchema,
      body,
    ) as Promise<UploadConversationAttachmentsResponse>;
  },

  upsertProjectInstructions: (projectId: string, input: UpsertProjectInstructionsRequest) =>
    request<typeof upsertProjectInstructionsResponseSchema>(
      `/api/projects/${projectId}/instructions`,
      upsertProjectInstructionsResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify(input),
      },
    ) as Promise<UpsertProjectInstructionsResponse>,

  buildProjectSkill: (projectId: string, input: BuildProjectSkillRequest) =>
    request<typeof buildProjectSkillResponseSchema>(
      `/api/projects/${projectId}/skills/build`,
      buildProjectSkillResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ) as Promise<BuildProjectSkillResponse>,

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

  deleteProjectResource: (projectId: string, resourceId: string) =>
    request<typeof deleteProjectResourceResponseSchema>(
      `/api/projects/${projectId}/resources/${resourceId}`,
      deleteProjectResourceResponseSchema,
      {
        method: "DELETE",
      },
    ) as Promise<DeleteProjectResourceResponse>,
};

export type { GetMeResponse };
