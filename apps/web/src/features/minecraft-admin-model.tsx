import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '../api/client.js';
import { useT } from '../app/i18n.js';

export interface Mapping {
  id: string;
  game_id: string;
  runtime_id: string;
  enabled?: boolean;
  nest_id: number;
  egg_id: number;
  docker_image: string;
  image_mode?: 'static' | 'integration';
  environment: Record<string, string>;
  node_id: string;
}
export interface Egg {
  id: number;
  name: string;
  relationships?: { variables?: { data: { attributes: { env_variable: string } }[] } };
}
export interface Evidence {
  runId: string;
  kind: string;
  recordedAt: string;
  checks: Record<string, boolean>;
  client?: { implementation: string; version: string; protocolId: number };
  server?: { uuid: string; javaMajor: number; imageDigest: string };
  evidenceSha256: string;
}
export interface Combination {
  id: string;
  mappingId: string;
  enabled: boolean;
  support: string;
  image?: string | null;
  mappingEnabled?: boolean;
  creation?: { state: 'available' | 'private-testing' | 'blocked'; reason: string | null };
  releaseTime?: string | null;
  releaseTimeStatus?: 'available' | 'unknown' | 'unavailable';
  supportAuthority?: 'integration' | 'signed-evidence';
  capabilities?: {
    installation: boolean;
    directConnection: boolean;
    gateway: boolean;
    readiness: boolean;
    playerIdle: boolean;
    sleepWake: boolean;
    playerManagement: boolean;
  };
  combination: {
    release: string;
    releaseType?: string;
    profile: string;
    javaMajor: number;
    protocolId: number | null;
    family: string;
    buildId?: string;
    loaderVersion?: string;
  };
  evidence: Evidence[];
}
export interface ReleaseGroup {
  release: string;
  releaseType: string;
  releaseTime: string | null;
  releaseTimeStatus: string;
  variantCount: number;
  choice?: Combination;
}
export const mappingsQuery = {
  queryKey: ['runtime-mappings'],
  queryFn: ({ signal }: { signal: AbortSignal }) =>
    api<Mapping[]>('/v1/owner/runtime-mappings', { signal }),
  staleTime: 30_000,
};
export function useMappingLabel() {
  const t = useT();
  const mappings = useQuery(mappingsQuery);
  const nodes = useQuery({
    queryKey: ['owner-nodes'],
    queryFn: ({ signal }) =>
      api<Array<{ id: string; pterodactyl_node_id: number }>>('/v1/owner/nodes', { signal }),
    staleTime: 30_000,
  });
  const inventory = useQuery({
    queryKey: ['owner-provider'],
    queryFn: ({ signal }) =>
      api<{ nodes: Array<{ id: number; name: string }> }>('/v1/owner/infrastructure', { signal }),
    staleTime: 30_000,
  });
  const nests = [
    ...new Set(mappings.data?.filter((m) => m.game_id === 'minecraft').map((m) => m.nest_id)),
  ];
  const eggs = useQueries({
    queries: nests.map((nest) => ({
      queryKey: ['runtime-eggs', nest],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<Egg[]>(`/v1/owner/nests/${nest}/eggs`, { signal }),
      staleTime: 60_000,
    })),
  });
  return (mapping: Mapping | undefined, includeRuntime = true) => {
    if (!mapping) return t('web.unavailable');
    const id = nodes.data?.find((node) => node.id === mapping.node_id)?.pterodactyl_node_id;
    const node = inventory.data?.nodes.find((node) => node.id === id)?.name;
    const egg = eggs[nests.indexOf(mapping.nest_id)]?.data?.find(
      (egg) => egg.id === mapping.egg_id,
    )?.name;
    return `${includeRuntime ? `${mapping.runtime_id} · ` : ''}${node ?? (id ? `${t('infra.providerNode')} ${id}` : t('web.unknown'))} · ${egg ?? `${t('infra.egg')} ${mapping.egg_id}`}`;
  };
}
