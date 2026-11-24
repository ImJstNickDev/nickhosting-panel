import { expect, it, vi } from 'vitest';
import { readMeshBatch } from './map-mesh-batch.js';

it('refuses an oversized NHMB before collecting the whole selection and cancels remaining work', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024),
    signals: AbortSignal[] = [];
  const read = vi.fn(async (_: readonly [number, number], signal: AbortSignal) => {
    signals.push(signal);
    return bytes;
  });
  const cells = Array.from({ length: 16 }, (_, i) => [i, 0] as const);
  await expect(readMeshBatch(cells, new AbortController().signal, read)).rejects.toMatchObject({
    status: 413,
    code: 'validation_failed',
  });
  expect(read.mock.calls.length).toBeLessThan(16);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});
