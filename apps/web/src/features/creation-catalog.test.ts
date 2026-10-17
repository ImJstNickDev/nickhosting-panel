import { createMinecraftUiController, minecraftUiModule } from '@nickhosting/minecraft/ui';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, queryClient } from '../api/client.js';
import { identityChanged } from '../app/session.js';
import { creationCatalogQuery, creationGamesQuery } from './creation-catalog.js';
import { gameUiClient } from './integrations.js';

const rows = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    version: '26.1',
    runtime: 'vanilla',
    releaseTime: '2026-03-01T00:00:00Z',
  },
];
afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});
describe('authorized creation catalog reuse', () => {
  it('prefetches once and projects runtime and version steps without another HTTP request', async () => {
    const fetch = vi.fn(async () => Response.json(rows));
    vi.stubGlobal('fetch', fetch);
    const data = await queryClient.fetchQuery(creationCatalogQuery(minecraftUiModule));
    expect(minecraftUiModule.creationCatalog?.options(data, 'runtimes', {})).toHaveLength(1);
    expect(
      minecraftUiModule.creationCatalog?.options(data, 'choices', { runtime: 'vanilla' }),
    ).toHaveLength(1);
    await Promise.all([
      createMinecraftUiController(gameUiClient).runtimeOptions(),
      createMinecraftUiController(gameUiClient).choiceOptions(),
    ]);
    await queryClient.fetchQuery(creationCatalogQuery(minecraftUiModule));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('invalidates both cached catalog and games after Owner writes', async () => {
    const fetch = vi.fn(async () => Response.json(rows));
    vi.stubGlobal('fetch', fetch);
    await queryClient.fetchQuery(creationCatalogQuery(minecraftUiModule));
    await queryClient.fetchQuery(creationGamesQuery);
    await api('/v1/owner/minecraft/compatibility/example/availability', {
      method: 'PUT',
      body: { enabled: false },
    });
    fetch.mockImplementation(async () => Response.json([]));
    expect(await queryClient.fetchQuery(creationCatalogQuery(minecraftUiModule))).toEqual([]);
    expect(queryClient.getQueryData(creationGamesQuery.queryKey)).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('cannot reuse the previous identity catalog after sign-in or support-context changes', async () => {
    const fetch = vi.fn(async () => Response.json(rows));
    vi.stubGlobal('fetch', fetch);
    await queryClient.fetchQuery(creationCatalogQuery(minecraftUiModule));
    await identityChanged();
    fetch.mockImplementation(async () => Response.json([]));
    expect(await queryClient.fetchQuery(creationCatalogQuery(minecraftUiModule))).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
