import { DomainError } from '@nickhosting/core';
import type { FileReadTiming, PterodactylOptions } from './adapter.js';
import { allowedOrigin, signedTarget } from './downloads.js';
import {
  PterodactylError,
  ResponseTooLargeError,
  readBounded,
  validatedBaseURL,
} from './transport.js';

/** Small bounded editor reads use the same private one-use Wings URLs as downloads.
 * Mutation/concurrency verification reads deliberately retain the native contents endpoint. */
export async function readEditorDownload(
  options: PterodactylOptions,
  signedURL: string,
  maxBytes: number,
  timing?: FileReadTiming,
): Promise<Uint8Array> {
  const origins = new Set([
    validatedBaseURL(options.baseURL).origin,
    ...(options.downloadOrigins ?? []).map((origin) => allowedOrigin(origin, ['http:', 'https:'])),
  ]);
  const target = signedTarget(signedURL, origins);
  const fetcher = options.fetcher ?? fetch;
  let response: Response;
  try {
    const request = () =>
      fetcher(target, {
        redirect: 'error',
        signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        headers: { 'Accept-Encoding': 'identity' },
      });
    response = timing ? await timing.measure('file.httpHeaders', request) : await request();
  } catch {
    throw new PterodactylError('unavailable', 'client', 'rejected');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PterodactylError(
      response.status === 404 ? 'not_found' : 'unavailable',
      'client',
      'rejected',
      response.status,
    );
  }
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding !== 'identity') {
    await response.body?.cancel();
    throw new PterodactylError('invalid_response', 'client', 'rejected');
  }
  try {
    const read = () => readBounded(response, maxBytes);
    const bytes = timing ? await timing.measure('file.bodyRead', read) : await read();
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) !== bytes.byteLength))
      throw new PterodactylError('invalid_response', 'client', 'rejected');
    return bytes;
  } catch (error) {
    if (error instanceof ResponseTooLargeError) throw new DomainError('validation_failed', 413);
    throw new PterodactylError('invalid_response', 'client', 'rejected');
  }
}
