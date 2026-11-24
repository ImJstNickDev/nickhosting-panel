import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, api, readApi } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Check, ErrorNotice, Loading } from '../../components/ui.js';
import { mapKey, scopeLost } from './map-query.js';
import type { ServerView } from './telemetry.js';

type SpawnState = { processRef: string; enabled: boolean | null; editable: boolean };

export function CreatureSpawning({
  server,
  processRef,
}: {
  server: ServerView;
  processRef: string;
}) {
  const t = useT();
  const path = `/v1/servers/${encodeURIComponent(server.serverId)}/openworld/rules`;
  const query = useQuery({
    queryKey: ['openworld-spawning', ...server.viewerScope, server.serverId, processRef],
    queryFn: ({ signal }) => readApi<SpawnState>(`${path}/spawning`, signal),
    retry: false,
    gcTime: 0,
  });
  const mutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const requestId = crypto.randomUUID();
      const result = await api<{ requestId: string; outcome: string }>(path, {
        body: {
          requestId,
          processRef,
          action: { kind: 'spawning', enabled },
        },
      });
      if (result.requestId !== requestId || result.outcome !== 'accepted')
        throw new ApiError('operation_uncertain', 'errors.operation_uncertain', requestId);
    },
    onSettled: () => query.refetch(),
  });
  const fail = query.error || mutation.error;
  return (
    <div className="ow-session-spawning" aria-busy={mutation.isPending}>
      {fail && (
        <ErrorNotice
          error={fail}
          retry={() => {
            mutation.reset();
            void query.refetch();
          }}
        />
      )}
      {!query.data && !query.error && <Loading />}
      {query.data &&
        query.data.processRef === processRef &&
        !scopeLost(fail) &&
        (query.data.enabled === null ? (
          <p>{t(mapKey('layers.spawningUnknown'))}</p>
        ) : (
          <>
            <Check
              label={t(mapKey('layers.sessionSpawning'))}
              checked={mutation.isPending ? mutation.variables : query.data.enabled}
              disabled={!query.data.editable || query.isFetching || mutation.isPending || !!fail}
              onChange={(event) => mutation.mutate(event.target.checked)}
            />
            <small>{t(mapKey('layers.sessionSpawningHint'))}</small>
          </>
        ))}
    </div>
  );
}
