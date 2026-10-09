import { DomainError } from '@nickhosting/core';
import { z } from 'zod';

/** M1 connection validation only. No lifecycle, allocation or mutation operations. */
export async function validateConnection(
  input: { baseURL: string; applicationKey: string; clientKey?: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(input.baseURL);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new DomainError('validation_failed');
  const checks: [string, string][] = [['api/application/nodes?per_page=1', input.applicationKey]];
  if (input.clientKey) checks.push(['api/client?per_page=1', input.clientKey]);
  for (const [path, key] of checks) {
    if (!key.trim() || key.length > 4096) throw new DomainError('validation_failed');
    try {
      const response = await fetcher(new URL(path, `${url.toString().replace(/\/$/, '')}/`), {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.pterodactyl.v1+json' },
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('connection rejected');
      // Bound response before parsing, and never surface upstream bodies or credentials.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('missing response');
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 1_048_576) throw new Error('response too large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      z.object({ object: z.literal('list'), data: z.array(z.unknown()) }).parse(data);
    } catch {
      throw new DomainError('integration_unavailable');
    }
  }
}
