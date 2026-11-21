import { expect, it, vi } from 'vitest';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { readOpenworldPlayerSkin } from './player-skin.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7R8AAAAASUVORK5CYII=',
  'base64',
);
function read(response: Response) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const result = readOpenworldPlayerSkin(
    'http://game.internal:22111',
    'connection-token',
    7,
    'head',
    'faceb00c',
    new AbortController().signal,
    fetcher,
  );
  return { result, fetcher };
}

it('reads the game-rendered skin only from the verified origin and fixed endpoint', async () => {
  const { result, fetcher } = read(new Response(png, { headers: { 'content-type': 'image/png' } }));
  expect(Buffer.from(await result)).toEqual(png);
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    'http://game.internal:22111/api/live/skin?id=7&h=faceb00c&view=head',
  );
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    redirect: 'error',
    headers: { 'X-OW-Token': 'connection-token' },
  });
});
it('reports an expired native session distinctly from an absent skin', async () => {
  await expect(read(new Response(null, { status: 401 })).result).rejects.toBeInstanceOf(
    OpenworldTokenExpired,
  );
  await expect(read(new Response(null, { status: 404 })).result).rejects.toMatchObject({
    code: 'not_found',
  });
});
it('rejects mislabeled images, oversized pixels and oversized chunked bodies', async () => {
  const huge = Buffer.from(png);
  huge.writeUInt32BE(10000, 16);
  for (const response of [
    new Response('<html>', { headers: { 'content-type': 'image/png' } }),
    new Response(png, { headers: { 'content-type': 'text/html' } }),
    new Response(huge, { headers: { 'content-type': 'image/png' } }),
    new Response(new Uint8Array(512 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
  ])
    await expect(read(response).result).rejects.toMatchObject({ code: 'integration_unavailable' });
});
