import type { TrustedGameUiModule } from '@nickhosting/game-sdk/ui';
import { queryOptions } from '@tanstack/react-query';
import { api, queryClient } from '../api/client.js';
import { gameUiClient } from './integrations.js';

export type GameEntry = {
  id: string;
  access: { canCreate: boolean };
  manifest: { runtimes?: unknown[] };
};
export const creationStaleTime = 60_000;
export const creationGamesQuery = queryOptions({
  queryKey: ['creation', 'games'],
  queryFn: ({ signal }) => api<GameEntry[]>('/v1/games', { signal }),
  staleTime: creationStaleTime,
});
export function creationCatalogQuery(module: TrustedGameUiModule) {
  return queryOptions({
    queryKey: ['creation', 'catalog', module.descriptor.gameId],
    queryFn: ({ signal }) =>
      module.creationCatalog?.load(gameUiClient, signal) ?? Promise.resolve([]),
    staleTime: creationStaleTime,
  });
}
export function prefetchCreationCatalog(module: TrustedGameUiModule) {
  if (module.creationCatalog) void queryClient.prefetchQuery(creationCatalogQuery(module));
}
