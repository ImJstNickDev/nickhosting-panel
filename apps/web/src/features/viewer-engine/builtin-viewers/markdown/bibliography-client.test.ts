import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadQuillBibliography } from './bibliography-client.js';

class WorkerFixture {
  static current: WorkerFixture;
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    WorkerFixture.current = this;
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('bibliography worker lifecycle', () => {
  it('gives cold module startup its own budget without extending the parsing budget', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', WorkerFixture);
    const result = loadQuillBibliography('[]', 'json', 'numeric', new AbortController().signal);
    const worker = WorkerFixture.current;
    await vi.advanceTimersByTimeAsync(6000);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.postMessage).not.toHaveBeenCalled();
    worker.onmessage?.({ data: { ready: true } });
    expect(worker.postMessage).toHaveBeenCalledWith({
      source: '[]',
      format: 'json',
      style: 'numeric',
    });
    const rejected = expect(result).rejects.toMatchObject({
      messageKey: 'quill.bibliographyLimit',
    });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('terminates on completion or cancellation and bounds workers that never initialize', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', WorkerFixture);
    const controller = new AbortController();
    const result = loadQuillBibliography('[]', 'json', 'numeric', controller.signal);
    WorkerFixture.current.onmessage?.({ data: { ready: true } });
    WorkerFixture.current.onmessage?.({ data: { result: { entries: [] } } });
    await expect(result).resolves.toEqual({ entries: [] });
    expect(WorkerFixture.current.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);

    const cancelled = loadQuillBibliography('[]', 'json', 'numeric', controller.signal);
    const rejection = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    expect(vi.getTimerCount()).toBe(0);

    const stalled = loadQuillBibliography('[]', 'json', 'numeric', new AbortController().signal);
    const timeout = expect(stalled).rejects.toMatchObject({
      messageKey: 'quill.bibliographyLimit',
    });
    await vi.advanceTimersByTimeAsync(20_000);
    await timeout;
    expect(WorkerFixture.current.terminate).toHaveBeenCalledOnce();
  });
});
