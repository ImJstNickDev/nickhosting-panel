import { useQuery } from '@tanstack/react-query';
import type { MapPlayer } from '../../../../../games/openworld/src/map-terrain.js';
import { ApiError, api } from '../../api/client.js';
import { playerPath } from './player-navigation.js';
import type { ServerView } from './telemetry.js';

export type { MapPlayer };

type Point = { world: string; face: number; x: number; z: number; y?: number };
const fragment = () => new URLSearchParams(window.location.hash.slice(1));
function number(params: URLSearchParams, key: string) {
  const value = params.get(key);
  if (value === null || !value.trim()) return NaN;
  return Number(value);
}
export function mapFocusQuery(): Point | null {
  const p = fragment(),
    world = p.get('world'),
    face = number(p, 'face'),
    x = number(p, 'x'),
    z = number(p, 'z');
  return world &&
    world.length <= 128 &&
    Number.isInteger(face) &&
    face >= 0 &&
    face <= 5 &&
    Number.isFinite(x) &&
    Number.isFinite(z)
    ? { world, face, x, z, ...(Number.isFinite(number(p, 'y')) ? { y: number(p, 'y') } : {}) }
    : null;
}
export function mapHref(serverId: string, p: Point) {
  const hash = new URLSearchParams({
    world: p.world,
    face: String(p.face),
    x: String(p.x),
    z: String(p.z),
    ...(p.y !== undefined ? { y: String(p.y) } : {}),
  });
  return `/servers/${encodeURIComponent(serverId)}/game/map#${hash}`;
}
export function playerHref(serverId: string, p: MapPlayer, processRef: string) {
  return playerPath(serverId, {
    account: null,
    name: p.name,
    connection: { id: p.id, name: p.name, joinedAt: p.joinedAt, processRef },
  });
}
export function useMapPlayers(
  server: ServerView,
  enabled: boolean,
  processRef: string | null | undefined,
) {
  return useQuery({
    queryKey: [
      'openworld-map-players',
      ...server.viewerScope,
      server.serverId,
      server.runtimeState,
      processRef,
    ],
    queryFn: ({ signal }) =>
      api<{ players: MapPlayer[]; processRef: string }>(
        `/v1/servers/${encodeURIComponent(server.serverId)}/openworld/map/players?processRef=${encodeURIComponent(processRef ?? '')}`,
        { signal },
      ),
    enabled: enabled && server.runtimeState === 'running' && !!processRef,
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchInterval: (q) =>
      q.state.error instanceof ApiError && [401, 403, 404, 409].includes(q.state.error.status ?? 0)
        ? false
        : 5000,
    refetchIntervalInBackground: false,
  });
}
