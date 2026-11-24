import { DomainError } from '@nickhosting/core';
import type { z } from 'zod';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readNativeBytes } from './native-response.js';

export type OpenworldNativeConnection = {
  origin: string;
  token: string;
  signal: AbortSignal;
  fetcher: typeof fetch;
};
const limits = { entities: 256 * 1024, space: 4 * 1024 * 1024, ovm: 2 * 1024 * 1024 };

export async function readNativeDiagnostic<S extends z.ZodType>(
  native: OpenworldNativeConnection,
  path: keyof typeof limits,
  schema: S,
  params?: { world: string; limit: string },
): Promise<z.output<S>> {
  if (!native.token) throw new DomainError('integration_unavailable');
  const url = new URL(`/api/live/${path}`, native.origin);
  if (params) url.search = new URLSearchParams(params).toString();
  try {
    const response = await native.fetcher(url, {
      redirect: 'error',
      signal: native.signal,
      headers: { accept: 'application/json', 'X-OW-Token': native.token },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new OpenworldTokenExpired();
      if (response.status === 404) throw new DomainError('game_request_unsupported');
      if (response.status === 503) throw new DomainError('game_not_ready');
      throw new DomainError('integration_unavailable');
    }
    const bytes = await readNativeBytes(response, limits[path]);
    return schema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}
