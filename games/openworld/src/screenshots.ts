import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readNativeBytes, readNativePng } from './native-response.js';

export const screenshotName = z
  .string()
  .max(192)
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_. -]*\.png$/i);
const metadata = z.object({
  name: screenshotName,
  mtimeMs: z.number().int().nonnegative().max(8_640_000_000_000_000),
  bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type OpenworldScreenshot = z.output<typeof metadata>;
const index = z.object({ files: z.array(z.unknown()).max(16384) });

async function nativeResponse(
  url: URL,
  token: string,
  signal: AbortSignal,
  accept: string,
  fetcher: typeof fetch,
) {
  const response = await fetcher(url, {
    method: 'GET',
    signal: AbortSignal.any([signal, AbortSignal.timeout(5500)]),
    redirect: 'error',
    headers: { accept, 'X-OW-Token': token },
  });
  if (
    response.ok &&
    response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === accept
  )
    return response;
  await response.body?.cancel();
  if (response.status === 401) throw new OpenworldTokenExpired();
  throw new DomainError(response.status === 404 ? 'not_found' : 'integration_unavailable');
}

export async function openworldScreenshots(
  origin: string,
  token: string,
  signal: AbortSignal,
  fetcher = fetch,
) {
  try {
    const response = await nativeResponse(
      new URL('/api/live/screenshots', origin),
      token,
      signal,
      'application/json',
      fetcher,
    );
    const records = index.parse(
      JSON.parse(new TextDecoder().decode(await readNativeBytes(response, 2 * 1024 * 1024))),
    );
    const files: OpenworldScreenshot[] = [];
    for (const record of records.files) {
      const parsed = metadata.safeParse(record);
      if (parsed.success) files.push(parsed.data);
    }
    return { files: files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name)) };
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}

export async function openworldScreenshot(
  origin: string,
  token: string,
  signal: AbortSignal,
  name: string,
  fetcher = fetch,
) {
  if (!screenshotName.safeParse(name).success) throw new DomainError('validation_failed');
  const url = new URL('/api/live/screenshot', origin);
  url.searchParams.set('name', name);
  try {
    const response = await nativeResponse(url, token, signal, 'image/png', fetcher);
    return await readNativePng(response, 16 * 1024 * 1024, 8192, 8192 * 4320);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('integration_unavailable');
  }
}
