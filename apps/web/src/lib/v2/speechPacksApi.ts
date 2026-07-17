"use client";

import { socratesApiBaseUrl } from "../api";
import { apiResponseSchema, type ApiError, type ApiResponse } from "@socrates/contracts";
import { z } from "zod";

export const V2_SPEECH_PACK_IDS = [
  "whisper-base.en",
  "whisper-small.en",
  "kokoro-en-v0_19",
] as const;

export const v2SpeechPackIdSchema = z.enum(V2_SPEECH_PACK_IDS);
export type V2SpeechPackId = z.infer<typeof v2SpeechPackIdSchema>;

export const v2SpeechPackSchema = z
  .object({
    id: v2SpeechPackIdSchema,
    installed: z.boolean(),
    verified: z.boolean(),
    path: z.string(),
  })
  .strict();

const v2SpeechPackListResponseSchema = z
  .object({ packs: z.array(v2SpeechPackSchema) })
  .strict();
const v2SpeechPackResponseSchema = z.object({ pack: v2SpeechPackSchema }).strict();
const v2SpeechPackRemoveResponseSchema = z
  .object({ removedPackId: v2SpeechPackIdSchema, pack: v2SpeechPackSchema })
  .strict();

export type V2SpeechPack = z.infer<typeof v2SpeechPackSchema>;

export const V2_SPEECH_PACK_CATALOG = {
  "whisper-base.en": {
    name: "Whisper base.en",
    shortName: "Base",
    purpose: "Speech to text",
    description: "Fast English transcription with the lightest local footprint.",
    sizeBytes: 147_964_211,
    modelId: "base.en",
  },
  "whisper-small.en": {
    name: "Whisper small.en",
    shortName: "Small",
    purpose: "Speech to text",
    description: "More accurate English transcription for stronger local machines.",
    sizeBytes: 487_614_201,
    modelId: "small.en",
  },
  "kokoro-en-v0_19": {
    name: "Kokoro",
    shortName: "Kokoro",
    purpose: "Read aloud",
    description: "Local English voice generation for Socrates responses.",
    sizeBytes: 319_625_534,
    modelId: "kokoro-82m",
  },
} as const satisfies Record<
  V2SpeechPackId,
  {
    name: string;
    shortName: string;
    purpose: "Speech to text" | "Read aloud";
    description: string;
    sizeBytes: number;
    modelId: string;
  }
>;

export class V2SpeechPackApiError extends Error {
  readonly error: ApiError;

  constructor(error: ApiError) {
    super(error.message);
    this.name = "V2SpeechPackApiError";
    this.error = error;
  }
}

const readJson = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(text.trim() || `${response.status} ${response.statusText}`);
  }
};

const request = async <TSchema extends z.ZodTypeAny>(
  path: string,
  schema: TSchema,
  init: RequestInit = {},
): Promise<z.infer<TSchema>> => {
  const response = await fetch(`${socratesApiBaseUrl()}${path}`, {
    ...init,
    cache: "no-store",
  });
  const payload = await readJson(response);
  const parsed = apiResponseSchema(schema).safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Socrates returned an invalid speech-pack response (${response.status}).`);
  }
  const envelope = parsed.data as ApiResponse<z.infer<TSchema>>;
  if (!envelope.ok) throw new V2SpeechPackApiError(envelope.error);
  return envelope.data;
};

const packPath = (packId: V2SpeechPackId): string =>
  `/api/v2/speech/packs/${encodeURIComponent(packId)}`;

export const v2SpeechPacksApi = {
  list: async (signal?: AbortSignal): Promise<V2SpeechPack[]> => {
    const data = await request("/api/v2/speech/packs", v2SpeechPackListResponseSchema, { signal });
    return data.packs;
  },

  install: async (packId: V2SpeechPackId): Promise<V2SpeechPack> => {
    const data = await request(`${packPath(packId)}/install`, v2SpeechPackResponseSchema, { method: "POST" });
    return data.pack;
  },

  remove: async (packId: V2SpeechPackId): Promise<V2SpeechPack> => {
    const data = await request(packPath(packId), v2SpeechPackRemoveResponseSchema, { method: "DELETE" });
    return data.pack;
  },
};
