import { ArrowUp, LoaderCircle, Mic, Square, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { MAX_SECONDS, Recording, VOICE_LEVEL, canRecord, clock, micProblem } from "../lib/voice";

type State =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "recording"; recording: Recording }
  | { kind: "transcribing"; send: boolean; abort: AbortController };

/**
 * Speaking instead of typing (architecture/web.md, "Voice"). `useVoice` owns
 * the microphone; the composer shows `MicButton` beside Send and, while it
 * records or transcribes, `VoiceBar` in place of its controls.
 */
export function useVoice(onText: (text: string, send: boolean) => void) {
  const [state, setState] = useState<State>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const levels = useRef<number[]>([]);
  const [tick, setTick] = useState(0);
  const current = useRef(state);
  current.current = state;
  const deliver = useRef(onText);
  deliver.current = onText;

  const start = async () => {
    if (current.current.kind !== "idle") return;
    setError(null);
    levels.current = [];
    setState({ kind: "starting" });
    try {
      const recording = await Recording.start((l) => { levels.current.push(l); if (levels.current.length > 400) levels.current.splice(0, 100); setTick((t) => t + 1); });
      setState({ kind: "recording", recording });
    } catch (e) {
      setError(micProblem(e));
      setState({ kind: "idle" });
    }
  };

  const finish = async (send: boolean) => {
    const now = current.current;
    if (now.kind !== "recording") return;
    const abort = new AbortController();
    setState({ kind: "transcribing", send, abort });
    try {
      const { wav, seconds } = await now.recording.stop();
      if (seconds < 0.4) throw new Error("That was too short to hear anything. Hold on a moment longer.");
      const { text } = await api.transcribe(wav, abort.signal);
      if (abort.signal.aborted) return;
      if (!text.trim()) setError("No words were heard in that recording.");
      else deliver.current(text, send);
    } catch (e) {
      if (!abort.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setState((s) => (s.kind === "transcribing" && s.abort === abort ? { kind: "idle" } : s));
    }
  };

  const cancel = () => {
    const now = current.current;
    if (now.kind === "recording") void now.recording.cancel();
    if (now.kind === "transcribing") now.abort.abort();
    setState({ kind: "idle" });
  };

  // Escape throws a recording away; a recording stops itself at the limit.
  useEffect(() => {
    if (state.kind !== "recording" && state.kind !== "transcribing") return;
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [state.kind]);
  useEffect(() => {
    if (state.kind === "recording" && state.recording.seconds >= MAX_SECONDS) void finish(false);
  }, [tick, state]);
  // Leaving the page or the chat releases the microphone.
  useEffect(() => () => { const now = current.current; if (now.kind === "recording") void now.recording.cancel(); if (now.kind === "transcribing") now.abort.abort(); }, []);

  return { state, error, clearError: () => setError(null), levels: levels.current, tick, start, finish, cancel, active: state.kind === "recording" || state.kind === "transcribing" };
}

export type Voice = ReturnType<typeof useVoice>;

/** The microphone beside Send; asks for the browser's permission the first time. */
export function MicButton({ voice, ready, model }: { voice: Voice; ready: boolean; model: string | null }) {
  if (!canRecord()) return null;
  const starting = voice.state.kind === "starting";
  const title = !ready ? "Speaking needs an OpenRouter key (Settings > API keys)" : starting ? "Opening the microphone…" : `Speak instead of typing${model ? ` (${model.split("/").pop()})` : ""}`;
  return (
    <button type="button" className="mic-button" onClick={() => void voice.start()} disabled={!ready || starting} aria-label="Speak" title={title}>
      {starting ? <LoaderCircle aria-hidden className="spin" /> : <Mic aria-hidden />}
    </button>
  );
}

/** While recording: cancel, the moving bars, the time, stop (into the box) and send. While transcribing: what it is doing. */
export function VoiceBar({ voice }: { voice: Voice }) {
  const { state } = voice;
  if (state.kind === "transcribing") {
    return (
      <div className="voice-bar" data-state="transcribing" role="status">
        <button type="button" className="voice-cancel" onClick={voice.cancel} aria-label="Cancel" title="Cancel (Esc)"><X aria-hidden /></button>
        <span className="voice-status"><LoaderCircle aria-hidden className="spin" /><span className="shimmer">{state.send ? "Transcribing and sending…" : "Transcribing…"}</span></span>
      </div>
    );
  }
  if (state.kind !== "recording") return null;
  return (
    <div className="voice-bar" data-state="recording">
      <button type="button" className="voice-cancel" onClick={voice.cancel} aria-label="Cancel the recording" title="Cancel (Esc)"><X aria-hidden /></button>
      <Waveform levels={voice.levels} tick={voice.tick} />
      <span className="voice-time" aria-live="off">{clock(state.recording.seconds)}</span>
      <button type="button" className="voice-stop" onClick={() => void voice.finish(false)} aria-label="Stop and put the text in the box" title="Stop: put the words in the box to edit"><Square aria-hidden /></button>
      <button type="button" className="send-button" onClick={() => void voice.finish(true)} aria-label="Stop and send" title="Stop and send"><ArrowUp aria-hidden /></button>
    </div>
  );
}

/** Bars that rise with the voice and settle into dots in the quiet, newest on the right. */
function Waveform({ levels, tick }: { levels: number[]; tick: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const dpr = window.devicePixelRatio || 1;
    const width = el.clientWidth;
    const height = el.clientHeight;
    if (el.width !== Math.round(width * dpr) || el.height !== Math.round(height * dpr)) {
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
    }
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    const style = getComputedStyle(el);
    const loud = style.color;
    const quiet = style.getPropertyValue("--voice-quiet").trim() || loud;
    const step = 5;
    const bar = 2.5;
    const count = Math.floor(width / step);
    const mid = height / 2;
    for (let i = 0; i < count; i++) {
      const l = levels[levels.length - count + i];
      const x = i * step + (width - count * step);
      if (l === undefined || l < VOICE_LEVEL) {
        ctx.fillStyle = quiet;
        ctx.beginPath();
        ctx.arc(x + bar / 2, mid, 1.1, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // A little jitter keeps a held note alive, as a real meter does.
      const h = Math.max(4, Math.min(height, (l - VOICE_LEVEL) / (1 - VOICE_LEVEL) * height * (0.85 + 0.3 * Math.abs(Math.sin((i + tick) * 1.7)))));
      ctx.fillStyle = loud;
      ctx.beginPath();
      ctx.roundRect(x, mid - h / 2, bar, h, bar / 2);
      ctx.fill();
    }
  }, [levels, tick]);
  return <canvas ref={canvas} className="voice-wave" aria-hidden />;
}
