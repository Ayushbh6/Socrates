"use client";

export const SPEECH_TRANSCRIBER_OPTIONS = [
  {
    id: "disabled",
    label: "Not configured",
    description: "Choose a hosted transcriber or explicitly install an offline model before using the microphone.",
  },
  {
    id: "local_whisper:base.en",
    label: "Whisper base.en · Offline",
    description: "Runs locally after you explicitly install the 141 MB model pack.",
    engine: "local_whisper",
    modelId: "base.en",
  },
  {
    id: "local_whisper:small.en",
    label: "Whisper small.en · Offline",
    description: "Runs locally after you explicitly install the 465 MB model pack.",
    engine: "local_whisper",
    modelId: "small.en",
  },
  {
    id: "openrouter:nvidia/parakeet-tdt-0.6b-v3",
    label: "Parakeet TDT 0.6B · OpenRouter",
    description: "Sends the recording to OpenRouter using your configured API key.",
    engine: "openrouter",
    modelId: "nvidia/parakeet-tdt-0.6b-v3",
  },
  {
    id: "openrouter:microsoft/mai-transcribe-1.5",
    label: "MAI Transcribe 1.5 · OpenRouter",
    description: "Sends the recording to OpenRouter using your configured API key.",
    engine: "openrouter",
    modelId: "microsoft/mai-transcribe-1.5",
  },
  {
    id: "openrouter:mistralai/voxtral-mini-transcribe",
    label: "Voxtral Mini · OpenRouter",
    description: "Sends the recording to OpenRouter using your configured API key.",
    engine: "openrouter",
    modelId: "mistralai/voxtral-mini-transcribe",
  },
] as const;

export type SpeechTranscriberId = (typeof SPEECH_TRANSCRIBER_OPTIONS)[number]["id"];
export type ConfiguredSpeechTranscriber = Exclude<(typeof SPEECH_TRANSCRIBER_OPTIONS)[number], { id: "disabled" }>;

export const SPEECH_READ_ALOUD_OPTIONS = [
  { id: "disabled", label: "Off", description: "Socrates will not prepare local speech." },
  {
    id: "local_kokoro:kokoro-82m",
    label: "Kokoro 82M · Offline",
    description: "Reads responses locally after you explicitly install the Kokoro pack.",
  },
] as const;

export type SpeechReadAloudId = (typeof SPEECH_READ_ALOUD_OPTIONS)[number]["id"];

const TRANSCRIBER_KEY = "socrates:speech:transcriber:v1";
const READ_ALOUD_KEY = "socrates:speech:read-aloud:v1";
const SPEECH_PREFERENCES_EVENT = "socrates:speech-preferences-changed";

const isTranscriberId = (value: string | null): value is SpeechTranscriberId =>
  SPEECH_TRANSCRIBER_OPTIONS.some((option) => option.id === value);

const isReadAloudId = (value: string | null): value is SpeechReadAloudId =>
  SPEECH_READ_ALOUD_OPTIONS.some((option) => option.id === value);

export const readSpeechTranscriberId = (): SpeechTranscriberId => {
  if (typeof window === "undefined") return "disabled";
  const value = window.localStorage.getItem(TRANSCRIBER_KEY);
  return isTranscriberId(value) ? value : "disabled";
};

export const readSpeechReadAloudId = (): SpeechReadAloudId => {
  if (typeof window === "undefined") return "disabled";
  const value = window.localStorage.getItem(READ_ALOUD_KEY);
  return isReadAloudId(value) ? value : "disabled";
};

const announcePreferenceChange = (): void => {
  window.dispatchEvent(new Event(SPEECH_PREFERENCES_EVENT));
};

export const writeSpeechTranscriberId = (value: SpeechTranscriberId): void => {
  window.localStorage.setItem(TRANSCRIBER_KEY, value);
  announcePreferenceChange();
};

export const writeSpeechReadAloudId = (value: SpeechReadAloudId): void => {
  window.localStorage.setItem(READ_ALOUD_KEY, value);
  announcePreferenceChange();
};

export const subscribeToSpeechPreferences = (listener: () => void): (() => void) => {
  const storageListener = (event: StorageEvent) => {
    if (event.key === TRANSCRIBER_KEY || event.key === READ_ALOUD_KEY) listener();
  };
  window.addEventListener("storage", storageListener);
  window.addEventListener(SPEECH_PREFERENCES_EVENT, listener);
  return () => {
    window.removeEventListener("storage", storageListener);
    window.removeEventListener(SPEECH_PREFERENCES_EVENT, listener);
  };
};

export const configuredTranscriber = (id: SpeechTranscriberId): ConfiguredSpeechTranscriber | null => {
  const option = SPEECH_TRANSCRIBER_OPTIONS.find((candidate) => candidate.id === id);
  return option && option.id !== "disabled" ? option : null;
};
