import { afterEach, expect, it, vi } from 'vitest';
import { queryClient } from '../../../api/client.js';
import { fileDirectoryQuery } from '../../service-contracts.js';
import { createLogSession } from './log-session.js';

const controllers: AbortController[] = [];
const source = { path: 'logs/server.log', name: 'server.log', size: 10 };
const page = {
  revision: 'a',
  rows: [{ line: 1, text: 'test', level: 'info' }],
  offset: 0,
  total: 1,
  totalLines: 1,
};
function session() {
  const controller = new AbortController();
  controllers.push(controller);
  return { controller, log: createLogSession('server', source, controller.signal) };
}
function mock() {
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/page')) return new Response(JSON.stringify(page));
    if (url.endsWith('/refresh'))
      return new Response(JSON.stringify({ revision: 'b', changed: true }));
    if (url.endsWith('/renew') || options?.method === 'DELETE')
      return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ sessionId: 'lease', revision: 'a' }));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  queryClient.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('opens once, pages/searches server snapshot and releases with keepalive on close', async () => {
  const fetcher = mock(),
    { log, controller } = session(),
    signal = new AbortController().signal;
  expect(await log.page({ offset: -1, limit: 200 }, signal)).toEqual(page);
  await log.page({ offset: 0, limit: 200, query: 'across file', level: 'error' }, signal);
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/session'))).toHaveLength(1);
  expect(JSON.parse(String(fetcher.mock.calls.at(-1)?.[1]?.body))).toMatchObject({
    query: 'across file',
    offset: 0,
  });
  controller.abort();
  expect(fetcher.mock.calls.at(-1)?.[1]).toMatchObject({ method: 'DELETE', keepalive: true });
  await expect(log.page({ offset: 0, limit: 200 }, signal)).rejects.toThrow();
});
it('renews retention without refresh or source stat', async () => {
  vi.useFakeTimers();
  const fetcher = mock(),
    { log } = session();
  await log.page({ offset: 0, limit: 200 }, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(30000);
  expect(fetcher.mock.calls.map(([url]) => url.split('/').at(-1))).toEqual([
    'session',
    'page',
    'renew',
  ]);
});
it('only reports existing same-directory identity invalidations and changed listing metadata', async () => {
  const { log } = session();
  const listener = vi.fn();
  log.onChange(listener);
  const key = fileDirectoryQuery('server', 'logs').queryKey;
  queryClient.setQueryData(key, [
    { name: 'server.log', size: 10, modified_at: 'a', is_file: true },
  ]);
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  queryClient.setQueryData(key, [
    { name: 'server.log', size: 10, modified_at: 'a', is_file: true },
  ]);
  queryClient.setQueryData(fileDirectoryQuery('other', 'logs').queryKey, []);
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
  await queryClient.invalidateQueries({ queryKey: key, refetchType: 'none' });
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(2);
});
it('does not publish a late page after cancellation', async () => {
  mock();
  const { log } = session(),
    controller = new AbortController();
  const pending = log.page({ offset: 0, limit: 200 }, controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

it('reopens an expired lease once through full authorization, never retries denied reads', async () => {
  let opens = 0,
    pages = 0;
  const fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (options?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.endsWith('/session'))
      return new Response(JSON.stringify({ sessionId: `lease-${++opens}`, revision: 'a' }));
    if (url.endsWith('/page')) {
      pages++;
      return pages === 1 ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(page));
    }
    return new Response('{}', { status: 403 });
  });
  vi.stubGlobal('fetch', fetcher);
  const { log } = session();
  expect(await log.page({ offset: 0, limit: 200 }, new AbortController().signal)).toEqual(page);
  expect(opens).toBe(2);
  await expect(log.refresh(new AbortController().signal)).rejects.toMatchObject({ status: 403 });
  expect(opens).toBe(2);
});
