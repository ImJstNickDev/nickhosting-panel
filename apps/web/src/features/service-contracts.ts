import type { AuthContext } from '@nickhosting/core';
import { useQuery } from '@tanstack/react-query';
import type {
  Backup,
  Resources,
  ServerFile,
} from '../../../../packages/pterodactyl-adapter/src/types.js';
import type {
  createSftpCredential,
  listServerDns,
  listSftpCredentials,
  previewServerDns,
} from '../../../../packages/server-management/src/external.js';
import type {
  getPlatformConnections,
  getPlatformServer,
  getPlatformSleepPolicy,
  getPlatformTransfers,
  listPlatformMetrics,
} from '../../../../packages/server-management/src/platform-queries.js';
import type {
  listScheduleOutcomes,
  listSchedules,
} from '../../../../packages/server-management/src/schedules.js';
import { api, queryClient } from '../api/client.js';
import type { Result } from '../api/contracts.js';
import { directoryMemory } from './file-directory-memory.js';

export type ServerInfo = Result<typeof getPlatformServer>;
export type Transfers = Result<typeof getPlatformTransfers>;
export type Connections = Result<typeof getPlatformConnections>;
export type SleepPolicy = Result<typeof getPlatformSleepPolicy>;
export type Metrics = Result<typeof listPlatformMetrics>;
export type Schedules = Result<typeof listSchedules>;
export type Outcomes = Result<typeof listScheduleOutcomes>;
export type Credentials = Result<typeof listSftpCredentials>;
export type IssuedCredential = Result<typeof createSftpCredential>;
export type DnsAssignments = Result<typeof listServerDns>;
export type DnsPlan = Result<typeof previewServerDns>;
export type { Backup, Resources, ServerFile };
export function serverPath(id: string) {
  return `/v1/servers/${encodeURIComponent(id)}`;
}
export function platformPath(id: string) {
  return `/v1/platform/servers/${encodeURIComponent(id)}`;
}
export function fileDirectoryQuery(
  id: string,
  directory: string,
  options: { prepareDownloads?: boolean } = {},
) {
  directoryMemory(queryClient);
  const context = queryClient.getQueryData<{ context: AuthContext }>(['session'])?.context;
  const identity = context
    ? [context.actorUserId, context.subjectUserId, context.sessionType, context.support?.id ?? '']
    : null;
  return {
    // Keep all listing consumers on the same cache, without reusing another identity's data.
    queryKey: ['files', id, directory, identity] as const,
    // Metadata is immediately reusable; opening a folder always refreshes it independently.
    gcTime: 30 * 60 * 1000,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    queryFn: ({ signal }: { signal: AbortSignal }) =>
      api<ServerFile[]>(
        `${serverPath(id)}/files?path=${encodeURIComponent(directory)}${options.prepareDownloads === false ? '&prepareDownloads=false' : ''}`,
        {
          signal,
        },
      ),
  };
}
export function useServer(id: string) {
  return useQuery({
    queryKey: ['server', id],
    queryFn: () => api<ServerInfo>(platformPath(id)),
    refetchInterval: 10000,
  });
}
export function useTransfers(id: string) {
  return useQuery({
    queryKey: ['transfers', id],
    refetchInterval: 10000,
    queryFn: () => api<Transfers>(`${platformPath(id)}/transfers`),
  });
}
