import { expect, it, vi } from 'vitest';
import { OpenworldTokenExpired } from './dashboard-api.js';
import { openworldScreenshot, openworldScreenshots } from './screenshots.js';

const origin = 'http://fixture.test:24001';
const token = 'fixture-token';
const signal = new AbortController().signal;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAOgeONsAAAAASUVORK5CYII=',
  'base64',
);
const file = { name: 'conn3-1700000000000.png', bytes: png.length, mtimeMs: 1700000000000 };

it('projects and orders valid native screenshot records without attributing reused connection IDs', async () => {
  const later = { ...file, name: 'conn3-1700000000010.png', mtimeMs: file.mtimeMs + 10 };
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    Response.json({
      files: [
        { ...file, url: 'private', nameOfPlayer: 'unused' },
        later,
        { ...file, name: '../wrong.png' },
        { ...file, mtimeMs: 1e19 },
      ],
    }),
  );
  expect(await openworldScreenshots(origin, token, signal, fetcher)).toEqual({
    files: [later, file],
  });
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(`${origin}/api/live/screenshots`);
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'GET',
    redirect: 'error',
    headers: { 'X-OW-Token': token },
  });
});
it('only fetches screenshot basenames and returns bounded PNG data', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response(png, { headers: { 'content-type': 'image/png' } }));
  for (const name of ['../test.png', '/test.png', 'a.png?next=test', 'a%2f..png', 'test.svg']) {
    await expect(openworldScreenshot(origin, token, signal, name, fetcher)).rejects.toMatchObject({
      code: 'validation_failed',
    });
  }
  expect(fetcher).not.toHaveBeenCalled();
  expect(Buffer.from(await openworldScreenshot(origin, token, signal, file.name, fetcher))).toEqual(
    png,
  );
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(
    `${origin}/api/live/screenshot?name=${file.name}`,
  );
});
it('reports expiration distinctly and rejects unexpected content and oversized captures', async () => {
  const read = (response: Response) =>
    openworldScreenshot(origin, token, signal, file.name, async () => response);
  await expect(read(new Response(null, { status: 401 }))).rejects.toBeInstanceOf(
    OpenworldTokenExpired,
  );
  await expect(read(new Response(null, { status: 404 }))).rejects.toMatchObject({
    code: 'not_found',
  });
  const big = Buffer.from(png);
  big.writeUInt32BE(20000, 16);
  for (const response of [
    new Response(big, { headers: { 'content-type': 'image/png' } }),
    new Response(png, { headers: { 'content-type': 'image/png', 'content-length': '90000000' } }),
    new Response('<html/>', { headers: { 'content-type': 'text/html' } }),
  ])
    await expect(read(response)).rejects.toMatchObject({ code: 'integration_unavailable' });
});
