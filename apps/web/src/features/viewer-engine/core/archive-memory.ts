import { queryClient } from '../../../api/client.js';

/** Small metadata pages only; raw files and archive content never enter Query's cache. */
export function trimArchivePages(currentKey: readonly unknown[]) {
  const queries = queryClient
    .getQueryCache()
    .findAll({ queryKey: ['viewer-archive'] })
    .sort((left, right) => right.state.dataUpdatedAt - left.state.dataUpdatedAt);
  let bytes = 0;
  let pages = 0;
  for (const query of queries) {
    const size = query.state.data ? JSON.stringify(query.state.data).length * 2 : 0;
    const current = JSON.stringify(query.queryKey) === JSON.stringify(currentKey);
    if (!current && !query.isActive() && (pages >= 48 || bytes + size > 8 * 1024 * 1024)) {
      queryClient.removeQueries({ queryKey: query.queryKey, exact: true });
    } else {
      bytes += size;
      pages++;
    }
  }
}
