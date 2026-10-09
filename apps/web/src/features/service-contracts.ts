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
import { api } from '../api/client.js';
import type { Result } from '../api/contracts.js';

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
