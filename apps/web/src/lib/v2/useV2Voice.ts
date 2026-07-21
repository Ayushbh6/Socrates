"use client";

import {
  V2_LOCAL_KOKORO_MODEL_ID,
  type V2CreateSpeechJobRequest,
} from "@socrates/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { v2Api } from "./api";
import {
  isMonoWavRecordingSupported,
  startMonoWavRecording,
  type MonoWavRecording,
} from "@/lib/speech/audio";
import { speechChunksFromMarkdown } from "@/lib/speech/readAloud";
import {
  configuredTranscriber,
  readSpeechReadAloudId,
  readSpeechTranscriberId,
  SPEECH_TRANSCRIBER_OPTIONS,
  subscribeToSpeechPreferences,
  writeSpeechTranscriberId,
  type SpeechTranscriberId,
} from "@/lib/speech/preferences";

export type V2VoiceStatus = "idle" | "recording" | "transcribing" | "synthesizing" | "speaking" | "error";

export const V2_TRANSCRIBER_OPTIONS = SPEECH_TRANSCRIBER_OPTIONS;
export type V2TranscriberId = SpeechTranscriberId;

interface UseV2VoiceInput {
  projectId: string;
  flowId?: string;
  goalId?: string;
  onTranscript: (text: string) => void;
}

export function useV2Voice({ projectId, flowId, goalId, onTranscript }: UseV2VoiceInput) {
  const [status, setStatus] = useState<V2VoiceStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcriberId, setTranscriberIdState] = useState<V2TranscriberId>("disabled");
  const recorderRef = useRef<MonoWavRecording | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const audioFinishRef = useRef<(() => void) | null>(null);
  const readAloudSessionRef = useRef(0);
  const readAloudCacheRef = useRef(new Map<string, Map<number, Blob>>());
  const [activeReadAloudMessageId, setActiveReadAloudMessageId] = useState<string | null>(null);
  const transcriptHandlerRef = useRef(onTranscript);

  useEffect(() => {
    transcriptHandlerRef.current = onTranscript;
  }, [onTranscript]);

  const processRecording = useCallback(async (wav: Blob) => {
    if (!flowId) throw new Error("The project flow is not ready for voice input.");
    setStatus("transcribing");
    setError(null);
    try {
      const artifact = await v2Api.uploadSpeechArtifact(projectId, flowId, wav);
      const preference = configuredTranscriber(transcriberId);
      if (!preference) {
        throw new Error("Choose a transcriber in Settings before using voice input.");
      }
      const request = {
        kind: "transcription",
        engine: preference.engine,
        modelId: preference.modelId,
        inputArtifactId: artifact.id,
        ...(goalId ? { goalId } : {}),
      } as V2CreateSpeechJobRequest;
      const job = await v2Api.createSpeechJob(projectId, flowId, request);
      if (job.kind !== "transcription" || job.status !== "completed" || !job.transcriptText?.trim()) {
        throw new Error("The transcriber returned no text.");
      }
      transcriptHandlerRef.current(job.transcriptText.trim());
      setStatus("idle");
    } catch (processingError) {
      setError(processingError instanceof Error ? processingError.message : "Voice transcription failed.");
      setStatus("error");
    }
  }, [flowId, goalId, projectId, transcriberId]);

  const startRecording = useCallback(async () => {
    if (!flowId) throw new Error("The project flow is still loading.");
    if (!configuredTranscriber(transcriberId)) {
      setError("Choose a transcriber in Settings before using voice input.");
      setStatus("error");
      return;
    }
    if (!isMonoWavRecordingSupported()) {
      throw new Error("Voice recording is not supported by this browser.");
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
  }, [flowId, transcriberId]);

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
    if (status === "idle" || status === "error") {
      void startRecording();
    }
  }, [processRecording, startRecording, status]);

  const stopPlayback = useCallback(() => {
    const finish = audioFinishRef.current;
    audioFinishRef.current = null;
    audioRef.current?.pause();
    audioRef.current = null;
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = null;
    finish?.();
  }, []);

  const cancelReadAloud = useCallback(() => {
    readAloudSessionRef.current += 1;
    stopPlayback();
    setActiveReadAloudMessageId(null);
    setStatus("idle");
    setError(null);
  }, [stopPlayback]);

  const synthesizeChunk = useCallback(async (input: {
    messageId: string;
    text: string;
    chunkIndex: number;
  }): Promise<Blob> => {
    const cached = readAloudCacheRef.current.get(input.messageId)?.get(input.chunkIndex);
    if (cached) return cached;
    if (!flowId) throw new Error("The project flow is still loading.");
    const job = await v2Api.createSpeechJob(projectId, flowId, {
      kind: "synthesis",
      engine: "local_kokoro",
      modelId: V2_LOCAL_KOKORO_MODEL_ID,
      inputText: input.text,
      voiceId: "speaker-0",
      speed: 1,
      messageId: input.messageId,
      ...(goalId ? { goalId } : {}),
    });
    if (job.engine !== "local_kokoro" || job.status !== "completed" || !job.outputArtifactId) {
      throw new Error("Kokoro did not return an audio response.");
    }
    const audioBlob = await v2Api.speechArtifactContent(projectId, flowId, job.outputArtifactId);
    const messageCache = readAloudCacheRef.current.get(input.messageId) ?? new Map<number, Blob>();
    messageCache.set(input.chunkIndex, audioBlob);
    readAloudCacheRef.current.set(input.messageId, messageCache);
    return audioBlob;
  }, [flowId, goalId, projectId]);

  const playAudioBlob = useCallback((audioBlob: Blob, sessionId: number): Promise<void> => new Promise((resolve, reject) => {
    if (readAloudSessionRef.current !== sessionId) {
      resolve();
      return;
    }
    stopPlayback();
    const url = URL.createObjectURL(audioBlob);
    const audio = new Audio(url);
    audioRef.current = audio;
    audioUrlRef.current = url;
    audioFinishRef.current = resolve;
    audio.onended = stopPlayback;
    audio.onerror = () => {
      audioFinishRef.current = null;
      audio.pause();
      audioRef.current = null;
      URL.revokeObjectURL(url);
      audioUrlRef.current = null;
      reject(new Error("The generated audio could not be played."));
    };
    void audio.play().catch((playbackError: unknown) => {
      audioFinishRef.current = null;
      audio.pause();
      audioRef.current = null;
      URL.revokeObjectURL(url);
      audioUrlRef.current = null;
      reject(playbackError);
    });
  }), [stopPlayback]);

  const readAloud = useCallback(async (input: { messageId: string; text: string }) => {
    if (!flowId) throw new Error("The project flow is still loading.");
    if (readSpeechReadAloudId() === "disabled") {
      setError("Choose and install a read-aloud voice in Settings first.");
      setStatus("error");
      return;
    }
    if (activeReadAloudMessageId === input.messageId && (status === "synthesizing" || status === "speaking")) {
      cancelReadAloud();
      return;
    }
    const chunks = speechChunksFromMarkdown(input.text);
    if (chunks.length === 0) return;
    readAloudSessionRef.current += 1;
    const sessionId = readAloudSessionRef.current;
    stopPlayback();
    setError(null);
    setActiveReadAloudMessageId(input.messageId);
    setStatus("synthesizing");
    try {
      let currentAudio = await synthesizeChunk({ messageId: input.messageId, text: chunks[0]!, chunkIndex: 0 });
      for (let index = 0; index < chunks.length; index += 1) {
        if (readAloudSessionRef.current !== sessionId) return;
        const nextAudioPromise = index + 1 < chunks.length
          ? synthesizeChunk({ messageId: input.messageId, text: chunks[index + 1]!, chunkIndex: index + 1 }).then(
            (audio) => ({ audio } as const),
            (nextError: unknown) => ({ error: nextError } as const),
          )
          : undefined;
        setStatus("speaking");
        await playAudioBlob(currentAudio, sessionId);
        if (readAloudSessionRef.current !== sessionId) return;
        if (nextAudioPromise) {
          setStatus("synthesizing");
          const next = await nextAudioPromise;
          if ("error" in next) throw next.error;
          currentAudio = next.audio;
        }
      }
      if (readAloudSessionRef.current === sessionId) {
        setActiveReadAloudMessageId(null);
        setStatus("idle");
      }
    } catch (speechError) {
      if (readAloudSessionRef.current !== sessionId) return;
      stopPlayback();
      setActiveReadAloudMessageId(null);
      setError(speechError instanceof Error ? speechError.message : "Read aloud failed.");
      setStatus("error");
    }
  }, [activeReadAloudMessageId, cancelReadAloud, flowId, playAudioBlob, status, stopPlayback, synthesizeChunk]);

  const setTranscriberId = useCallback((next: V2TranscriberId) => {
    setTranscriberIdState(next);
    writeSpeechTranscriberId(next);
  }, []);

  useEffect(() => {
    const syncTranscriber = () => setTranscriberIdState(readSpeechTranscriberId());
    syncTranscriber();
    return subscribeToSpeechPreferences(syncTranscriber);
  }, []);

  useEffect(() => () => {
    readAloudSessionRef.current += 1;
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) void recorder.cancel();
    stopPlayback();
  }, [stopPlayback]);

  return {
    status,
    error,
    isAvailable: isMonoWavRecordingSupported(),
    transcriberId,
    transcriberLabel: configuredTranscriber(transcriberId)?.label,
    transcriberOptions: V2_TRANSCRIBER_OPTIONS,
    activeReadAloudMessageId,
    setTranscriberId,
    toggleRecording,
    readAloud,
    cancelReadAloud,
    clearError: () => {
      setError(null);
      if (status === "error") setStatus("idle");
    },
  };
}
