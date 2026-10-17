import { afterEach, expect, it, vi } from 'vitest';
import { queryClient } from '../api/client.js';
import { fileDirectoryQuery } from './service-contracts.js';

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

it('isolates directory data when the session identity changes without a local sign-in action', () => {
  const context = {
    actorUserId: 'actor',
    subjectUserId: 'first-user',
    sessionType: 'regular',
  };
  queryClient.setQueryData(['session'], { context });
  const first = fileDirectoryQuery('server', 'world').queryKey;
  queryClient.setQueryData(first, [{ name: 'first-user.txt' }]);
  expect(fileDirectoryQuery('server', 'world').queryKey).toEqual(first);
  for (const next of [
    { ...context, subjectUserId: 'second-user' },
    { ...context, actorUserId: 'second-actor' },
    { ...context, sessionType: 'support', support: { id: 'assistance' } },
  ]) {
    queryClient.setQueryData(['session'], { context: next });
    const key = fileDirectoryQuery('server', 'world').queryKey;
    expect(key.slice(0, 3)).toEqual(['files', 'server', 'world']);
    expect(queryClient.getQueryData(key)).toBeUndefined();
  }
  queryClient.removeQueries({ queryKey: ['session'] });
  expect(queryClient.getQueryData(fileDirectoryQuery('server', 'world').queryKey)).toBeUndefined();
});

it('shares metadata keys without preparing downloads for path and tree discovery', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json([]));
  vi.stubGlobal('fetch', fetcher);
  const foreground = fileDirectoryQuery('server', 'world');
  const metadata = fileDirectoryQuery('server', 'world', { prepareDownloads: false });
  expect(metadata.queryKey).toEqual(foreground.queryKey);
  expect(metadata.staleTime).toBe(Number.POSITIVE_INFINITY);
  expect(metadata.refetchOnWindowFocus).toBe(false);
  await metadata.queryFn({ signal: new AbortController().signal });
  expect(fetcher.mock.calls[0]?.[0]).toBe(
    '/v1/servers/server/files?path=world&prepareDownloads=false',
  );
  await foreground.queryFn({ signal: new AbortController().signal });
  expect(fetcher.mock.calls[1]?.[0]).toBe('/v1/servers/server/files?path=world');
});
