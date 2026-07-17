export const V2_STORAGE_KEYS = {
  lastSelectedView: "socrates:last-selected-view:v2",
  inspectorCollapsed: "socrates:seamless:inspector-collapsed:v2",
  projectRailCollapsed: "socrates:seamless:project-rail-collapsed:v2",
  composerModel: "socrates:seamless:composer-model:v2",
  composerThinking: "socrates:seamless:composer-thinking:v2",
  speechTranscriber: "socrates:seamless:speech-transcriber:v2",
  speechVoice: "socrates:seamless:speech-voice:v2",
} as const;

export type SocratesViewMode = "classic" | "seamless";
