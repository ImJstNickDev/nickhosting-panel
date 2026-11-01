import { archiveQuery } from './archive-query.js';
import { type ViewerSource, viewerExtension } from './registry.js';

interface CompressedPage {
  total: number;
  entries: { name: string; path: string; size: number; directory: boolean }[];
}

/** Compound tar formats remain archive browsers. */
export function isSingleCompressed(source: ViewerSource) {
  return ['gz', 'bz2', 'xz', 'zst'].includes(viewerExtension(source.name, source.gameId));
}

/** Shares Atlas' first-page cache, including its bounded page size and lifetime. */
export function compressedArchiveOptions(serverId: string, identity: string, source: ViewerSource) {
  return archiveQuery(serverId, identity, source);
}

export function decodedMember(source: ViewerSource, page: CompressedPage): ViewerSource {
  const member = page.entries[0];
  if (page.total !== 1 || page.entries.length !== 1 || !member || member.directory)
    throw { messageKey: 'viewer.unavailable' };
  return { ...source, entry: member.path, name: member.name, size: member.size };
}
