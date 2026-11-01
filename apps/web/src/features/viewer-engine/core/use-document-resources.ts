import { useEffect, useRef, useState } from 'react';
import { queryClient } from '../../../api/client.js';
import { fileDirectoryQuery, type ServerFile } from '../../service-contracts.js';
import type { ArchivePage } from './archive-query.js';
import { createDocumentResources, type DocumentResources } from './document-resources.js';
import type { ViewerSource } from './registry.js';

export interface DocumentResourceContext {
  serverId: string;
  identity: string;
  source: ViewerSource;
  onOpen(source: ViewerSource, fragment?: string): void;
}

/** Resource lifetime follows the open document, including StrictMode's effect replay. */
export function useDocumentResources(context?: DocumentResourceContext) {
  const current = useRef(context);
  current.current = context;
  const key = context ? JSON.stringify([context.serverId, context.identity, context.source]) : '';
  const [state, setState] = useState<{ key: string; resources: DocumentResources }>();
  useEffect(() => {
    const input = current.current;
    if (!input || !key) return;
    const resources = createDocumentResources({
      ...input,
      knownSources: () => cachedDocumentSources(input.serverId, input.identity, input.source),
      onOpen: (source, fragment) => current.current?.onOpen(source, fragment),
    });
    setState({ key, resources });
    return () => resources.dispose();
  }, [key]);
  return state?.key === key ? state.resources : undefined;
}

/** Only already indexed metadata, scoped to the active identity and namespace. */
export function cachedDocumentSources(
  serverId: string,
  identity: string,
  source: ViewerSource,
): ViewerSource[] {
  if (source.entry) {
    const prefix = [
      'viewer-archive',
      identity,
      serverId,
      source.path,
      JSON.stringify(source.archives ?? []),
    ];
    return queryClient
      .getQueryCache()
      .findAll({ queryKey: prefix })
      .flatMap((query) => {
        const page = query.state.data as ArchivePage | undefined;
        return (page?.entries ?? [])
          .filter((entry) => !entry.directory)
          .map((entry) => ({
            ...source,
            entry: entry.path,
            name: entry.name,
            size: entry.size,
          }));
      });
  }
  const scope = JSON.stringify(fileDirectoryQuery(serverId, '').queryKey[3]);
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: ['files', serverId] })
    .flatMap((query) => {
      if (JSON.stringify(query.queryKey[3]) !== scope || typeof query.queryKey[2] !== 'string')
        return [];
      const folder = query.queryKey[2].replace(/^\/+|\/+$/g, '');
      const files = query.state.data as ServerFile[] | undefined;
      return (Array.isArray(files) ? files : [])
        .filter((file) => file.is_file && !file.is_symlink && !/[\\/]/.test(file.name))
        .map((file) => ({
          path: `${folder ? `${folder}/` : ''}${file.name}`,
          name: file.name,
          size: file.size,
          gameId: source.gameId,
        }));
    });
}
