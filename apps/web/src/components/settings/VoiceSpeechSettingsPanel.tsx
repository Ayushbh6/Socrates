"use client";

import { Mic2, ShieldCheck, Volume2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { V2SpeechPackManager } from "@/components/v2/V2SpeechPackManager";
import {
  readSpeechReadAloudId,
  readSpeechTranscriberId,
  SPEECH_READ_ALOUD_OPTIONS,
  SPEECH_TRANSCRIBER_OPTIONS,
  subscribeToSpeechPreferences,
  writeSpeechReadAloudId,
  writeSpeechTranscriberId,
  type SpeechReadAloudId,
  type SpeechTranscriberId,
} from "@/lib/speech/preferences";

export function VoiceSpeechSettingsPanel() {
  const [transcriberId, setTranscriberId] = useState<SpeechTranscriberId>(readSpeechTranscriberId);
  const [readAloudId, setReadAloudId] = useState<SpeechReadAloudId>(readSpeechReadAloudId);

  useEffect(() => subscribeToSpeechPreferences(() => {
    setTranscriberId(readSpeechTranscriberId());
    setReadAloudId(readSpeechReadAloudId());
  }), []);

  const transcriber = useMemo(
    () => SPEECH_TRANSCRIBER_OPTIONS.find((option) => option.id === transcriberId) ?? SPEECH_TRANSCRIBER_OPTIONS[0],
    [transcriberId],
  );
  const readAloud = useMemo(
    () => SPEECH_READ_ALOUD_OPTIONS.find((option) => option.id === readAloudId) ?? SPEECH_READ_ALOUD_OPTIONS[0],
    [readAloudId],
  );

  return (
    <section aria-labelledby="voice-speech-settings-title" className="space-y-4">
      <div>
        <h2 id="voice-speech-settings-title" className="flex items-center gap-2 text-base font-semibold text-brand-text-dark">
          <Mic2 className="size-4 text-teal-600" aria-hidden="true" />
          Voice &amp; speech
        </h2>
        <p className="mt-1 text-sm text-brand-text-light">
          One explicit voice preference is shared by Classic and Flow. Socrates never downloads a model or changes to a hosted service automatically.
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <label className="rounded-lg border border-gray-200 bg-white p-4">
          <span className="flex items-center gap-2 text-sm font-semibold text-brand-text-dark">
            <Mic2 className="size-4 text-teal-600" aria-hidden="true" />
            Voice input
          </span>
          <span className="mt-1 block text-xs text-brand-text-light">Transcribes microphone recordings into the composer without sending them.</span>
          <select
            className="mt-3 h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-brand-text-dark outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            value={transcriberId}
            onChange={(event) => {
              const next = event.target.value as SpeechTranscriberId;
              setTranscriberId(next);
              writeSpeechTranscriberId(next);
            }}
          >
            {SPEECH_TRANSCRIBER_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <span className="mt-2 block text-xs leading-5 text-brand-text-light">{transcriber.description}</span>
        </label>

        <label className="rounded-lg border border-gray-200 bg-white p-4">
          <span className="flex items-center gap-2 text-sm font-semibold text-brand-text-dark">
            <Volume2 className="size-4 text-teal-600" aria-hidden="true" />
            Read aloud
          </span>
          <span className="mt-1 block text-xs text-brand-text-light">Controls local speech generation for completed Flow responses.</span>
          <select
            className="mt-3 h-11 w-full rounded-lg border border-gray-200 bg-white px-3 text-sm text-brand-text-dark outline-none transition focus:border-teal-500 focus:ring-2 focus:ring-teal-100"
            value={readAloudId}
            onChange={(event) => {
              const next = event.target.value as SpeechReadAloudId;
              setReadAloudId(next);
              writeSpeechReadAloudId(next);
            }}
          >
            {SPEECH_READ_ALOUD_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <span className="mt-2 block text-xs leading-5 text-brand-text-light">{readAloud.description}</span>
        </label>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-teal-100 bg-teal-50/60 px-3 py-2 text-xs leading-5 text-teal-900">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>
          Hosted options require your OpenRouter API key. Offline options work only after you press Install below; downloads are size-labelled and checksum-verified.
        </span>
      </div>

      <V2SpeechPackManager headingId="settings-offline-speech-packs" />
    </section>
  );
}
