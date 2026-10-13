import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { sevenZipViewerWorker } from './viewer-archive-worker.js';
import { ViewerFormatError } from './viewer-cache.js';

const require = createRequire(import.meta.url);
let activeWorkers = 0;
export async function runSevenZipViewer(
  path: string,
  options: {
    entry?: string;
    maximumOutputBytes: number;
    maximumInputBytes: number;
    maximumHeapBytes?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  },
): Promise<Uint8Array> {
  options.signal?.throwIfAborted();
  // A single shared decoder budget, not one 256MiB WASM heap for every HTTP request.
  if (activeWorkers >= 1) throw new ViewerFormatError('viewer_cache_busy');
  activeWorkers++;
  let worker: Worker | undefined;
  try {
    const module = require.resolve('sevenzip-wasm');
    worker = new Worker(`(${sevenZipViewerWorker.toString()})();`, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
      workerData: {
        path,
        module,
        wasm: join(dirname(module), 'sevenzip-wasm.wasm'),
        entry: options.entry,
        maximumOutputBytes: options.maximumOutputBytes,
        maximumInputBytes: options.maximumInputBytes,
        maximumHeapBytes: options.maximumHeapBytes ?? 256 * 1024 * 1024,
      },
    });
    const current = worker;
    return await new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new ViewerFormatError('viewer_archive_timeout')),
        options.timeoutMs ?? 10_000,
      );
      timer.unref();
      const abort = () =>
        reject(options.signal?.reason ?? new ViewerFormatError('viewer_session_closed'));
      options.signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      };
      current.once('message', (message: { error?: string; bytes?: Uint8Array }) => {
        cleanup();
        if (message.error || !message.bytes)
          reject(new ViewerFormatError(message.error ?? 'viewer_archive_invalid'));
        else resolve(message.bytes);
      });
      current.once('error', () => {
        cleanup();
        reject(new ViewerFormatError('viewer_archive_invalid'));
      });
      current.once('exit', () => {
        cleanup();
        reject(new ViewerFormatError('viewer_archive_invalid'));
      });
    });
  } finally {
    await worker?.terminate();
    activeWorkers--;
  }
}

/** -slt records are unambiguous only when paths have no control/newline characters. */
export function parseSevenZipListing(bytes: Uint8Array): Record<string, string>[] {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replaceAll('\r\n', '\n');
  const records: Record<string, string>[] = [];
  for (const block of text.replace(/^\n+|\n+$/g, '').split('\n\n')) {
    if (!block) continue;
    const item: Record<string, string> = Object.create(null);
    for (const line of block.split('\n')) {
      const separator = line.indexOf(' = ');
      if (separator < 1) throw new ViewerFormatError('viewer_archive_path');
      const key = line.slice(0, separator);
      if (Object.hasOwn(item, key)) throw new ViewerFormatError('viewer_archive_path');
      item[key] = line.slice(separator + 3);
    }
    if (!item.Path || !Object.hasOwn(item, 'Size'))
      throw new ViewerFormatError('viewer_archive_invalid');
    records.push(item);
  }
  return records;
}
