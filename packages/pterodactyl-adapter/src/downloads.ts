import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { createTransferGuard, type TransferOptions } from './transfer-guard.js';
import {
  PterodactylError,
  parseInput,
  type TransportOptions,
  validatedBaseURL,
} from './transport.js';

export interface DownloadProxyOptions extends TransferOptions {
  /** Optional policy bound. No fixed file or backup size limit is imposed. */
  maxBytes?: number;
}
export interface ProxiedDownload {
  body: ReadableStream<Uint8Array>;
  contentType: 'application/octet-stream';
  contentLength?: number;
}
export function allowedOrigin(value: string, protocols: string[]): string {
  try {
    const url = new URL(value);
    if (
      !protocols.includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    )
      throw new Error('invalid_origin');
    return url.origin;
  } catch {
    throw new DomainError('configuration_invalid');
  }
}
export function signedTarget(value: string, origins: Set<string>): URL {
  try {
    const target = new URL(value);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.hash ||
      !origins.has(target.origin)
    )
      throw new Error('invalid_destination');
    return target;
  } catch {
    throw new PterodactylError('unavailable', 'client', 'rejected');
  }
}
export function createDownloadProxy(options: TransportOptions & { downloadOrigins?: string[] }) {
  const origins = new Set([
    validatedBaseURL(options.baseURL).origin,
    ...(options.downloadOrigins ?? []).map((origin) => allowedOrigin(origin, ['http:', 'https:'])),
  ]);
  const fetcher = options.fetcher ?? fetch;
  return async (signedURL: string, input: DownloadProxyOptions): Promise<ProxiedDownload> => {
    const maxBytes = parseInput(
      z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
      input.maxBytes ?? Number.MAX_SAFE_INTEGER,
    );
    const target = signedTarget(signedURL, origins);
    const guard = createTransferGuard(input, 'rejected');
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await guard.run(() => guard.authorize(true));
      const response = await guard.run(() =>
        fetcher(target, {
          redirect: 'error',
          signal: guard.signal,
          // A signed URL is backend-only; no Panel API credential is forwarded.
          headers: { 'Accept-Encoding': 'identity' },
        }),
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw guard.failure();
      }
      const encoding = response.headers.get('content-encoding');
      const rawLength = response.headers.get('content-length');
      const length = rawLength === null ? undefined : Number(rawLength);
      if (
        (encoding && encoding !== 'identity') ||
        (rawLength !== null &&
          (!/^\d+$/.test(rawLength) || !Number.isSafeInteger(length) || (length ?? 0) > maxBytes))
      ) {
        await response.body.cancel();
        throw new PterodactylError('invalid_response', 'client', 'rejected');
      }
      reader = response.body.getReader();
      const source = reader;
      let size = 0;
      let done = false;
      let onAbort: () => void = () => {};
      const finish = () => {
        done = true;
        guard.signal.removeEventListener('abort', onAbort);
        guard.close();
      };
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            onAbort = () => {
              if (done) return;
              finish();
              void source.cancel().catch(() => {});
              controller.error(guard.failure());
            };
            guard.signal.addEventListener('abort', onAbort, { once: true });
            if (guard.signal.aborted) onAbort();
          },
          async pull(controller) {
            try {
              await guard.run(() => guard.authorize());
              const item = await guard.run(() => source.read());
              if (done) return;
              if (item.done) {
                if (length !== undefined && size !== length) throw guard.failure();
                await guard.run(() => guard.authorize(true));
                finish();
                controller.close();
                return;
              }
              size += item.value.byteLength;
              if (
                !Number.isSafeInteger(size) ||
                size > maxBytes ||
                (length !== undefined && size > length)
              )
                throw guard.failure();
              guard.progress();
              controller.enqueue(item.value);
            } catch {
              if (done) return;
              finish();
              guard.abort();
              void source.cancel().catch(() => {});
              controller.error(guard.failure());
            }
          },
          cancel() {
            finish();
            guard.abort();
            return source.cancel().catch(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      return {
        body,
        contentType: 'application/octet-stream',
        ...(length === undefined ? {} : { contentLength: length }),
      };
    } catch (error) {
      guard.close();
      guard.abort();
      void reader?.cancel().catch(() => {});
      if (error instanceof PterodactylError) throw error;
      throw guard.failure();
    }
  };
}
