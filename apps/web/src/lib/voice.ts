/**
 * Speaking to Socrates (architecture/web.md, "Voice"): the microphone's sound
 * kept as plain samples, shown as moving bars while it records, and sent as
 * 16 kHz mono WAV, a format every transcription model reads. The pure parts
 * (levels, resampling, WAV) are exported for tests.
 */

/** What is sent: speech needs no more than 16 kHz. */
export const WAV_RATE = 16_000;
/** A recording stops by itself after this long. */
export const MAX_SECONDS = 600;
/** Levels are measured this often for the bars. */
export const LEVEL_MS = 50;

/** The loudness of some samples, 0 to 1, scaled so that speech fills the bar and room noise stays a dot. */
export function level(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  const rms = Math.sqrt(sum / samples.length);
  // Quiet rooms sit near 0.002–0.01 RMS, speech near 0.03–0.3: a log scale from -50 dB to -10 dB.
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (db + 50) / 40));
}

/** Whether a level is voice rather than the room: the bars rise above dots only past it. */
export const VOICE_LEVEL = 0.18;

/** Samples at one rate brought to another, by linear interpolation (enough for speech going down to 16 kHz). */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to || !samples.length) return samples;
  const ratio = from / to;
  const out = new Float32Array(Math.max(1, Math.floor(samples.length / ratio)));
  for (let i = 0; i < out.length; i++) {
    const at = i * ratio;
    const j = Math.floor(at);
    const frac = at - j;
    const a = samples[j] ?? 0;
    const b = samples[j + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Mono 16-bit PCM in a WAV file. */
export function encodeWav(samples: Float32Array, rate: number): Blob {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([bytes], { type: "audio/wav" });
}

/** Whether this browser can record here (a page served over http from another machine cannot). */
export function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof AudioContext !== "undefined";
}

/** What went wrong opening the microphone, in words. */
export function micProblem(error: unknown): string {
  const name = (error as { name?: string } | null)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "The microphone is blocked for this page. Allow it in the browser's site settings, then try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found.";
  if (name === "NotReadableError") return "The microphone is in use by another app.";
  return `The microphone could not start: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * One recording. `onLevel` hears the loudness every LEVEL_MS; `stop()`
 * returns the WAV, `cancel()` throws it away. Either releases the microphone.
 */
export class Recording {
  private chunks: Float32Array[] = [];
  private pending: Float32Array[] = [];
  private pendingLength = 0;
  private closed = false;
  readonly startedAt = Date.now();

  private constructor(private stream: MediaStream, private context: AudioContext, private node: ScriptProcessorNode, private source: MediaStreamAudioSourceNode, onLevel: (level: number) => void) {
    const every = Math.round((context.sampleRate * LEVEL_MS) / 1000);
    // The bars hear the loudness about every LEVEL_MS (a little more when the browser's buffer is longer).
    node.onaudioprocess = (e) => {
      if (this.closed) return;
      const data = new Float32Array(e.inputBuffer.getChannelData(0));
      this.chunks.push(data);
      this.pending.push(data);
      this.pendingLength += data.length;
      if (this.pendingLength < every) return;
      const joined = join(this.pending, this.pendingLength);
      this.pending = [];
      this.pendingLength = 0;
      onLevel(level(joined));
    };
  }

  static async start(onLevel: (level: number) => void): Promise<Recording> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    try {
      const context = new AudioContext();
      if (context.state === "suspended") await context.resume();
      const source = context.createMediaStreamSource(stream);
      // ScriptProcessor is old but works in every browser and needs no worklet file; the gain keeps it running silently.
      const node = context.createScriptProcessor(2048, 1, 1);
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      return new Recording(stream, context, node, source, onLevel);
    } catch (error) {
      for (const t of stream.getTracks()) t.stop();
      throw error;
    }
  }

  get seconds(): number {
    return (Date.now() - this.startedAt) / 1000;
  }

  /** The recording as WAV, and how long it is. */
  async stop(): Promise<{ wav: Blob; seconds: number }> {
    const rate = this.context.sampleRate;
    await this.close();
    const all = join(this.chunks, this.chunks.reduce((n, c) => n + c.length, 0));
    this.chunks = [];
    const samples = resample(all, rate, WAV_RATE);
    return { wav: encodeWav(samples, WAV_RATE), seconds: samples.length / WAV_RATE };
  }

  async cancel(): Promise<void> {
    this.chunks = [];
    await this.close();
  }

  private async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.node.onaudioprocess = null;
    try { this.source.disconnect(); this.node.disconnect(); } catch { /* already apart */ }
    for (const t of this.stream.getTracks()) t.stop();
    await this.context.close().catch(() => {});
  }
}

function join(parts: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** "0:07", "1:23". */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Text spoken after what is already typed: one space between, nothing doubled. */
export function appendSpoken(typed: string, spoken: string): string {
  const said = spoken.trim();
  if (!said) return typed;
  if (!typed.trim()) return said;
  return /\s$/.test(typed) ? `${typed}${said}` : `${typed} ${said}`;
}
