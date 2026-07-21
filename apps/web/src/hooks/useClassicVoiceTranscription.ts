"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import {
  isMonoWavRecordingSupported,
  startMonoWavRecording,
  type MonoWavRecording,
} from "@/lib/speech/audio";
import {
  configuredTranscriber,
  readSpeechTranscriberId,
  subscribeToSpeechPreferences,
  type SpeechTranscriberId,
} from "@/lib/speech/preferences";

export type ClassicVoiceStatus = "idle" | "recording" | "transcribing" | "error";

interface UseClassicVoiceTranscriptionInput {
  projectId: string;
  conversationId: string;
  onTranscript: (text: string) => void;
}

export function useClassicVoiceTranscription({
  projectId,
  conversationId,
  onTranscript,
}: UseClassicVoiceTranscriptionInput) {
  const [status, setStatus] = useState<ClassicVoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcriberId, setTranscriberId] = useState<SpeechTranscriberId>("disabled");
  const recorderRef = useRef<MonoWavRecording | null>(null);
  const transcriptHandlerRef = useRef(onTranscript);

  useEffect(() => {
    transcriptHandlerRef.current = onTranscript;
  }, [onTranscript]);

  const processRecording = useCallback(async (wav: Blob) => {
    setStatus("transcribing");
    setError(null);
    try {
      const preference = configuredTranscriber(transcriberId);
      if (!preference) {
        throw new Error("Choose a transcriber in Settings before using voice input.");
      }
      const result = await api.transcribeConversationRecording(projectId, conversationId, wav, {
        engine: preference.engine,
        modelId: preference.modelId,
      });
      transcriptHandlerRef.current(result.transcriptText.trim());
      setStatus("idle");
    } catch (processingError) {
      setError(processingError instanceof Error ? processingError.message : "Voice transcription failed.");
      setStatus("error");
    }
  }, [conversationId, projectId, transcriberId]);

  const startRecording = useCallback(async () => {
    if (!configuredTranscriber(transcriberId)) {
      setError("Choose a transcriber in Settings before using voice input.");
      setStatus("error");
      return;
    }
    if (!isMonoWavRecordingSupported()) {
      setError("Voice recording is not supported by this browser.");
      setStatus("error");
      return;
    }
    setError(null);
    try {
      recorderRef.current = await startMonoWavRecording();
      setStatus("recording");
    } catch (recordingError) {
      recorderRef.current = null;
      setError(recordingError instanceof Error ? recordingError.message : "Microphone access failed.");
      setStatus("error");
    }
  }, [transcriberId]);

  const toggleRecording = useCallback(() => {
    if (status === "recording") {
      setStatus("transcribing");
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        void recorder.stop().then(processRecording).catch((recordingError: unknown) => {
          setError(recordingError instanceof Error ? recordingError.message : "Voice recording failed.");
          setStatus("error");
        });
      }
      return;
    }
    if (status === "idle" || status === "error") void startRecording();
  }, [processRecording, startRecording, status]);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) void recorder.cancel();
  }, []);

  useEffect(() => {
    const syncTranscriber = () => setTranscriberId(readSpeechTranscriberId());
    syncTranscriber();
    return subscribeToSpeechPreferences(syncTranscriber);
  }, []);

  return {
    status,
    error,
    isAvailable: isMonoWavRecordingSupported(),
    transcriberLabel: configuredTranscriber(transcriberId)?.label,
    toggleRecording,
  };
}
