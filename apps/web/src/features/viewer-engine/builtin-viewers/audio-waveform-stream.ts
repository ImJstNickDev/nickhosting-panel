import type { AudioSample } from 'mediabunny';
import { waveformLimits } from './audio-waveform-model.js';

export type WaveformRequest = { url: string; size: number; duration: number };
export type WaveformMessage =
  | { type: 'peaks' | 'done'; peaks: Float32Array<ArrayBuffer>; duration?: number }
  | { type: 'error' };

type Sample = Pick<
  AudioSample,
  'timestamp' | 'sampleRate' | 'numberOfChannels' | 'numberOfFrames' | 'copyTo' | 'close'
>;

/** Constant-sized envelope and scratch space; PCM belongs to the current sample only. */
export class StreamingWaveform {
  readonly peaks = new Float32Array(waveformLimits.peaks);
  private readonly scratch = new Float32Array(4096);
  private frames = 0;
  private end = 0;
  hasAmplitude = false;

  constructor(
    readonly duration: number,
    readonly origin = 0,
  ) {
    if (!Number.isFinite(duration) || duration <= 0 || duration > waveformLimits.seconds) {
      throw new Error('Invalid waveform duration');
    }
    if (!Number.isFinite(origin)) throw new Error('Invalid waveform timestamp');
  }

  /** Always closes native decoder resources, including malformed samples and copy failures. */
  add(sample: Sample) {
    try {
      const { timestamp, sampleRate, numberOfFrames, numberOfChannels } = sample;
      if (
        !Number.isFinite(timestamp) ||
        !Number.isFinite(sampleRate) ||
        sampleRate <= 0 ||
        !Number.isSafeInteger(numberOfFrames) ||
        numberOfFrames <= 0 ||
        !Number.isSafeInteger(numberOfChannels) ||
        numberOfChannels < 1 ||
        numberOfChannels > 8
      ) {
        throw new Error('Invalid audio sample');
      }
      const start = timestamp - this.origin;
      const end = start + numberOfFrames / sampleRate;
      // Small codec priming/padding differences are valid; unbounded tracks are not.
      const tolerance = Math.max(0.1, this.duration * 0.01);
      if (end > this.duration + tolerance || start < -1) {
        throw new Error('Audio sample outside waveform limits');
      }
      const binsPerSecond = this.peaks.length / this.duration;
      for (let channel = 0; channel < numberOfChannels; channel++) {
        for (let offset = 0; offset < numberOfFrames; offset += this.scratch.length) {
          const count = Math.min(this.scratch.length, numberOfFrames - offset);
          sample.copyTo(this.scratch.subarray(0, count), {
            planeIndex: channel,
            format: 'f32-planar',
            frameOffset: offset,
            frameCount: count,
          });
          for (let frame = 0; frame < count; frame++) {
            const time = start + (offset + frame) / sampleRate;
            if (time < 0 || time >= this.duration) continue;
            const bin = Math.min(this.peaks.length - 1, Math.floor(time * binsPerSecond));
            const value = this.scratch[frame] ?? 0;
            if (!Number.isFinite(value)) throw new Error('Invalid audio amplitude');
            const amplitude = Math.min(1, Math.abs(value));
            if (amplitude > (this.peaks[bin] ?? 0)) this.peaks[bin] = amplitude;
            if (amplitude > 0) this.hasAmplitude = true;
          }
        }
      }
      this.frames += numberOfFrames;
      this.end = Math.max(this.end, end);
    } finally {
      sample.close();
    }
  }

  finish() {
    // Metadata can be approximate, especially VBR MP3. Do not call an empty or
    // clearly truncated decode a successful silent waveform.
    const tolerance = Math.max(0.1, this.duration * 0.01);
    if (!this.frames || this.end < this.duration - tolerance) {
      throw new Error('Incomplete audio waveform');
    }
    return this.peaks;
  }
}

export async function consumeWaveform(
  samples: AsyncIterable<Sample>,
  envelope: StreamingWaveform,
  publish: (message: WaveformMessage) => void,
  now: () => number = () => performance.now(),
) {
  let lastUpdate = Number.NEGATIVE_INFINITY;
  let sentAmplitude = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let publicationFailure: { error: unknown } | undefined;
  const flush = () => {
    clearTimeout(pending);
    pending = undefined;
    publish({ type: 'peaks', peaks: envelope.peaks.slice() });
    lastUpdate = now();
    sentAmplitude ||= envelope.hasAmplitude;
  };
  try {
    for await (const sample of samples) {
      envelope.add(sample);
      if (publicationFailure) throw publicationFailure.error;
      const elapsed = now() - lastUpdate;
      if (elapsed >= 50 || (!sentAmplitude && envelope.hasAmplitude)) {
        flush();
      } else if (pending === undefined) {
        // Flush the latest decoded blocks even when the iterator is waiting for
        // more network bytes. This is batching, not an artificial reveal animation.
        pending = setTimeout(
          () => {
            try {
              flush();
            } catch (error) {
              // Keep asynchronous publication failures in the iterator's error path.
              publicationFailure = { error };
            }
          },
          Math.max(0, 50 - elapsed),
        );
      }
    }
    if (publicationFailure) throw publicationFailure.error;
    publish({ type: 'done', peaks: envelope.finish().slice() });
  } finally {
    clearTimeout(pending);
  }
}
