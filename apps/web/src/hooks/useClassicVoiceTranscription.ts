"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { mediaRecordingToMonoWav, preferredRecordingMimeType } from "@/lib/speech/audio";
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
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcriptHandlerRef = useRef(onTranscript);

  useEffect(() => {
    transcriptHandlerRef.current = onTranscript;
  }, [onTranscript]);

  const releaseRecordingStream = useCallback(() => {
    for (const track of streamRef.current?.getTracks() ?? []) track.stop();
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const processRecording = useCallback(async (recording: Blob) => {
    setStatus("transcribing");
    setError(null);
    try {
      const wav = await mediaRecordingToMonoWav(recording);
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
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("Voice recording is not supported by this browser.");
      setStatus("error");
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = preferredRecordingMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      streamRef.current = stream;
      recorderRef.current = recorder;
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const recording = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        chunksRef.current = [];
        releaseRecordingStream();
        void processRecording(recording);
      };
      recorder.onerror = () => {
        releaseRecordingStream();
        setError("The browser could not capture this recording.");
        setStatus("error");
      };
      recorder.start(250);
      setStatus("recording");
    } catch (recordingError) {
      releaseRecordingStream();
      setError(recordingError instanceof Error ? recordingError.message : "Microphone access failed.");
      setStatus("error");
    }
  }, [processRecording, releaseRecordingStream, transcriberId]);

  const toggleRecording = useCallback(() => {
    if (status === "recording") {
      setStatus("transcribing");
      recorderRef.current?.stop();
      return;
    }
    if (status === "idle" || status === "error") void startRecording();
  }, [startRecording, status]);

  useEffect(() => () => {
    const recorder = recorderRef.current;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state === "recording") recorder.stop();
    }
    releaseRecordingStream();
  }, [releaseRecordingStream]);

  useEffect(() => {
    const syncTranscriber = () => setTranscriberId(readSpeechTranscriberId());
    syncTranscriber();
    return subscribeToSpeechPreferences(syncTranscriber);
  }, []);

  return {
    status,
    error,
    isAvailable:
      typeof window !== "undefined" &&
      Boolean(navigator.mediaDevices?.getUserMedia) &&
      typeof MediaRecorder !== "undefined",
    toggleRecording,
  };
}
