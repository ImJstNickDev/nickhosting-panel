import { expect, it, vi } from 'vitest';
import { openworldDashboardToken, readOpenworldDashboardStatusWithToken } from './dashboard-api.js';

it('requests only authenticated native status and projects just the tenant-facing metrics', async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ loopback: false, required: true, canAct: false }))
    .mockResolvedValueOnce(Response.json({ token: 'native-session' }))
    .mockResolvedValueOnce(
      Response.json({
        tps: 20.1,
        players: { online: 2, slots: 8, connecting: 1 },
        memory: { rssMB: 70.2 },
        chat: ['private'],
        net: { internal: true },
      }),
    );
  const origin = 'http://10.2.3.4:4000';
  const signal = new AbortController().signal;
  const token = await openworldDashboardToken(origin, 'instance-only', signal, fetcher);
  const status = await readOpenworldDashboardStatusWithToken(origin, token, signal, fetcher);
  expect(status).toEqual({ tps: 20.1, players: { online: 2, slots: 8 }, memory: { rssMB: 70.2 } });
  expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
    '/api/live/auth',
    '/api/live/login',
    '/api/live/status',
  ]);
  expect(fetcher.mock.calls[2]?.[1]?.headers).toMatchObject({ 'X-OW-Token': 'native-session' });
  expect(fetcher.mock.calls.every(([, options]) => options?.redirect === 'error')).toBe(true);
});
it.each([
  { loopback: true, required: false, canAct: true },
  { loopback: false, required: false, canAct: false },
])(
  'declines an unprotected or privileged native endpoint before sending credentials',
  async (auth) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(auth));
    await expect(
      openworldDashboardToken(
        'http://10.2.3.4:4000',
        'instance-only',
        new AbortController().signal,
        fetcher,
      ),
    ).rejects.toThrow('integration_unavailable');
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it('recognizes native HTTP startup before the world snapshot is ready', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(
    readOpenworldDashboardStatusWithToken(
      'http://10.2.3.4:4000',
      'native-session',
      new AbortController().signal,
      fetcher,
    ),
  ).rejects.toThrow('game_not_ready');
});
