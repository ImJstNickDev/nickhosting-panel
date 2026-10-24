import { type RefObject, useEffect, useRef } from 'react';
import type { DirectoryBatchResult } from '../../../../packages/pterodactyl-adapter/src/directory-batch.js';
import { api, queryClient } from '../api/client.js';
import { directoryMemory } from './file-directory-memory.js';
import { DirectoryPrefetch } from './file-directory-prefetch.js';
import { fileDirectoryQuery, type ServerFile, serverPath } from './service-contracts.js';

export function useDirectoryPrefetch({
  serverId,
  directory,
  identity,
  container,
  rows,
  enabled,
}: {
  serverId: string;
  directory: string;
  identity: string;
  container: RefObject<HTMLElement | null>;
  rows: ServerFile[];
  enabled: boolean;
}) {
  const scheduler = useRef<
    | {
        runner: DirectoryPrefetch;
        serverId: string;
        directory: string;
        identity: string;
      }
    | undefined
  >(undefined);
  useEffect(() => {
    if (!enabled || typeof IntersectionObserver === 'undefined') return;
    const memory = directoryMemory(queryClient);
    const keys = new Map<string, ReturnType<typeof fileDirectoryQuery>['queryKey']>();
    const captures = new Map<string, ReturnType<typeof memory.capture>>();
    const key = (path: string) => {
      let found = keys.get(path);
      if (!found) {
        found = fileDirectoryQuery(serverId, path, { prepareDownloads: false }).queryKey;
        keys.set(path, found);
      }
      return found;
    };
    const current = () =>
      identity === JSON.stringify(fileDirectoryQuery(serverId, directory).queryKey[3]);
    const runner = new DirectoryPrefetch({
      read: (path) => memory.read(key(path)),
      fetch: async (directories, signal) => {
        if (!current()) throw new Error('identity_changed');
        for (const path of directories) captures.set(path, memory.capture(key(path)));
        const response = await api<{ results: DirectoryBatchResult[] }>(
          `${serverPath(serverId)}/files/directories`,
          { body: { directories }, signal },
        );
        return response.results;
      },
      store: (path, files) => {
        const before = captures.get(path);
        return current() && before !== undefined && memory.write(key(path), files, before);
      },
    });
    scheduler.current = { runner, serverId, directory, identity };
    return () => {
      runner.stop();
      if (scheduler.current?.runner === runner) scheduler.current = undefined;
    };
  }, [serverId, directory, identity, enabled]);

  useEffect(() => {
    const current = scheduler.current;
    if (
      !enabled ||
      !current ||
      !container.current ||
      current.serverId !== serverId ||
      current.directory !== directory ||
      current.identity !== identity
    )
      return;
    const runner = current.runner;
    // Observe actual rows rather than the full API listing: 500 offscreen folders do no work.
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const path = (entry.target as HTMLElement).dataset.directoryPath;
        if (path === undefined) continue;
        if (entry.isIntersecting) visible.add(path);
        else visible.delete(path);
      }
      runner.setVisible([...visible]);
    });
    void rows;
    for (const row of container.current.querySelectorAll('[data-directory-path]'))
      observer.observe(row);
    return () => {
      observer.disconnect();
      runner.setVisible([]);
    };
  }, [container, rows, serverId, directory, identity, enabled]);
}
