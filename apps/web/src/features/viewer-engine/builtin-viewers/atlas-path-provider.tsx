import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef } from 'react';
import { useRegisterFilemanPathProvider } from '../../fileman/host.js';
import { trimArchivePages } from '../core/archive-memory.js';
import { type ArchivePage, archiveQuery } from '../core/archive-query.js';
import {
  type AtlasAlias,
  type AtlasPathLocation,
  createAtlasPathProvider,
} from '../core/atlas-path.js';
import type { ViewerSource } from '../core/registry.js';

/** Atlas contributes navigation for its entire session, including other viewers displaying members. */
export function AtlasPathContribution(props: {
  serverId: string;
  identity: string;
  root: ViewerSource;
  source: ViewerSource;
  directory: string;
  aliases: readonly AtlasAlias[];
  onNavigate(location: AtlasPathLocation): void;
  onOpen(source: ViewerSource): void;
  shouldDecode(source: ViewerSource): boolean;
  onAliases(aliases: readonly AtlasAlias[]): void;
}) {
  const cache = useQueryClient();
  const callbacks = useRef(props);
  callbacks.current = props;
  const { serverId, identity } = props;
  const state = JSON.stringify({
    root: props.root,
    source: props.source,
    directory: props.directory,
    aliases: props.aliases,
  });
  const provider = useMemo(() => {
    const snapshot = JSON.parse(state) as Pick<
      typeof props,
      'root' | 'source' | 'directory' | 'aliases'
    >;
    return createAtlasPathProvider({
      ...snapshot,
      key: [
        'builtin:atlas',
        identity,
        serverId,
        snapshot.root.path,
        JSON.stringify(snapshot.aliases),
      ],
      async read(source, directory, prefix, offset, signal) {
        signal?.throwIfAborted();
        // Small, complete listings already displayed by Atlas answer completion locally.
        const all = archiveQuery(serverId, identity, source, directory);
        const retained = cache.getQueryState<ArchivePage>(all.queryKey);
        if (
          prefix &&
          retained?.status === 'success' &&
          retained.data &&
          Date.now() - retained.dataUpdatedAt < all.staleTime &&
          retained.data.total === retained.data.entries.length
        ) {
          const entries = retained.data.entries.filter((entry) =>
            entry.name.toLowerCase().includes(prefix.toLowerCase()),
          );
          return {
            ...retained.data,
            offset,
            total: entries.length,
            entries: entries.slice(offset, offset + 200),
          };
        }
        const query = archiveQuery(serverId, identity, source, directory, offset, prefix);
        try {
          const page = await cache.fetchQuery({ ...query, retry: false });
          signal?.throwIfAborted();
          return page;
        } finally {
          trimArchivePages(query.queryKey);
        }
      },
      shouldDecode: (source) => callbacks.current.shouldDecode(source),
      rememberAliases: (aliases) => callbacks.current.onAliases(aliases),
      navigate: (location) => callbacks.current.onNavigate(location),
      open: (source) => callbacks.current.onOpen(source),
    });
  }, [cache, identity, serverId, state]);
  useRegisterFilemanPathProvider(provider);
  return null;
}
