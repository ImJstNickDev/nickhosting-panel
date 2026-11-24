import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, readApi } from '../../api/client.js';
import { useFormat } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { RuleActionDialog, type RuleForm } from './rules-action.js';
import { RuleIcon, type RuleSnapshot, useRuleText, type Zone } from './rules-fields.js';
import { Groups } from './rules-groups.js';
import { WorldRules, ZoneDetail } from './rules-territory.js';
import { TravelRules } from './rules-travel.js';
import { type TelemetryViewProps, withTelemetrySession } from './telemetry.js';
import './rules.css';

type Screen =
  | { kind: 'world' | 'travel' | 'groups' }
  | { kind: 'zone'; id?: number; name: string; world: string | null };
function accessGone(error: unknown) {
  return (
    error instanceof ApiError &&
    ([401, 403, 404, 409].includes(error.status) ||
      ['forbidden', 'not_found', 'unauthenticated'].includes(error.code))
  );
}
function RulesWorkspace({
  data,
  server,
  readAt,
  refresh,
  refreshing,
  error,
}: {
  data: RuleSnapshot;
  server: TelemetryViewProps;
  readAt: number;
  refresh: () => void;
  refreshing: boolean;
  error: unknown;
}) {
  const r = useRuleText(),
    format = useFormat();
  const [screen, setScreen] = useState<Screen>({ kind: 'world' }),
    [form, setForm] = useState<RuleForm | null>(null),
    [receipt, setReceipt] = useState(0);
  useEffect(() => {
    if (!receipt) return;
    const timer = window.setTimeout(() => setReceipt(0), 4500);
    return () => window.clearTimeout(timer);
  }, [receipt]);
  const has = (key: string) => server.permissionKeys.includes(`game.openworld.${key}`);
  const canEdit = !error && !refreshing;
  const canDifficulty = canEdit && has('rules.manage'),
    manage = canEdit && has('territory.manage');
  const selectZone = (z: Zone) =>
    setScreen({ kind: 'zone', id: z.id, world: z.world, name: z.name });
  const zone =
    screen.kind === 'zone'
      ? data.zones?.find(
          (z) =>
            z.world === screen.world &&
            (screen.id != null ? z.id === screen.id : z.name === screen.name),
        )
      : undefined;
  const detail = (screen.kind === 'zone' && zone) || screen.kind === 'travel';
  return (
    <div className="ow-workspace ow-rules">
      <div className="ow-rule-toolbar">
        <nav className="ow-rule-nav" aria-label={r('title')}>
          <button
            type="button"
            aria-pressed={screen.kind !== 'groups'}
            onClick={() => setScreen({ kind: 'world' })}
          >
            <RuleIcon name="world" />
            {r('worldTerritory')}
          </button>
          <button
            type="button"
            aria-pressed={screen.kind === 'groups'}
            onClick={() => setScreen({ kind: 'groups' })}
          >
            <RuleIcon name="groups" />
            {r('groups')}
          </button>
        </nav>
        <button
          type="button"
          className="ow-rule-icon ow-rule-refresh"
          aria-label={r('refresh')}
          title={r('lastRead', { time: format.date(new Date(readAt)) })}
          disabled={refreshing}
          onClick={refresh}
        >
          <RuleIcon name="refresh" />
        </button>
      </div>
      {error ? (
        <div className="ow-rules-stale">
          <ErrorNotice error={error} />
          <p>{r('lastRead', { time: format.date(new Date(readAt)) })}</p>
        </div>
      ) : null}
      {detail && (
        <button
          type="button"
          className="ow-rule-back ow-rule-text"
          onClick={() => setScreen({ kind: 'world' })}
        >
          <RuleIcon name="back" size={13} />
          {r('gameplay')}
        </button>
      )}
      {screen.kind === 'groups' ? (
        <Groups data={data} edit={setForm} manage={canEdit && has('roles.manage')} />
      ) : screen.kind === 'travel' ? (
        <TravelRules data={data} edit={setForm} manage={manage} />
      ) : zone ? (
        <ZoneDetail
          {...{
            zone,
            data,
            manage,
            edit: setForm,
            serverId: server.serverId,
            canMap: has('map.read'),
          }}
        />
      ) : (
        <WorldRules
          {...{
            data,
            edit: setForm,
            manage,
            canDifficulty,
            selectZone,
            openTravel: () => setScreen({ kind: 'travel' }),
          }}
        />
      )}
      {form && !error && (
        <RuleActionDialog
          form={form}
          serverId={server.serverId}
          processRef={data.processRef}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null);
            setReceipt(Date.now());
            refresh();
          }}
          onAccessError={refresh}
        />
      )}
      {receipt > 0 && (
        <div role="status" className="ow-rule-saved">
          <RuleIcon name="check" />
          {r('saved')}
        </div>
      )}
    </div>
  );
}
function Rules(server: TelemetryViewProps) {
  const r = useRuleText(),
    canRead = server.permissionKeys.includes('game.openworld.rules.view'),
    running = server.runtimeState === 'running';
  const grants = server.permissionKeys
    .filter((g) => g.startsWith('game.openworld.'))
    .sort()
    .join(' ');
  const cache = useQueryClient();
  const queryKey = [
    'openworld-rules',
    ...server.viewerScope,
    server.serverId,
    server.runtimeState,
    grants,
  ];
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
      try {
        return await readApi<RuleSnapshot>(
          `/v1/servers/${encodeURIComponent(server.serverId)}/openworld/rules`,
          signal,
        );
      } catch (error) {
        // Once access or identity changes, a later transient failure must never expose the old read.
        if (accessGone(error)) cache.setQueryData<RuleSnapshot | null>(queryKey, null);
        throw error;
      }
    },
    enabled: canRead && running,
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnMount: 'always',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (!canRead) return <ErrorNotice error={new ApiError('forbidden', 'errors.forbidden')} />;
  if (!running)
    return (
      <section className="ow-panel">
        <p className="ow-empty">{r('offline')}</p>
      </section>
    );
  const refresh = () => void query.refetch();
  if (query.error && (!query.data || accessGone(query.error)))
    return <ErrorNotice error={query.error} retry={refresh} />;
  if (!query.data) return <Loading />;
  return (
    <RulesWorkspace
      key={JSON.stringify([grants, query.data.processRef])}
      data={query.data}
      server={server}
      readAt={query.dataUpdatedAt}
      refresh={refresh}
      refreshing={query.isFetching}
      error={query.error}
    />
  );
}
export const OpenworldRules = withTelemetrySession(Rules);
