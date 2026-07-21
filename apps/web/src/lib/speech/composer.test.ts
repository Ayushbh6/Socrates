import { describe, expect, it } from "vitest";
import { composerVoicePresentation } from "./composer";

describe("composerVoicePresentation", () => {
  it("shows an explicit listening state while recording", () => {
    expect(composerVoicePresentation("recording")).toMatchObject({
      placeholder: "Listening…",
      activityLabel: "Listening… Tap the microphone when you are finished.",
      microphoneLabel: "Stop voice recording",
      inputReadOnly: true,
      inputBusy: false,
    });
  });

  it("shows the selected hosted transcriber while processing", () => {
    expect(composerVoicePresentation(
      "transcribing",
      "Transcribing with Parakeet TDT 0.6B · OpenRouter…",
    )).toMatchObject({
      placeholder: "Transcribing…",
      activityLabel: "Transcribing with Parakeet TDT 0.6B · OpenRouter…",
      microphoneLabel: "Transcribing voice input",
      inputReadOnly: true,
      inputBusy: true,
    });
  });

  it("returns to the normal composer when voice input is idle", () => {
    expect(composerVoicePresentation("idle")).toMatchObject({
      placeholder: "Write a message...",
      microphoneLabel: "Start voice recording",
      inputReadOnly: false,
      inputBusy: false,
    });
  });
});
