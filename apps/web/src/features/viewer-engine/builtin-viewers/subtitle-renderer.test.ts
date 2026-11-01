import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSubtitleRenderer } from './subtitle-renderer.js';
import type { SubtitleTrack } from './subtitle-source.js';

const mock = vi.hoisted(() => ({
  draw: vi.fn(),
  setTrack: vi.fn(),
  processChunk: vi.fn(),
  destroy: vi.fn(),
  terminate: vi.fn(),
}));
vi.mock('jassub', () => ({
  default: class {
    ready = Promise.resolve();
    renderer = {
      getStyles: async () => [],
      setTrack: mock.setTrack,
      processChunk: mock.processChunk,
    };
    _worker = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      terminate: mock.terminate,
    };
    manualRender = mock.draw;
    destroy = mock.destroy;
  },
}));
vi.mock('jassub/dist/worker/worker.js?worker&url', () => ({ default: '/worker.js' }));
vi.mock('jassub/dist/wasm/jassub-worker.wasm?url', () => ({ default: '/ass.wasm' }));
vi.mock('jassub/dist/wasm/jassub-worker-modern.wasm?url', () => ({ default: '/modern.wasm' }));
vi.mock('jassub/dist/default.woff2?url', () => ({ default: '/fallback.woff2' }));

const track: SubtitleTrack = {
  id: 'ass',
  name: 'ASS',
  language: 'en',
  codec: 'S_TEXT/ASS',
  format: 'ass',
  supported: true,
  default: false,
  forced: false,
  header: '[Script Info]\nScriptType: v4.00+',
};
const never = () => new Promise<void>(() => {});

function environment(width = 0) {
  const media = Object.assign(new EventTarget(), {
    currentTime: 2,
    videoWidth: width,
    videoHeight: width ? 180 : 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 320, height: 180 }),
    requestVideoFrameCallback: vi.fn(() => 1),
    cancelVideoFrameCallback: vi.fn(),
  });
  const container = {
    appendChild: vi.fn(),
    getBoundingClientRect: media.getBoundingClientRect,
  };
  const onError = vi.fn();
  return {
    media: media as unknown as HTMLVideoElement,
    container: container as unknown as HTMLElement,
    track,
    onError,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  for (const operation of [mock.draw, mock.setTrack, mock.processChunk, mock.destroy])
    operation.mockResolvedValue(undefined);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'document',
    Object.assign(new EventTarget(), {
      createElement: () => ({ style: { setProperty() {} }, remove() {} }),
    }),
  );
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ASS worker lifecycle', () => {
  it('rejects a hung window batch, reports failure once, and terminates a hung cleanup', async () => {
    mock.processChunk.mockImplementation(never);
    mock.destroy.mockImplementation(never);
    const options = environment();
    const renderer = await createSubtitleRenderer(options);
    const result = renderer.setWindow({
      start: 0,
      end: 10,
      cues: [{ id: '1', start: 1, end: 4, text: '0,0,Default,,0,0,0,,Hello' }],
    });
    const assertion = expect(result).rejects.toThrow('Subtitle rendering timed out');
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    expect(options.onError).toHaveBeenCalledTimes(1);
    expect(options.media.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
    expect(mock.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.terminate).toHaveBeenCalledTimes(1);
    renderer.destroy();
    expect(mock.destroy).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled frame render without queuing an unbounded sequence of frames', async () => {
    mock.draw.mockImplementation(never);
    const options = environment(320);
    const renderer = await createSubtitleRenderer(options);
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 30; index++) options.media.dispatchEvent(new Event('timeupdate'));
    expect(mock.draw).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(options.onError).toHaveBeenCalledTimes(1);
    expect(mock.terminate).toHaveBeenCalledTimes(1);
    expect(mock.draw).toHaveBeenCalledTimes(1);
    renderer.destroy();
  });

  it('terminates after a bounded grace period even when normal destroy never resolves', async () => {
    mock.destroy.mockImplementation(never);
    const renderer = await createSubtitleRenderer(environment());
    renderer.destroy();
    expect(mock.destroy).toHaveBeenCalledTimes(1);
    expect(mock.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(mock.terminate).toHaveBeenCalledTimes(1);
  });
});
