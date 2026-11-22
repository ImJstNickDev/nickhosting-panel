import { useQuery } from '@tanstack/react-query';
import type {
  OpenworldFactoriesSnapshot,
  OpenworldFactoryColumn,
} from '../../../../../games/openworld/src/factories.js';
import { ApiError, readApi } from '../../api/client.js';
import type { TelemetryViewProps } from './telemetry.js';

export function factoryMapPoint(c: OpenworldFactoryColumn) {
  if (!c.world || c.world === 'ships' || c.face == null) return null;
  if (c.i != null && c.j != null)
    return { world: c.world, face: c.face, x: c.i * 16 + 8, z: c.j * 16 + 8 };
  return c.x != null && c.z != null ? { world: c.world, face: c.face, x: c.x, z: c.z } : null;
}

export function useFactoryData(props: TelemetryViewProps, enabled: boolean) {
  const canRead = props.permissionKeys.includes('game.openworld.performance.read'),
    online = props.runtimeState === 'running';
  return useQuery({
    queryKey: [
      'openworld-factories',
      ...props.viewerScope,
      props.serverId,
      props.runtimeState,
      canRead,
    ],
    queryFn: ({ signal }) =>
      readApi<OpenworldFactoriesSnapshot>(
        `/v1/servers/${encodeURIComponent(props.serverId)}/openworld/factories`,
        signal,
      ),
    enabled: enabled && online && canRead,
    staleTime: 3000,
    gcTime: 0,
    retry: false,
    refetchInterval: (q) =>
      enabled &&
      online &&
      canRead &&
      !(
        q.state.error instanceof ApiError &&
        ([401, 403, 404].includes(q.state.error.status) ||
          q.state.error.code === 'game_request_unsupported')
      )
        ? 10000
        : false,
    refetchIntervalInBackground: false,
  });
}
