import { afterEach, expect, it, vi } from 'vitest';
import { queryClient } from '../../../api/client.js';
import { gamePrefixCacheLimits, readGameViewerPrefix } from './game-prefix-cache.js';

const source = { path: 'world.sav', name: 'world.sav', size: 100 };
const options = () => ({
  source,
  serverId: 'server',
  identity: 'user',
  maxBytes: 32,
  signal: new AbortController().signal,
});
const meta = (revision = 'a'.repeat(64)) =>
  new Response(JSON.stringify({ revision, size: 100, mtimeMs: 1 }));
const body = (value = 1) =>
  new Response(new Uint8Array(32).fill(value), {
    status: 206,
    headers: { 'content-range': 'bytes 0-31/100', 'content-length': '32' },
  });
afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

it('revalidates authority each time but shares metadata bytes for unchanged revision', async () => {
  const fetcher = vi.fn(async (url: string) => (url.includes('/content?') ? body() : meta()));
  vi.stubGlobal('fetch', fetcher);
  const first = await readGameViewerPrefix(options());
  const second = await readGameViewerPrefix(options());
  expect(second).toBe(first);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/content?'))).toHaveLength(1);
  expect(fetcher.mock.calls.filter(([url]) => !url.includes('/content?'))).toHaveLength(2);
});
it('pins replacement reads and cannot serve cached bytes after permission refusal', async () => {
  let revision = 'a'.repeat(64),
    denied = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes('/content?'))
      return denied
        ? new Response(JSON.stringify({ code: 'forbidden' }), { status: 403 })
        : meta(revision);
    expect(init?.headers).toMatchObject({ 'If-Match': `"${revision}"` });
    return body(revision.startsWith('a') ? 1 : 2);
  });
  vi.stubGlobal('fetch', fetcher);
  expect((await readGameViewerPrefix(options()))[0]).toBe(1);
  revision = 'b'.repeat(64);
  expect((await readGameViewerPrefix(options()))[0]).toBe(2);
  denied = true;
  await expect(readGameViewerPrefix(options())).rejects.toMatchObject({ status: 403 });
});
it('does not merge servers, actors, archive chains or selected members', async () => {
  const fetcher = vi.fn(async (url: string) => (url.includes('/content?') ? body() : meta()));
  vi.stubGlobal('fetch', fetcher);
  for (const overrides of [
    {},
    { serverId: 'other' },
    { identity: 'other' },
    { source: { ...source, entry: 'world.sav' } },
    { source: { ...source, archives: ['inner.zip'], entry: 'world.sav' } },
  ])
    await readGameViewerPrefix({ ...options(), ...overrides });
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/content?'))).toHaveLength(5);
});
it('one abandoned consumer does not cancel a concurrent reader', async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(async (url: string) =>
    url.includes('/content?')
      ? new Promise<Response>((resolve) => {
          finish = resolve;
        })
      : meta(),
  );
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const first = readGameViewerPrefix({ ...options(), signal: controller.signal });
  const second = readGameViewerPrefix(options());
  await vi.waitFor(() => expect(finish).toBeDefined());
  controller.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  finish(body());
  expect((await second)[0]).toBe(1);
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/content?'))).toHaveLength(1);
});
it('bounds retained entries', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => (url.includes('/content?') ? body() : meta())),
  );
  for (let i = 0; i < gamePrefixCacheLimits.entries + 2; i++)
    await readGameViewerPrefix({ ...options(), source: { ...source, path: `${i}.sav` } });
  expect(
    queryClient.getQueryCache().findAll({ queryKey: ['viewer-game-prefix'] }).length,
  ).toBeLessThanOrEqual(gamePrefixCacheLimits.entries);
});

it('reserves a slot for a pending read before retaining its bytes', async () => {
  let finish: ((value: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.includes('/content?')) return meta();
      if (url.includes('pending.sav'))
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      return body();
    }),
  );
  for (let i = 0; i < gamePrefixCacheLimits.entries; i++)
    await readGameViewerPrefix({ ...options(), source: { ...source, path: `${i}.sav` } });
  const pending = readGameViewerPrefix({
    ...options(),
    source: { ...source, path: 'pending.sav' },
  });
  await vi.waitFor(() => expect(finish).toBeDefined());
  expect(queryClient.getQueryCache().findAll({ queryKey: ['viewer-game-prefix'] })).toHaveLength(
    gamePrefixCacheLimits.entries,
  );
  finish?.(body());
  await pending;
});
it('does not cache a revision precondition failure', async () => {
  let failed = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!url.includes('/content?')) return meta();
      return failed ? new Response('', { status: 412 }) : body();
    }),
  );
  await expect(readGameViewerPrefix(options())).rejects.toBeDefined();
  failed = false;
  expect((await readGameViewerPrefix(options()))[0]).toBe(1);
});
it('rejects a pending read when the current session identity changes', async () => {
  let finish!: (value: Response) => void;
  queryClient.setQueryData(['session'], {
    context: { actorUserId: 'a', subjectUserId: 'a', sessionType: 'normal' },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/content?')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : meta(),
    ),
  );
  const pending = readGameViewerPrefix(options());
  await vi.waitFor(() => expect(finish).toBeDefined());
  queryClient.setQueryData(['session'], {
    context: {
      actorUserId: 'a',
      subjectUserId: 'b',
      sessionType: 'support',
      support: { id: 'new' },
    },
  });
  finish(body());
  await expect(pending).rejects.toMatchObject({ messageKey: 'viewer.unavailable' });
});
it('refreshes an expired prefix even when the source revision is unchanged', async () => {
  const fetcher = vi.fn(async (url: string) => (url.includes('/content?') ? body() : meta()));
  vi.stubGlobal('fetch', fetcher);
  await readGameViewerPrefix(options());
  const cached = queryClient.getQueryCache().findAll({ queryKey: ['viewer-game-prefix'] })[0];
  expect(cached).toBeDefined();
  if (cached)
    queryClient.setQueryData(cached.queryKey, cached.state.data, {
      updatedAt: Date.now() - gamePrefixCacheLimits.ttlMs - 1,
    });
  await readGameViewerPrefix(options());
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/content?'))).toHaveLength(2);
});
