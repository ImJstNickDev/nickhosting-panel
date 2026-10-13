import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { sevenZipViewerWorker } from './viewer-archive-worker.js';
import { ViewerFormatError } from './viewer-cache.js';

const require = createRequire(import.meta.url);
let activeWorkers = 0;
interface SevenZipViewerOptions {
  entry?: string;
  maximumOutputBytes: number;
  maximumInputBytes: number;
  maximumHeapBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Bounded chunks and an acknowledgement gate keep decoder output under consumer backpressure. */
export function streamSevenZipViewer(
  path: string,
  options: SevenZipViewerOptions,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  let stop: (() => Promise<void>) | undefined;
  let acknowledge: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      options.signal?.throwIfAborted();
      // One shared decoder budget: V8 resourceLimits alone cannot constrain WebAssembly memory.
      if (activeWorkers >= 1) throw new ViewerFormatError('viewer_cache_busy');
      activeWorkers++;
      let worker: Worker;
      const gate = new Int32Array(new SharedArrayBuffer(4));
      try {
        const module = require.resolve('sevenzip-wasm');
        worker = new Worker(`(${sevenZipViewerWorker.toString()})();`, {
          eval: true,
          trackUnmanagedFds: true,
          resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
          workerData: {
            path,
            module,
            wasm: join(dirname(module), 'sevenzip-wasm.wasm'),
            entry: options.entry,
            maximumOutputBytes: options.maximumOutputBytes,
            maximumInputBytes: options.maximumInputBytes,
            maximumHeapBytes: options.maximumHeapBytes ?? 256 * 1024 * 1024,
            gate: gate.buffer,
          },
        });
      } catch (error) {
        activeWorkers--;
        throw error;
      }
      let finished = false;
      let stopping: Promise<void> | undefined;
      let awaitingAck = false;
      acknowledge = () => {
        if (!awaitingAck) return;
        awaitingAck = false;
        Atomics.store(gate, 0, 1);
        Atomics.notify(gate, 0);
      };
      const abort = () =>
        fail(options.signal?.reason ?? new ViewerFormatError('viewer_session_closed'));
      const timer = setTimeout(
        () => fail(new ViewerFormatError('viewer_archive_timeout')),
        options.timeoutMs ?? 30_000,
      );
      timer.unref();
      stop = () => {
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        stopping ??= worker.terminate().then(() => {
          activeWorkers--;
        });
        return stopping;
      };
      const fail = (error: unknown) => {
        if (finished) return;
        void stop?.().then(() => {
          if (!cancelled) controller.error(error);
        });
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      worker.on('message', (message: { error?: string; bytes?: Uint8Array; done?: boolean }) => {
        if (finished) return;
        if (message.error) return fail(new ViewerFormatError(message.error));
        if (message.done) {
          // Release the decoder slot before consumers can start their next operation.
          void stop?.().then(() => {
            if (!cancelled) controller.close();
          });
        } else if (message.bytes) {
          awaitingAck = true;
          controller.enqueue(message.bytes);
          if ((controller.desiredSize ?? 0) > 0) acknowledge?.();
        } else fail(new ViewerFormatError('viewer_archive_invalid'));
      });
      worker.once('error', () => fail(new ViewerFormatError('viewer_archive_invalid')));
      worker.once('exit', () => fail(new ViewerFormatError('viewer_archive_invalid')));
      if (options.signal?.aborted) abort();
    },
    pull() {
      acknowledge?.();
    },
    async cancel() {
      cancelled = true;
      await stop?.();
    },
  });
}

export async function runSevenZipViewer(
  path: string,
  options: SevenZipViewerOptions,
): Promise<Uint8Array> {
  return new Uint8Array(await new Response(streamSevenZipViewer(path, options)).arrayBuffer());
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
