import { randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { allowedOrigin, signedTarget } from './downloads.js';
import { createTransferGuard, type TransferOptions } from './transfer-guard.js';
import { PterodactylError, relativePath, type TransportOptions } from './transport.js';

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
    const guard = createTransferGuard(input, 'unknown');
    const reader = input.body.getReader();
    let sentPrefix = false;
    let complete = false;
    let size = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          try {
            await guard.run(() => guard.authorize());
            if (!sentPrefix) {
              sentPrefix = true;
              controller.enqueue(prefix);
              return;
            }
            const item = await guard.run(() => reader.read());
            if (item.done) {
              if (size !== input.contentLength) throw guard.failure();
              await guard.run(() => guard.authorize(true));
              controller.enqueue(suffix);
              controller.close();
              complete = true;
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
            guard.abort();
            void reader.cancel().catch(() => {});
            controller.error(guard.failure());
          }
        },
        cancel() {
          guard.abort();
          return reader.cancel().catch(() => {});
        },
      },
      { highWaterMark: 0 },
    );
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    guard.signal.addEventListener('abort', cancel, { once: true });
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
          'Content-Length': String(length),
        },
      };
      const response = await guard.run(() => fetcher(target, init));
      // Never expose provider response bodies or mistake an early response for a complete upload.
      await response.body?.cancel();
      if (!response.ok || !complete) throw guard.failure();
      await guard.run(() => guard.authorize(true));
    } catch {
      guard.abort();
      throw guard.failure();
    } finally {
      guard.close();
      guard.signal.removeEventListener('abort', cancel);
      void reader.cancel().catch(() => {});
      void stream.cancel().catch(() => {});
    }
  };
}
