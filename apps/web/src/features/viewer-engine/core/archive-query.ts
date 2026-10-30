import { api } from '../../../api/client.js';
import { serverPath } from '../../service-contracts.js';
import type { ViewerSource } from './registry.js';

export interface ArchiveEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
  modifiedAt?: string | null;
}
export interface ArchivePage {
  directory: string;
  offset: number;
  limit: number;
  total: number;
  entries: ArchiveEntry[];
}
export type ArchiveSort = 'name' | 'size' | 'modifiedAt';
export const archivePageSize = 200;

/** Atlas listing, path completion and single-file decoding share metadata and request deduplication. */
export function archiveQuery(
  serverId: string,
  identity: string,
  source: ViewerSource,
  directory = '',
  offset = 0,
  query = '',
  sort: ArchiveSort = 'name',
  direction: 'asc' | 'desc' = 'asc',
) {
  const archives = JSON.stringify(source.archives ?? []);
  const params = new URLSearchParams({
    path: source.path,
    directory,
    offset: String(offset),
    limit: String(archivePageSize),
    query,
    sort,
    direction,
    archives,
  });
  return {
    queryKey: [
      'viewer-archive',
      identity,
      serverId,
      source.path,
      archives,
      directory,
      query,
      sort,
      direction,
      offset,
    ],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<ArchivePage>(`${serverPath(serverId)}/files/viewer/archive?${params}`, { signal }),
    gcTime: 2 * 60_000,
    staleTime: 15_000,
  };
}
