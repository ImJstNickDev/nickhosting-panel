import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { dashboardStatusSchema } from './dashboard-ui.js';

const authSchema = z.object({ required: z.boolean(), loopback: z.boolean(), canAct: z.boolean() });
const loginSchema = z.object({ token: z.string().regex(/^[\x21-\x7e]{1,4096}$/) });

/** Only three fixed native requests. No browser-chosen hosts, paths, headers or commands. */
export async function openworldDashboardStatus(
  origin: string,
  password: string,
  signal: AbortSignal,
  fetcher = fetch,
) {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(3500)]);
  async function request(
    path: 'auth' | 'login' | 'status',
    method: 'GET' | 'POST',
    body?: string,
    token?: string,
  ) {
    const response = await fetcher(new URL(`/api/live/${path}`, origin), {
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
      throw new DomainError(response.status === 503 ? 'game_not_ready' : 'integration_unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 65536) throw new DomainError('integration_unavailable');
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } finally {
      await reader.cancel();
    }
  }
  try {
    const auth = authSchema.parse(await request('auth', 'GET'));
    if (auth.loopback || !auth.required || auth.canAct)
      throw new DomainError('integration_unavailable');
    const { token } = loginSchema.parse(
      await request('login', 'POST', JSON.stringify({ password })),
    );
    return dashboardStatusSchema.parse(await request('status', 'GET', undefined, token));
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}
