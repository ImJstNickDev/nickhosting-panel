import { AudioSample } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';
import {
  consumeWaveform,
  StreamingWaveform,
  type WaveformMessage,
} from './audio-waveform-stream.js';

function sample(channels: number[][], timestamp = 0, sampleRate = 1024) {
  const audio = new AudioSample({
    data: new Float32Array(channels.flat()),
    format: 'f32-planar',
    numberOfChannels: channels.length,
    sampleRate,
    timestamp,
  });
  const close = vi.spyOn(audio, 'close');
  return { audio, close };
}

describe('Wave streaming envelope', () => {
  it('combines real timestamped stereo chunks without cancellation or resetting prior peaks', () => {
    const envelope = new StreamingWaveform(1);
    const first = sample([
      [0.5, -0.25],
      [-0.5, 0.75],
    ]);
    envelope.add(first.audio);
    expect(first.close).toHaveBeenCalledOnce();
    const next = sample([[0.8]], 1 / 1024);
    envelope.add(next.audio);
    expect(Array.from(envelope.peaks.slice(0, 4))).toEqual([0.5, new Float32Array([0.8])[0], 0, 0]);
    expect(next.close).toHaveBeenCalledOnce();
  });

  it('handles chunks larger than scratch space and retains the last decoded frame', () => {
    const values = new Array<number>(8193).fill(0);
    values[8192] = -1;
    const { audio, close } = sample([values], 0, values.length);
    const envelope = new StreamingWaveform(1);
    const copy = vi.spyOn(audio, 'copyTo');
    envelope.add(audio);
    expect(envelope.finish()[1023]).toBe(1);
    expect(copy).toHaveBeenCalledTimes(3);
    for (const [destination] of copy.mock.calls) {
      expect((destination as Float32Array).length).toBeLessThanOrEqual(4096);
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('skips negative priming frames and preserves genuine complete silence', () => {
    const envelope = new StreamingWaveform(1);
    envelope.add(sample([[1, 1]], -2 / 1024).audio);
    envelope.add(sample([new Array<number>(1024).fill(0)]).audio);
    expect(envelope.finish().every((value) => value === 0)).toBe(true);
    expect(envelope.hasAmplitude).toBe(false);
  });

  it('rejects a duration underestimate instead of reporting a clipped tail as complete', async () => {
    const messages: WaveformMessage[] = [];
    const tail = sample([new Array<number>(256).fill(0.8)], 1);
    async function* longerThanTimeline() {
      yield sample([new Array<number>(1024).fill(0.5)]).audio;
      yield tail.audio;
    }
    await expect(
      consumeWaveform(longerThanTimeline(), new StreamingWaveform(1), (message) =>
        messages.push(message),
      ),
    ).rejects.toThrow('outside waveform limits');
    expect(tail.close).toHaveBeenCalledOnce();
    expect(messages.some((message) => message.type === 'done')).toBe(false);
  });

  it('aligns timestamp offsets with the player timeline and tolerates small codec padding', () => {
    const envelope = new StreamingWaveform(1);
    envelope.add(sample([new Array<number>(512).fill(0.75)], 0.5).audio);
    envelope.add(sample([new Array<number>(32).fill(0.5)], 1).audio);
    expect(envelope.finish()[0]).toBe(0);
    expect(envelope.finish()[511]).toBe(0);
    expect(envelope.finish()[512]).toBe(0.75);
    expect(envelope.finish()[1023]).toBe(0.75);
  });

  it('rejects empty, truncated and invalid decoded data while closing samples', () => {
    const envelope = new StreamingWaveform(1);
    expect(() => envelope.finish()).toThrow('Incomplete');
    envelope.add(sample([[0.5]]).audio);
    expect(() => envelope.finish()).toThrow('Incomplete');
    const invalid = sample([[Number.NaN]]);
    expect(() => envelope.add(invalid.audio)).toThrow('Invalid audio amplitude');
    expect(invalid.close).toHaveBeenCalledOnce();
    const tooManyChannels = sample(Array.from({ length: 9 }, () => [0]));
    expect(() => envelope.add(tooManyChannels.audio)).toThrow('Invalid audio sample');
    expect(tooManyChannels.close).toHaveBeenCalledOnce();
  });

  it('publishes actual early peaks before the stream is complete with bounded update frequency', async () => {
    const messages: WaveformMessage[] = [];
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const envelope = new StreamingWaveform(1);
    async function* samples() {
      yield sample([new Array<number>(256).fill(0.5)]).audio;
      await held;
      yield sample([new Array<number>(256).fill(0.7)], 0.25).audio;
      yield sample([new Array<number>(512).fill(0.9)], 0.5).audio;
    }
    const consuming = consumeWaveform(
      samples(),
      envelope,
      (message) => messages.push(message),
      () => 0,
    );
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(messages[0]?.type).toBe('peaks');
    if (messages[0]?.type !== 'error') {
      expect(messages[0]?.peaks[0]).toBe(0.5);
      expect(messages[0]?.peaks[512]).toBe(0);
    }
    release?.();
    await consuming;
    expect(messages.map((message) => message.type)).toEqual(['peaks', 'done']);
    if (messages[0]?.type !== 'error' && messages[1]?.type !== 'error') {
      expect(messages[0]?.peaks[512]).toBe(0);
      expect(messages[1]?.peaks[1023]).toBeCloseTo(0.9);
    }
  });

  it('closes resources on copy failure and propagates interrupted streams without a done message', async () => {
    const broken = sample([[1]]);
    vi.spyOn(broken.audio, 'copyTo').mockImplementation(() => {
      throw new Error('decode failed');
    });
    const envelope = new StreamingWaveform(1);
    expect(() => envelope.add(broken.audio)).toThrow('decode failed');
    expect(broken.close).toHaveBeenCalledOnce();
    const messages: WaveformMessage[] = [];
    async function* interrupted() {
      yield sample([[0.5]]).audio;
      throw new DOMException('Aborted', 'AbortError');
    }
    await expect(
      consumeWaveform(interrupted(), envelope, (message) => messages.push(message)),
    ).rejects.toThrow('Aborted');
    expect(messages.some((message) => message.type === 'done')).toBe(false);
  });

  it('flushes later computed peaks while EOF is held and stops updates after completion', async () => {
    vi.useFakeTimers();
    try {
      const messages: WaveformMessage[] = [];
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* samples() {
        yield sample([new Array<number>(256).fill(0.25)]).audio;
        yield sample([new Array<number>(256).fill(0.75)], 0.25).audio;
        await held;
        yield sample([new Array<number>(512).fill(0.5)], 0.5).audio;
      }
      const consuming = consumeWaveform(samples(), new StreamingWaveform(1), (message) =>
        messages.push(message),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(messages).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(50);
      expect(messages).toHaveLength(2);
      if (messages[1]?.type !== 'error') {
        expect(messages[1]?.peaks[400]).toBe(0.75);
        expect(messages[1]?.peaks[512]).toBe(0);
      }
      release?.();
      await consuming;
      expect(messages.map((message) => message.type)).toEqual(['peaks', 'peaks', 'done']);
      await vi.advanceTimersByTimeAsync(500);
      expect(messages).toHaveLength(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pending flush after a stream failure', async () => {
    vi.useFakeTimers();
    try {
      const messages: WaveformMessage[] = [];
      async function* samples() {
        yield sample([[0.25]]).audio;
        yield sample([[0.75]], 0.25).audio;
        throw new Error('network interrupted');
      }
      await expect(
        consumeWaveform(samples(), new StreamingWaveform(1), (message) => messages.push(message)),
      ).rejects.toThrow('network interrupted');
      await vi.advanceTimersByTimeAsync(500);
      expect(messages.map((message) => message.type)).toEqual(['peaks']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates a trailing publication failure without throwing from the timer callback', async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      async function* samples() {
        yield sample([[0.25]]).audio;
        yield sample([[0.75]], 0.25).audio;
        await held;
      }
      const publish = vi
        .fn()
        .mockImplementationOnce(() => {})
        .mockImplementation(() => {
          throw new Error('publication failed');
        });
      const consuming = consumeWaveform(samples(), new StreamingWaveform(1), publish);
      const rejected = expect(consuming).rejects.toThrow('publication failed');
      await vi.advanceTimersByTimeAsync(50);
      expect(publish).toHaveBeenCalledTimes(2);
      release?.();
      await rejected;
      await vi.advanceTimersByTimeAsync(500);
      expect(publish).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
