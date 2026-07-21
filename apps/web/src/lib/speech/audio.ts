const WAV_HEADER_BYTES = 44;
const PCM_BYTES_PER_SAMPLE = 2;

const writeAscii = (view: DataView, offset: number, value: string): void => {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
};

/** Encode mono floating-point PCM samples as a 16-bit WAV file. */
export function encodeMonoPcm16Wav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("The microphone returned an invalid sample rate.");
  }

  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + samples.length * PCM_BYTES_PER_SAMPLE);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * PCM_BYTES_PER_SAMPLE, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * PCM_BYTES_PER_SAMPLE, true);
  view.setUint16(32, PCM_BYTES_PER_SAMPLE, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * PCM_BYTES_PER_SAMPLE, true);

  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(
      WAV_HEADER_BYTES + index * PCM_BYTES_PER_SAMPLE,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }

  return buffer;
}

export type MonoWavRecording = Readonly<{
  stop: () => Promise<Blob>;
  cancel: () => Promise<void>;
}>;

type AudioContextWindow = Window &
  typeof globalThis & {
    webkitAudioContext?: typeof AudioContext;
  };

const audioContextConstructor = (): typeof AudioContext | undefined => {
  if (typeof window === "undefined") return undefined;
  return window.AudioContext ?? (window as AudioContextWindow).webkitAudioContext;
};

export const isMonoWavRecordingSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  Boolean(audioContextConstructor());

/**
 * Capture microphone PCM directly and emit one normalized mono WAV blob.
 *
 * MediaRecorder commonly emits WebM/Opus fragments that decodeAudioData cannot
 * reliably reopen. Capturing PCM avoids that codec round trip and gives local
 * Whisper and hosted transcribers the same deterministic input.
 */
export async function startMonoWavRecording(): Promise<MonoWavRecording> {
  const AudioContextClass = audioContextConstructor();
  if (!navigator.mediaDevices?.getUserMedia || !AudioContextClass) {
    throw new Error("Voice recording is not supported by this browser.");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const context = new AudioContextClass({ latencyHint: "interactive" });

  try {
    if (context.state === "suspended") await context.resume();

    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    const mutedOutput = context.createGain();
    mutedOutput.gain.value = 0;

    const chunks: Float32Array[] = [];
    let sampleCount = 0;
    let finished = false;

    processor.onaudioprocess = (event) => {
      const input = event.inputBuffer;
      const samples = new Float32Array(input.length);
      const channelCount = Math.max(1, input.numberOfChannels);
      for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
        const channelSamples = input.getChannelData(channel);
        for (let index = 0; index < channelSamples.length; index += 1) {
          samples[index] = (samples[index] ?? 0) + channelSamples[index]! / channelCount;
        }
      }
      chunks.push(samples);
      sampleCount += samples.length;
    };

    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(context.destination);

    const cleanup = async (): Promise<void> => {
      processor.onaudioprocess = null;
      source.disconnect();
      processor.disconnect();
      mutedOutput.disconnect();
      for (const track of stream.getTracks()) track.stop();
      if (context.state !== "closed") await context.close();
    };

    return {
      stop: async () => {
        if (finished) throw new Error("This voice recording has already stopped.");
        finished = true;
        await cleanup();
        if (sampleCount === 0) {
          throw new Error("No microphone audio was captured. Speak for a moment before stopping.");
        }

        const samples = new Float32Array(sampleCount);
        let offset = 0;
        for (const chunk of chunks) {
          samples.set(chunk, offset);
          offset += chunk.length;
        }
        return new Blob([encodeMonoPcm16Wav(samples, context.sampleRate)], { type: "audio/wav" });
      },
      cancel: async () => {
        if (finished) return;
        finished = true;
        await cleanup();
      },
    };
  } catch (error) {
    for (const track of stream.getTracks()) track.stop();
    if (context.state !== "closed") await context.close().catch(() => undefined);
    throw error;
  }
}
