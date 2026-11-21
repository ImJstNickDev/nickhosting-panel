import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { dashboardStatusSchema } from './dashboard-ui.js';
import { readNativeBytes } from './native-response.js';
import {
  type OpenworldTelemetryData,
  type OpenworldTelemetryResource,
  openworldTelemetrySchemas,
} from './telemetry.js';

const authSchema = z.object({ required: z.boolean(), loopback: z.boolean(), canAct: z.boolean() });
const loginSchema = z.object({ token: z.string().regex(/^[\x21-\x7e]{1,4096}$/) });

export class OpenworldTokenExpired extends DomainError {
  constructor() {
    super('integration_unavailable');
  }
}

const telemetryLimits: Record<OpenworldTelemetryResource, number> = {
  status: 65_536,
  history: 256 * 1024,
  chunks: 256 * 1024,
  storage: 256 * 1024,
  // A full roster can contain 1000 players. Image bytes are fetched separately.
  players: 4 * 1024 * 1024,
  player: 256 * 1024,
};

function nativeClient(origin: string, signal: AbortSignal, fetcher: typeof fetch) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
  return async function request(
    path: 'auth' | 'login' | OpenworldTelemetryResource,
    method: 'GET' | 'POST',
    body?: string,
    token?: string,
    playerId?: number,
  ) {
    const url = new URL(`/api/live/${path}`, origin);
    if (path === 'player') {
      if (
        playerId === undefined ||
        !Number.isSafeInteger(playerId) ||
        playerId < 0 ||
        playerId > 0xffffffff
      )
        throw new DomainError('not_found');
      url.searchParams.set('id', String(playerId));
    }
    const response = await fetcher(url, {
      method,
      body,
      redirect: 'error',
      signal: timeout,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { 'X-OW-Token': token } : {}),
      },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      if (response.status === 401 && token) throw new OpenworldTokenExpired();
      if (response.status === 404 && path === 'player') throw new DomainError('not_found');
      throw new DomainError(response.status === 503 ? 'game_not_ready' : 'integration_unavailable');
    }
    const limit = path === 'auth' || path === 'login' ? 65_536 : telemetryLimits[path];
    const bytes = await readNativeBytes(response, limit);
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  };
}

async function authenticate(request: ReturnType<typeof nativeClient>, password: string) {
  const auth = authSchema.parse(await request('auth', 'GET'));
  if (auth.loopback || !auth.required || auth.canAct)
    throw new DomainError('integration_unavailable');
  const { token } = loginSchema.parse(await request('login', 'POST', JSON.stringify({ password })));
  return token;
}

/** The token is for the trusted proxy only. Never serialize it in browser responses. */
export async function openworldDashboardToken(
  origin: string,
  password: string,
  signal: AbortSignal,
  fetcher = fetch,
) {
  try {
    return await authenticate(nativeClient(origin, signal, fetcher), password);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}

export async function openworldDashboardStatus(
  origin: string,
  password: string,
  signal: AbortSignal,
  fetcher = fetch,
) {
  try {
    const request = nativeClient(origin, signal, fetcher);
    const token = await authenticate(request, password);
    return dashboardStatusSchema.parse(await request('status', 'GET', undefined, token));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}

export async function readOpenworldTelemetry<K extends OpenworldTelemetryResource>(
  origin: string,
  token: string,
  resource: K,
  signal: AbortSignal,
  playerId?: number,
  fetcher: typeof fetch = fetch,
): Promise<OpenworldTelemetryData[K]> {
  try {
    if (!Object.hasOwn(openworldTelemetrySchemas, resource) || !token)
      throw new DomainError('integration_unavailable');
    const request = nativeClient(origin, signal, fetcher);
    const raw = await request(resource, 'GET', undefined, token, playerId);
    const result = openworldTelemetrySchemas[resource].parse(raw);
    if (resource === 'player' && (!('id' in result) || result.id !== playerId))
      throw new DomainError('not_found');
    // The schema and output type are selected using the same resource key.
    return result as OpenworldTelemetryData[K];
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}
