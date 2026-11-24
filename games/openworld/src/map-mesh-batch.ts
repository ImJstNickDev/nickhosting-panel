import { DomainError } from '@nickhosting/core';

export const maxMeshBatchColumns = 16;
const maxFrameBytes = 8 * 1024 * 1024;
type MeshCell = readonly [number, number];
type Asset = Uint8Array<ArrayBuffer> | null;

/** NHMB v1 frames validated OWM1 columns in request order without copying their
 * payloads into a second multi-megabyte buffer. Authorization is checked by
 * the caller again before the HTTP layer is allowed to return this stream. */
export async function readMeshBatch(
  cells: readonly MeshCell[],
  signal: AbortSignal,
  load: (cell: MeshCell, signal: AbortSignal) => Promise<Asset>,
) {
  if (!cells.length || cells.length > maxMeshBatchColumns)
    throw new DomainError('validation_failed');
  const stop = new AbortController(),
    abort = AbortSignal.any([signal, stop.signal]);
  const results: Asset[] = Array(cells.length).fill(null);
  let next = 0,
    length = 8 + cells.length * 12;
  async function worker() {
    while (next < cells.length && !abort.aborted) {
      const i = next++,
        cell = cells[i];
      if (!cell) throw new DomainError('validation_failed');
      const data = await load(cell, abort);
      length += data?.byteLength ?? 0;
      if (length > maxFrameBytes) throw new DomainError('validation_failed', 413);
      results[i] = data;
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(3, cells.length) }, worker));
    if (signal.aborted) throw new DomainError('game_not_ready');
  } finally {
    stop.abort();
  }
  const header = new Uint8Array(8),
    h = new DataView(header.buffer);
  h.setUint32(0, 0x4e484d42);
  h.setUint16(4, 1, true);
  h.setUint16(6, cells.length, true);
  const chunks = [header];
  for (const [k, [i, j]] of cells.entries()) {
    const data = results[k];
    const record = new Uint8Array(12),
      v = new DataView(record.buffer);
    v.setInt32(0, i, true);
    v.setInt32(4, j, true);
    v.setUint32(8, data?.byteLength ?? 0, true);
    chunks.push(record);
    if (data) chunks.push(data);
  }
  let index = 0;
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      if (index >= chunks.length) {
        controller.close();
        chunks.length = 0;
      }
    },
    cancel() {
      chunks.length = 0;
    },
  });
  return { body, length };
}
