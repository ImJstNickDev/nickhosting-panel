import { apiError, safeApiPath } from '../../../api/client.js';
import { serverPath } from '../../service-contracts.js';
import type { ViewerSource } from './registry.js';

export function viewerPath(serverId: string, source: ViewerSource, operation = 'content') {
  const query = new URLSearchParams({ path: source.path });
  if (source.archives?.length) query.set('archives', JSON.stringify(source.archives));
  if (source.entry) query.set('entry', source.entry);
  return `${serverPath(serverId)}/files/viewer/${source.entry ? 'archive/' : ''}${operation}?${query}`;
}

/** Download exactly the selected file, or the current container's original bytes. */
export function viewerDownloadPath(serverId: string, source: ViewerSource) {
  if (source.entry) return `${viewerPath(serverId, source)}&download=true`;
  if (source.archives?.length)
    return `${viewerPath(serverId, {
      ...source,
      entry: source.archives.at(-1),
      archives: source.archives.slice(0, -1),
    })}&download=true`;
  return `${serverPath(serverId)}/files/content?path=${encodeURIComponent(source.path)}`;
}

/** One bounded transport for parsers. Media use the same-origin URL with native Range requests. */
export async function readViewerBytes(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  prefixSize?: number,
  headers?: Record<string, string>,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(safeApiPath(url), {
    credentials: 'same-origin',
    redirect: 'error',
    signal,
    ...(prefixSize || headers
      ? { headers: { ...headers, ...(prefixSize ? { Range: `bytes=0-${prefixSize - 1}` } : {}) } }
      : {}),
  });
  if (!response.ok) throw apiError(await response.json().catch(() => ({})), response.status);
  let expectedPrefixBytes: number | undefined;
  if (prefixSize) {
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
    if (
      response.status !== 206 ||
      !range ||
      !Number.isSafeInteger(Number(range[2])) ||
      Number(range[1]) + 1 !== Math.min(prefixSize, Number(range[2]))
    ) {
      await response.body?.cancel();
      throw { messageKey: 'viewer.unavailable' };
    }
    expectedPrefixBytes = Number(range[1]) + 1;
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw { messageKey: 'viewer.tooLarge' };
  }
  if (!response.body) throw { messageKey: 'viewer.unavailable' };
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw { messageKey: 'viewer.tooLarge' };
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (expectedPrefixBytes !== undefined && size !== expectedPrefixBytes)
    throw { messageKey: 'viewer.unavailable' };
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
