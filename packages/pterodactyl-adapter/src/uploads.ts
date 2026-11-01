import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { allowedOrigin, signedTarget } from './downloads.js';
import { createTransferGuard, type TransferOptions } from './transfer-guard.js';
import { PterodactylError, relativePath, type TransportOptions } from './transport.js';
import { uploadNotDispatched } from './upload-dispatch.js';

export interface UploadProxyOptions extends TransferOptions {
  body: ReadableStream<Uint8Array>;
  contentLength: number;
  maxBytes: number;
}
/** Wings 1.x expects multipart field `files` and a directory query. Generate one
 * part incrementally; never accumulate a browser upload in FormData or memory. */
export function createUploadProxy(options: TransportOptions & { uploadOrigins?: string[] }) {
  const origins = new Set(
    (options.uploadOrigins ?? []).map((origin) => allowedOrigin(origin, ['http:', 'https:'])),
  );
  const fetcher = options.fetcher ?? fetch;
  return async (signedURL: string, path: string, input: UploadProxyOptions): Promise<void> => {
    let dispatched = false;
    try {
      const validatedPath = relativePath(path);
      if (
        !Number.isSafeInteger(input.contentLength) ||
        input.contentLength < 0 ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 0 ||
        input.contentLength > input.maxBytes
      )
        throw new DomainError('validation_failed', 413);
      const target = signedTarget(signedURL, origins);
      if (!target.pathname.endsWith('/upload/file'))
        throw new PterodactylError('invalid_response', 'client', 'rejected');
      const slash = validatedPath.lastIndexOf('/');
      target.searchParams.set('directory', validatedPath.slice(0, slash) || '/');
      const filename = validatedPath.slice(slash + 1).replace(/["\\]/g, '\\$&');
      const boundary = `nh-${randomUUID()}`;
      const prefix = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      );
      const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
      const length = prefix.length + input.contentLength + suffix.length;
      if (!Number.isSafeInteger(length)) throw new DomainError('validation_failed');
      // Browser cancellation finishes a valid, shortened multipart body and waits
      // for Wings to close its staging writer. The caller MUST
      // supply an isolated staging path, not an existing destination.
      const guard = createTransferGuard({ ...input, signal: undefined }, 'unknown');
      let reader: ReadableStreamDefaultReader<Uint8Array>;
      try {
        reader = input.body.getReader();
      } catch (error) {
        guard.close();
        throw error;
      }
      let sentPrefix = false;
      let complete = false;
      let closed = false;
      let cancelled = false;
      let size = 0;
      let output: ReadableStreamDefaultController<Uint8Array> | undefined;
      const stream = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            output = controller;
          },
          async pull(controller) {
            try {
              if (closed) return;
              await guard.run(() => guard.authorize());
              if (closed) return;
              if (!sentPrefix) {
                sentPrefix = true;
                controller.enqueue(prefix);
                return;
              }
              let item: ReadableStreamReadResult<Uint8Array>;
              try {
                item = await guard.run(() => reader.read());
              } catch (error) {
                // An HTTP disconnect can error the body just before its AbortSignal
                // is delivered. Let that same I/O turn finish before classifying it.
                if (!guard.signal.aborted && input.signal) {
                  await new Promise<void>((resolve) => setImmediate(resolve));
                  if (input.signal.aborted) cancelFromBrowser();
                }
                throw error;
              }
              if (closed) return;
              if (item.done) {
                if (size !== input.contentLength) throw guard.failure();
                await guard.run(() => guard.authorize(true));
                if (closed) return;
                controller.enqueue(suffix);
                complete = true;
                closed = true;
                controller.close();
              } else {
                size += item.value.byteLength;
                if (
                  !Number.isSafeInteger(size) ||
                  size > input.contentLength ||
                  size > input.maxBytes
                )
                  throw guard.failure();
                controller.enqueue(item.value);
              }
              guard.progress();
            } catch {
              if (cancelled && closed) return;
              guard.abort();
              void reader.cancel().catch(() => {});
              closed = true;
              controller.error(guard.failure());
            }
          },
          cancel() {
            closed = true;
            guard.abort();
            return reader.cancel().catch(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      const cancel = () => {
        void reader.cancel().catch(() => {});
      };
      const cancelFromBrowser = () => {
        if (complete || cancelled) return;
        if (!dispatched) {
          guard.abort();
          return;
        }
        cancelled = true;
        cancel();
        if (!closed) {
          closed = true;
          // The destination is an isolated stage. A valid shortened multipart
          // lets old/new Wings close its writer and acknowledge completion before
          // the caller removes the stage; never depend on a proxy/error response.
          if (!sentPrefix) {
            sentPrefix = true;
            output?.enqueue(prefix);
          }
          output?.enqueue(suffix);
          output?.close();
        }
        guard.progress();
      };
      guard.signal.addEventListener('abort', cancel, { once: true });
      input.signal?.addEventListener('abort', cancelFromBrowser, { once: true });
      if (input.signal?.aborted) cancelFromBrowser();
      try {
        await guard.run(() => guard.authorize(true));
        const init: RequestInit & { duplex: 'half' } = {
          method: 'POST',
          redirect: 'error',
          signal: guard.signal,
          duplex: 'half',
          body: stream,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
          },
        };
        const response = await guard.run(() => {
          // Invocation is the safety boundary, including a synchronous fetch throw.
          dispatched = true;
          return fetcher(target, init);
        });
        // Never expose provider response bodies or mistake an early response for a complete upload.
        await response.body?.cancel();
        if (!response.ok)
          throw new PterodactylError('unavailable', 'client', 'unknown', response.status);
        if (cancelled)
          throw new PterodactylError('unavailable', 'client', 'rejected', response.status);
        if (!complete) throw guard.failure();
        await guard.run(() => guard.authorize(true));
      } catch (error) {
        guard.abort();
        if (error instanceof PterodactylError) throw error;
        throw guard.failure();
      } finally {
        guard.close();
        guard.signal.removeEventListener('abort', cancel);
        input.signal?.removeEventListener('abort', cancelFromBrowser);
        void reader.cancel().catch(() => {});
        void stream.cancel().catch(() => {});
      }
    } catch (error) {
      if (!dispatched) {
        void input.body.cancel().catch(() => {});
        throw uploadNotDispatched(error);
      }
      throw error;
    }
  };
}
