import { DomainError } from '@nickhosting/core';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readNativeBytes } from './native-response.js';

const signature = [137, 80, 78, 71, 13, 10, 26, 10];
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
    const bytes = await readNativeBytes(response, maxSkinBytes);
    if (bytes.byteLength < 45 || !signature.every((value, i) => bytes[i] === value))
      throw new DomainError('integration_unavailable');
    const header = new DataView(bytes.buffer);
    const width = header.getUint32(16);
    const height = header.getUint32(20);
    if (
      header.getUint32(8) !== 13 ||
      header.getUint32(12) !== 0x49484452 ||
      width < 1 ||
      height < 1 ||
      width > 1024 ||
      height > 1024
    )
      throw new DomainError('integration_unavailable');
    return bytes;
  } catch (error) {
    if (error instanceof DomainError || error instanceof OpenworldTokenExpired) throw error;
    throw new DomainError('integration_unavailable');
  }
}
