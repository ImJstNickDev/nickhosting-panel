import { expect, it, vi } from 'vitest';
import { isOpenworldSeedPath, readOpenworldSeed } from './seed-inspector.js';

it('limits seed access to inspector modules, textures and read-only generation routes', () => {
  for (const path of [
    '/inspector',
    '/inspector/',
    '/inspector/js/liveactions.js',
    '/inspector/vendor/three.module.js',
    '/pack/ow_stone.png',
    '/fonts/IBMPlexMono-Regular.ttf',
    '/api/feature-model',
    '/api/trees',
  ]) {
    expect(isOpenworldSeedPath(path, 'GET')).toBe(true);
    expect(isOpenworldSeedPath(path, 'POST')).toBe(false);
  }
  for (const path of [
    '/',
    '/api/live/auth',
    '/api/live/login',
    '/api/live/console',
    '/api/live/players',
    '/api/tile/extra',
    '/inspector/other.html',
    '/pack/server.json',
  ]) {
    expect(isOpenworldSeedPath(path, 'GET')).toBe(false);
  }
});

it('bounds catalog bytes and reports unavailable or malformed native responses', async () => {
  for (const [response, code] of [
    [new Response('', { status: 404 }), 'game_request_unsupported'],
    [new Response('null'), 'integration_unavailable'],
    [new Response('{}', { headers: { 'content-length': '3000000' } }), 'integration_unavailable'],
  ] as const) {
    const fetcher = vi.fn<typeof fetch>(async () => response);
    await expect(
      readOpenworldSeed('http://fixture.invalid', AbortSignal.timeout(2000), fetcher),
    ).rejects.toMatchObject({ code });
    expect(fetcher.mock.calls[0]?.[0].toString()).toBe('http://fixture.invalid/api/info');
  }
});
