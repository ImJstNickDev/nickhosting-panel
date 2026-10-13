import { api } from '../../../api/client.js';
import { serverPath } from '../../service-contracts.js';
import { type ViewerSource, viewerExtension } from './registry.js';

interface CompressedPage {
  total: number;
  entries: { name: string; path: string; size: number; directory: boolean }[];
}

/** Compound tar formats remain archive browsers. */
export function isSingleCompressed(source: ViewerSource) {
  return ['gz', 'bz2', 'xz', 'zst'].includes(viewerExtension(source.name));
}

/** Shares Atlas' first-page cache, including its bounded page size and lifetime. */
export function compressedArchiveOptions(serverId: string, identity: string, source: ViewerSource) {
  const archives = JSON.stringify(source.archives ?? []);
  const params = new URLSearchParams({
    path: source.path,
    directory: '',
    offset: '0',
    limit: '200',
    query: '',
    sort: 'name',
    direction: 'asc',
    archives,
  });
  return {
    queryKey: [
      'viewer-archive',
      identity,
      serverId,
      source.path,
      archives,
      '',
      '',
      'name',
      'asc',
      0,
    ],
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<CompressedPage>(`${serverPath(serverId)}/files/viewer/archive?${params}`, { signal }),
    gcTime: 2 * 60_000,
    staleTime: 15_000,
  };
}

export function decodedMember(source: ViewerSource, page: CompressedPage): ViewerSource {
  const member = page.entries[0];
  if (page.total !== 1 || page.entries.length !== 1 || !member || member.directory)
    throw { messageKey: 'viewer.unavailable' };
  return { ...source, entry: member.path, name: member.name, size: member.size };
}
