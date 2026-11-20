import { describe, expect, it, vi } from 'vitest';
import { readSectionWithPreview } from './game-section-observation.js';

describe('prepared section observation', () => {
  it('starts both reads together and publishes a cold preview before the current result', async () => {
    const current = Promise.withResolvers<string>();
    const publish = vi.fn();
    const work = readSectionWithPreview(
      new AbortController().signal,
      () => current.promise,
      async () => null,
      publish,
    );
    await Promise.resolve();
    expect(publish).toHaveBeenCalledExactlyOnceWith(null);
    current.resolve('current');
    expect(await work).toBe('current');
  });
  it('returns a fast current read and fences a late cached result', async () => {
    const preview = Promise.withResolvers<string>();
    const publish = vi.fn();
    expect(
      await readSectionWithPreview(
        new AbortController().signal,
        async () => 'current',
        () => preview.promise,
        publish,
      ),
    ).toBe('current');
    preview.resolve('old');
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });
  it('aborts the other read on denial and never paints a cancelled preview', async () => {
    const current = Promise.withResolvers<string>();
    const preview = Promise.withResolvers<string>();
    const publish = vi.fn();
    const read = vi.fn((_signal: AbortSignal) => current.promise);
    const work = readSectionWithPreview(
      new AbortController().signal,
      read,
      () => preview.promise,
      publish,
    );
    preview.reject(new Error('forbidden'));
    await expect(work).rejects.toThrow('forbidden');
    expect(read.mock.calls[0]?.[0].aborted).toBe(true);
    current.resolve('old');
    expect(publish).not.toHaveBeenCalled();
  });
});
