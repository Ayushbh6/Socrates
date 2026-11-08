import { type CallRecord, ModelError } from "@socrates/contracts";
import { newId } from "@socrates/shared";

/** Speech to text through OpenRouter (architecture/server.md, "Voice"). */
export const TRANSCRIBE_URL = "https://openrouter.ai/api/v1/audio/transcriptions";
/** The default: Mistral's Voxtral Small transcription, about $0.003 a minute. */
export const DEFAULT_TRANSCRIBER = "mistralai/voxtral-small-24b-2507-stt";
/** The other model the user named; any OpenRouter transcription model can be typed in Settings. */
export const TRANSCRIBERS = [DEFAULT_TRANSCRIBER, "meta/muse-voice-transcribe-1.0"] as const;
/** A recording longer than this is refused before it is sent (about 13 minutes of 16 kHz WAV). */
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 90_000;

export interface TranscribeRequest {
  apiKey: string;
  model: string;
  audio: Uint8Array;
  /** The audio's format as OpenRouter names it: "wav", "webm", "mp3", "m4a", "ogg"… */
  format: string;
  /** ISO-639-1, or null to let the model detect it. */
  language: string | null;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export interface Transcript {
  text: string;
  /** Seconds of audio, as the provider counted them. */
  seconds: number | null;
  costUsd: number | null;
  model: string;
}

/** Send one recording and return what was said. Errors are ModelErrors, worded for the person speaking. */
export async function transcribe(req: TranscribeRequest): Promise<Transcript> {
  const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await (req.fetch ?? fetch)(TRANSCRIBE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${req.apiKey}`, "content-type": "application/json", "x-title": "Socrates" },
      body: JSON.stringify({
        model: req.model,
        input_audio: { data: Buffer.from(req.audio).toString("base64"), format: req.format },
        ...(req.language ? { language: req.language } : {}),
      }),
      signal,
    });
  } catch (error) {
    if (req.signal?.aborted) throw new ModelError("The transcription was stopped.", "aborted");
    throw new ModelError(`Could not reach OpenRouter to transcribe: ${error instanceof Error ? error.message : String(error)}`, "network");
  }
  const raw = await response.text();
  let body: { text?: unknown; usage?: { cost?: unknown; seconds?: unknown }; error?: { message?: unknown } } = {};
  try { body = JSON.parse(raw) as typeof body; } catch { /* reported below */ }
  if (!response.ok) {
    const said = typeof body.error?.message === "string" ? body.error.message : raw.slice(0, 300);
    const kind = response.status === 401 || response.status === 403 ? "authentication" : response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "invalid_request";
    throw new ModelError(`OpenRouter could not transcribe (${response.status}): ${said}`, kind, response.status);
  }
  if (typeof body.text !== "string") throw new ModelError("OpenRouter sent no transcript.", "server", response.status);
  const cost = body.usage?.cost;
  const seconds = body.usage?.seconds;
  return {
    text: body.text.trim(),
    seconds: typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null,
    costUsd: typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : null,
    model: req.model,
  };
}

/**
 * One transcription as a call of role "transcription" for calls.db
 * (architecture/observability.md): the audio's size and format as the
 * request (never the audio), the transcript as the reply, the cost reported.
 */
export function transcriptionRecord(req: Omit<TranscribeRequest, "apiKey">, startedAt: string, ms: number, result: Transcript | null, error: unknown): CallRecord {
  return {
    id: newId("call"),
    startedAt,
    model: `openrouter:${req.model}`,
    servedBy: result ? req.model : null,
    trace: { role: "transcription" },
    streamed: false,
    request: {
      system: "",
      messages: [{ role: "user", content: `[audio: ${req.format}, ${Math.round(req.audio.byteLength / 1024)} kB${req.language ? `, language ${req.language}` : ""}]` }],
      tools: [], toolChoice: "auto", maxOutputTokens: null, temperature: null, effort: null,
    },
    response: result && {
      text: result.text,
      toolCalls: [], reasoning: null, stopReason: "end",
      usage: { promptTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      meta: { seconds: result.seconds, ...(result.costUsd !== null ? { usage: { cost: result.costUsd } } : {}) },
    },
    error: error === null ? null : {
      kind: error instanceof ModelError ? error.kind : "unexpected",
      status: error instanceof ModelError ? error.status ?? null : null,
      message: error instanceof Error ? error.message : String(error),
    },
    ms, firstTokenMs: null, tokensPerSecond: null, cost: null,
  };
}
