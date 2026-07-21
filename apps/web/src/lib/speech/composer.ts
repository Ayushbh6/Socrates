export type ComposerVoiceStatus = "idle" | "recording" | "transcribing";

export type ComposerVoicePresentation = Readonly<{
  placeholder: string;
  textareaLabel: string;
  activityLabel?: string;
  microphoneLabel: string;
  microphoneTitle: string;
  inputReadOnly: boolean;
  inputBusy: boolean;
}>;

export const composerVoicePresentation = (
  status: ComposerVoiceStatus,
  selectedStatusLabel?: string,
): ComposerVoicePresentation => {
  if (status === "recording") {
    return {
      placeholder: "Listening…",
      textareaLabel: "Listening for voice input",
      activityLabel: selectedStatusLabel ?? "Listening… Tap the microphone when you are finished.",
      microphoneLabel: "Stop voice recording",
      microphoneTitle: "Stop and transcribe",
      inputReadOnly: true,
      inputBusy: false,
    };
  }
  if (status === "transcribing") {
    return {
      placeholder: "Transcribing…",
      textareaLabel: "Transcribing voice input",
      activityLabel: selectedStatusLabel ?? "Transcribing your recording…",
      microphoneLabel: "Transcribing voice input",
      microphoneTitle: "Transcribing voice input",
      inputReadOnly: true,
      inputBusy: true,
    };
  }
  return {
    placeholder: "Write a message...",
    textareaLabel: "Write a message...",
    microphoneLabel: "Start voice recording",
    microphoneTitle: "Voice input",
    inputReadOnly: false,
    inputBusy: false,
  };
};
