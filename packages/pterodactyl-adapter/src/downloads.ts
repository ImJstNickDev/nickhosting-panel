import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import {
  PterodactylError,
  parseInput,
  type TransportOptions,
  validatedBaseURL,
} from './transport.js';

export interface DownloadProxyOptions {
  maxBytes: number;
  signal?: AbortSignal;
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
export function createDownloadProxy(options: TransportOptions & { downloadOrigins?: string[] }) {
  const base = validatedBaseURL(options.baseURL);
  const origins = new Set([
    base.origin,
    ...(options.downloadOrigins ?? []).map((origin) => allowedOrigin(origin, ['http:', 'https:'])),
  ]);
  const fetcher = options.fetcher ?? fetch;
  return async (signedURL: string, input: DownloadProxyOptions): Promise<ProxiedDownload> => {
    parseInput(
      z
        .number()
        .int()
        .min(1)
        .max(1024 ** 3),
      input.maxBytes,
    );
    let response: Response;
    try {
      const target = new URL(signedURL);
      if (
        !['http:', 'https:'].includes(target.protocol) ||
        target.username ||
        target.password ||
        target.hash ||
        !origins.has(target.origin)
      )
        throw new Error('invalid_destination');
      response = await fetcher(target, {
        redirect: 'error',
        signal: AbortSignal.any([
          AbortSignal.timeout(120000),
          ...(input.signal ? [input.signal] : []),
        ]),
        // Signed URLs are backend-only. Never forward the Panel API Authorization header.
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error('download_failed');
      }
    } catch {
      throw new PterodactylError('unavailable', 'client', 'rejected');
    }
    const lengthHeader = response.headers.get('content-length');
    const length = lengthHeader === null ? undefined : Number(lengthHeader);
    if (
      length !== undefined &&
      (!Number.isSafeInteger(length) || length < 0 || length > input.maxBytes)
    ) {
      await response.body?.cancel();
      throw new PterodactylError('invalid_response', 'client', 'rejected');
    }
    const reader = response.body.getReader();
    let size = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) {
            controller.close();
            return;
          }
          size += item.value.byteLength;
          if (size > input.maxBytes) {
            await reader.cancel();
            throw new Error('download_too_large');
          }
          controller.enqueue(item.value);
        } catch {
          await reader.cancel();
          controller.error(new PterodactylError('unavailable', 'client', 'rejected'));
        }
      },
      cancel: () => reader.cancel(),
    });
    return {
      body,
      contentType: 'application/octet-stream',
      ...(length === undefined ? {} : { contentLength: length }),
    };
  };
}
