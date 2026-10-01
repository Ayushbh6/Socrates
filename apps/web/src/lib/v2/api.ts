"use client";

import { socratesApiBaseUrl } from "../api";
import {
  apiResponseSchema,
  v2ArtifactSchema,
  v2CreateSpeechJobRequestSchema,
  v2CreateSpeechJobResponseSchema,
  v2EnsureFlowResponseSchema,
  v2ListFlowMessagesResponseSchema,
  v2MessageAttachmentSchema,
  v2ServerEventSchema,
  type ApiError,
  type ApiResponse,
  type V2Artifact,
  type V2CreateSpeechJobRequest,
  type V2FlowSnapshot,
  type V2Message,
  type V2MessageAttachment,
  type V2MessageWindow,
  type V2ServerEvent,
  type V2SpeechJob,
} from "@socrates/contracts";
import { z } from "zod";

const attachmentUploadResponseSchema = z
  .object({ attachments: z.array(v2MessageAttachmentSchema) })
  .strict();
const speechArtifactResponseSchema = z.object({ artifact: v2ArtifactSchema }).strict();
const v2CapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    product: z.literal("socrates_flow"),
    contractVersion: z.literal(2),
    speech: z
      .object({
        localStt: z.array(z.string()),
        hostedStt: z.array(z.string()),
        localTts: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
const v2ContextStateSchema = z
  .object({
    evidence: z.array(z.object({
      ref: z.object({
        evidenceId: z.string(),
        flowId: z.string(),
        sourceType: z.string(),
        sourceLocator: z.string(),
        contentHash: z.string(),
        capturedAt: z.string(),
      }).strict(),
      exactContent: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }).strict()),
    items: z.array(z.object({
      id: z.string(),
      flowId: z.string(),
      goalId: z.string().optional(),
      evidenceRef: z.object({
        evidenceId: z.string(),
        flowId: z.string(),
        sourceType: z.string(),
        sourceLocator: z.string(),
        contentHash: z.string(),
        capturedAt: z.string(),
      }).strict(),
      disposition: z.enum(["keep_exact", "distill", "release", "unresolved"]),
      representation: z.enum(["exact", "distilled"]),
      distilledText: z.string().optional(),
      tokenEstimate: z.number().int().nonnegative().optional(),
      active: z.boolean(),
      priority: z.number(),
      createdAtCompletedTurn: z.number().int().nonnegative(),
      decidedAtCompletedTurn: z.number().int().nonnegative(),
      unresolvedSinceCompletedTurn: z.number().int().nonnegative().optional(),
      reviewDueAtCompletedTurn: z.number().int().nonnegative().optional(),
    }).strict()),
  })
  .strict();
const v2ContextCountsSchema = z
  .object({
    immutableEvidenceCount: z.number().int().nonnegative(),
    activeItemCount: z.number().int().nonnegative(),
    releasedItemCount: z.number().int().nonnegative(),
  })
  .strict();
const v2ContextResponseSchema = z
  .object({ state: v2ContextStateSchema, counts: v2ContextCountsSchema })
  .strict();
const v2RuntimeEventSchema = z
  .object({
    id: z.string(),
    flowId: z.string(),
    projectId: z.string(),
    goalId: z.string().optional(),
    turnId: z.string().optional(),
    sequence: z.number().int().positive(),
    type: z.string(),
    source: z.string(),
    payload: z.unknown(),
    createdAt: z.string(),
  })
  .strict();
const v2RuntimeEventsResponseSchema = z
  .object({
    events: z.array(v2RuntimeEventSchema),
    nextSequence: z.number().int().nonnegative(),
  })
  .strict();
const v2OpenClassicResponseSchema = z.object({
  bridge: z.object({
    id: z.string(),
    conversationId: z.string(),
    sessionId: z.string(),
    activeOwner: z.literal("classic"),
  }).strict(),
  href: z.string(),
}).strict();
const v2ContinueClassicResponseSchema = z.object({ snapshot: v2EnsureFlowResponseSchema.shape.snapshot, href: z.string() }).strict();

export type V2Capabilities = z.infer<typeof v2CapabilitiesSchema>;
export type V2ClientContextState = z.infer<typeof v2ContextStateSchema> & Readonly<{
  counts: z.infer<typeof v2ContextCountsSchema>;
}>;
export type V2ClientMessagePage = Readonly<{
  messages: V2Message[];
  messageWindow: V2MessageWindow;
}>;

export class V2ApiError extends Error {
  readonly error: ApiError;

  constructor(error: ApiError) {
    super(error.message);
    this.name = "V2ApiError";
    this.error = error;
  }
}

const apiUrl = (path: string): string => `${socratesApiBaseUrl()}${path}`;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(text.trim() || `${response.status} ${response.statusText}`);
  }
}

async function request<TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  init: RequestInit = {},
): Promise<z.infer<TSchema>> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(apiUrl(path), { ...init, headers, cache: "no-store" });
  const payload = await readJson(response);
  const result = apiResponseSchema(schema).safeParse(payload);
  if (!result.success) {
    const serverMessage = payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
      ? payload.message
      : `Socrates returned an invalid V2 response (${response.status}).`;
    throw new Error(serverMessage);
  }
  const parsed = result.data as ApiResponse<z.infer<TSchema>>;
  if (!parsed.ok) {
    throw new V2ApiError(parsed.error);
  }
  return parsed.data;
}

async function requestBlob(path: string): Promise<Blob> {
  const response = await fetch(apiUrl(path), { cache: "no-store" });
  if (response.ok) {
    return response.blob();
  }
  const payload = apiResponseSchema(z.unknown()).safeParse(await readJson(response));
  if (payload.success && !payload.data.ok) {
    throw new V2ApiError(payload.data.error);
  }
  throw new Error(`${response.status} ${response.statusText}`);
}

const flowPath = (projectId: string): string =>
  `/api/v2/projects/${encodeURIComponent(projectId)}/flow`;

const scopedFlowPath = (projectId: string, flowId: string): string =>
  `/api/v2/projects/${encodeURIComponent(projectId)}/flows/${encodeURIComponent(flowId)}`;

export const v2Api = {
  getCapabilities: (): Promise<V2Capabilities> =>
    request("/api/v2/capabilities", v2CapabilitiesSchema),

  getFlow: async (projectId: string): Promise<V2FlowSnapshot> => {
    const data = await request(flowPath(projectId), v2EnsureFlowResponseSchema);
    return data.snapshot;
  },

  ensureFlow: async (projectId: string): Promise<V2FlowSnapshot> => {
    const data = await request(flowPath(projectId), v2EnsureFlowResponseSchema, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return data.snapshot;
  },

  getContext: async (projectId: string, flowId: string): Promise<V2ClientContextState> => {
    const data = await request(`${scopedFlowPath(projectId, flowId)}/context`, v2ContextResponseSchema);
    return { ...data.state, counts: data.counts };
  },

  openFocusInClassic: (projectId: string, flowId: string, goalId: string) =>
    request(
      `${scopedFlowPath(projectId, flowId)}/goals/${encodeURIComponent(goalId)}/open-in-classic`,
      v2OpenClassicResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    ),

  continueClassicInSeamless: (projectId: string, conversationId: string) =>
    request(
      `/api/v2/projects/${encodeURIComponent(projectId)}/bridge/classic/${encodeURIComponent(conversationId)}/continue`,
      v2ContinueClassicResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    ),

  listMessages: async (
    projectId: string,
    flowId: string,
    beforeOrdinal: number,
    limit = 100,
  ): Promise<V2ClientMessagePage> => {
    const query = new URLSearchParams({ beforeOrdinal: String(beforeOrdinal), limit: String(limit) });
    return request(
      `${scopedFlowPath(projectId, flowId)}/messages?${query.toString()}`,
      v2ListFlowMessagesResponseSchema,
    );
  },

  getRecentEvents: async (
    projectId: string,
    flowId: string,
    afterSequence: number,
    limit = 500,
  ): Promise<V2ServerEvent[]> => {
    const query = new URLSearchParams({ afterSequence: String(afterSequence), limit: String(limit) });
    const data = await request(
      `${scopedFlowPath(projectId, flowId)}/events?${query.toString()}`,
      v2RuntimeEventsResponseSchema,
    );
    return data.events.flatMap((event) => {
      const parsed = v2ServerEventSchema.safeParse({
        id: event.id,
        schemaVersion: 2,
        timestamp: event.createdAt,
        projectId: event.projectId,
        flowId: event.flowId,
        ...(event.goalId ? { goalId: event.goalId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
        type: event.type,
        payload: event.payload,
      });
      return parsed.success ? [parsed.data] : [];
    });
  },

  uploadAttachments: async (
    projectId: string,
    flowId: string,
    files: File[],
  ): Promise<V2MessageAttachment[]> => {
    const body = new FormData();
    for (const file of files) {
      body.append("files", file, file.name);
    }
    const data = await request(
      `${scopedFlowPath(projectId, flowId)}/attachments/upload`,
      attachmentUploadResponseSchema,
      { method: "POST", body },
    );
    return data.attachments;
  },

  attachmentContentUrl: (projectId: string, flowId: string, attachmentId: string): string =>
    apiUrl(`${scopedFlowPath(projectId, flowId)}/attachments/${encodeURIComponent(attachmentId)}/content`),

  uploadSpeechArtifact: async (
    projectId: string,
    flowId: string,
    recording: Blob,
    fileName = "recording.wav",
  ): Promise<V2Artifact> => {
    const body = new FormData();
    body.append("file", recording, fileName);
    const data = await request(
      `${scopedFlowPath(projectId, flowId)}/speech/artifacts`,
      speechArtifactResponseSchema,
      { method: "POST", body },
    );
    return data.artifact;
  },

  createSpeechJob: async (
    projectId: string,
    flowId: string,
    input: V2CreateSpeechJobRequest,
  ): Promise<V2SpeechJob> => {
    const body = v2CreateSpeechJobRequestSchema.parse(input);
    const data = await request(
      `${scopedFlowPath(projectId, flowId)}/speech/jobs`,
      v2CreateSpeechJobResponseSchema,
      { method: "POST", body: JSON.stringify(body) },
    );
    return data.job;
  },

  speechArtifactContent: (projectId: string, flowId: string, artifactId: string): Promise<Blob> =>
    requestBlob(`${scopedFlowPath(projectId, flowId)}/speech/artifacts/${encodeURIComponent(artifactId)}/content`),
};
