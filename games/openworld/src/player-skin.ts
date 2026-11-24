import { DomainError } from '@nickhosting/core';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readNativePng } from './native-response.js';

const maxSkinBytes = 512 * 1024;

export async function readOpenworldPlayerSkin(
  origin: string,
  token: string,
  playerId: number,
  view: 'head' | 'body',
  hash: string,
  signal: AbortSignal,
  fetcher = fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isInteger(playerId) ||
    playerId < 0 ||
    playerId > 0xffffffff ||
    !/^[a-f0-9]{8}$/i.test(hash) ||
    (view !== 'head' && view !== 'body')
  )
    throw new DomainError('validation_failed');
  const url = new URL('/api/live/skin', origin);
  url.search = new URLSearchParams({
    id: String(playerId),
    h: hash.toLowerCase(),
    view,
  }).toString();
  try {
    const response = await fetcher(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(3500)]),
      redirect: 'error',
      headers: { accept: 'image/png', 'X-OW-Token': token },
    });
    if (
      !response.ok ||
      response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/png'
    ) {
      await response.body?.cancel();
      if (response.status === 401) throw new OpenworldTokenExpired();
      throw new DomainError(response.status === 404 ? 'not_found' : 'integration_unavailable');
    }
    return await readNativePng(response, maxSkinBytes, 1024, 1024 * 1024);
  } catch (error) {
    if (error instanceof DomainError || error instanceof OpenworldTokenExpired) throw error;
    throw new DomainError('integration_unavailable');
  }
}
