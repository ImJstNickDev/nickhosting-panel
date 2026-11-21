import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import {
  canUnbanOpenworldAccount,
  type OpenworldRulesSnapshot,
} from '../../../../../games/openworld/src/rules.js';
import { ApiError, readApi } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { ErrorNotice, Loading } from '../../components/ui.js';
import { Pagination } from '../../components/workspace-controls.js';
import { RuleActionDialog, type RuleForm } from './rules-action.js';
import { type TelemetryViewProps, withTelemetrySession } from './telemetry.js';
import './rules.css';

const key = (suffix: string) => `games.openworld.rules.${suffix}`;
type Snapshot = OpenworldRulesSnapshot & { processRef: string };

function Rows<T>({
  rows,
  render,
  rowKey,
  label,
  empty,
}: {
  rows: T[] | null;
  render: (row: T) => ReactNode;
  rowKey: (row: T) => string;
  label: string;
  empty: string;
}) {
  const t = useT();
  const [page, setPage] = useState(1);
  if (!rows?.length)
    return <p className="ow-empty">{t(key(rows === null ? 'unavailable' : empty))}</p>;
  const pages = Math.ceil(rows.length / 12);
  const current = Math.min(page, pages);
  return (
    <>
      <ul className="ow-rule-rows">
        {rows.slice((current - 1) * 12, current * 12).map((row) => (
          <li key={rowKey(row)}>{render(row)}</li>
        ))}
      </ul>
      {pages > 1 && (
        <Pagination
          label={label}
          previousLabel={t('web.previous')}
          nextLabel={t('web.next')}
          summary={t('games.openworld.telemetry.pageNumber', { page: current, total: pages })}
          canPrevious={current > 1}
          canNext={current < pages}
          onPrevious={() => setPage(current - 1)}
          onNext={() => setPage(current + 1)}
        />
      )}
    </>
  );
}

function RulesData({
  data,
  server,
  refresh,
  refreshing,
}: {
  data: Snapshot;
  server: TelemetryViewProps;
  refresh: () => Promise<unknown>;
  refreshing: boolean;
}) {
  const t = useT();
  const format = useFormat();
  const [form, setForm] = useState<RuleForm | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const canSetDifficulty =
    server.permissionKeys.includes('game.openworld.rules.manage') &&
    data.capabilities.difficulty &&
    data.difficulty !== null;
  const canManageBans =
    server.permissionKeys.includes('game.openworld.bans.manage') && data.bans !== null;
  const canUseConsole =
    server.permissionKeys.includes('console.read') &&
    server.permissionKeys.includes('console.command');
  const canUnban = canManageBans && data.capabilities.unban;
  const open = (value: RuleForm) => {
    setNotice(null);
    setForm(value);
  };
  const visibleForm =
    form &&
    (form.kind === 'difficulty'
      ? canSetDifficulty
      : canUnban &&
        canUnbanOpenworldAccount(form.uuid) &&
        data.bans?.some((ban) => ban.uuid === form.uuid))
      ? form
      : null;
  return (
    <div className="ow-workspace ow-rules">
      {notice && <p role="status">{t(key(notice))}</p>}
      <section className="ow-panel">
        <div className="ow-heading">
          <h2>{t(key('gameplay'))}</h2>
          <button
            type="button"
            className="secondary"
            disabled={refreshing}
            onClick={() => void refresh()}
          >
            {t(key('refresh'))}
          </button>
        </div>
        <div className="ow-rule-line">
          <dl className="ow-metrics">
            <div>
              <dt>{t(key('difficulty'))}</dt>
              <dd>{t(key(data.difficulty ?? 'unavailable'))}</dd>
            </div>
          </dl>
          {canSetDifficulty && (
            <button
              className="secondary"
              type="button"
              onClick={() => open({ kind: 'difficulty' })}
            >
              {t(key('changeDifficulty'))}
            </button>
          )}
        </div>
      </section>
      <div className="ow-rules-pair">
        <section className="ow-panel">
          <div className="ow-heading">
            <h3>{t(key('zones'))}</h3>
          </div>
          <Rows
            rows={data.zones}
            label={t(key('zones'))}
            empty="noZones"
            rowKey={(zone) => JSON.stringify([zone.world, zone.name])}
            render={(zone) => (
              <div>
                <strong>{zone.name}</strong>
                {zone.world && <small> · {zone.world}</small>}
                {zone.description && <div className="ow-rule-details">{zone.description}</div>}
                {zone.flags && zone.flags.length > 0 && (
                  <dl className="ow-zone-flags">
                    {zone.flags.map((flag) => (
                      <div key={flag.key}>
                        <dt>{flag.key}</dt>
                        <dd>{t(key(flag.value))}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
          />
        </section>
        <section className="ow-panel">
          <div className="ow-heading">
            <h3>{t(key('borders'))}</h3>
          </div>
          {data.borders && (
            <p className="ow-rule-space">
              {t(key(data.borders.spaceOpen ? 'openSpace' : 'closedSpace'))}
            </p>
          )}
          <Rows
            rows={data.borders?.worlds ?? null}
            label={t(key('borders'))}
            empty="noBorders"
            rowKey={(border) => border.world}
            render={(border) => (
              <div>
                <strong>{border.world}</strong>
                <div className="ow-rule-details">
                  {border.border
                    ? t(key('bounded'), {
                        radius: format.number(border.border.radiusMeters, 2),
                        longitude: format.number(border.border.longitude, 5),
                        latitude: format.number(border.border.latitude, 5),
                      })
                    : border.description === 'open' || border.description === 'closed'
                      ? t(key(border.description))
                      : border.description}
                </div>
              </div>
            )}
          />
        </section>
      </div>
      <section className="ow-panel ow-rule-roles">
        <div className="ow-heading">
          <h3>{t(key('roles'))}</h3>
        </div>
        <Rows
          rows={data.roles?.entries ?? null}
          label={t(key('roles'))}
          empty="noRoles"
          rowKey={(role) => role.key}
          render={(role) => (
            <details>
              <summary>
                <strong>{role.name}</strong>
                {role.key === data.roles?.defaultRole && <small> · {t(key('defaultRole'))}</small>}
              </summary>
              <p className="ow-rule-details">
                {t(key('priority'), { priority: role.priority })}
                {role.parent && <> · {t(key('inherits'), { role: role.parent })}</>}
              </p>
              <dl className="ow-rule-permissions">
                <dt>{t(key('permissions'))}</dt>
                <dd>
                  {role.permissions?.length ? (
                    <code>{role.permissions.join(', ')}</code>
                  ) : (
                    t(key(role.permissions === null ? 'unavailable' : 'noPermissions'))
                  )}
                </dd>
              </dl>
            </details>
          )}
        />
      </section>
      <section className="ow-panel">
        <div className="ow-heading">
          <h3>{t(key('bans'))}</h3>
          {canUseConsole && (
            <Link
              className="ow-rules-console"
              to={`/servers/${encodeURIComponent(server.serverId)}/console`}
            >
              {t(key('openConsole'))}
            </Link>
          )}
        </div>
        <Rows
          rows={data.bans}
          label={t(key('bans'))}
          empty="noBans"
          rowKey={(ban) => ban.uuid}
          render={(ban) => (
            <>
              <div>
                <strong>{ban.name || ban.uuid}</strong>
                {ban.name && <small className="ow-rule-uuid">{ban.uuid}</small>}
                {ban.reason && <div className="ow-rule-details">{ban.reason}</div>}
              </div>
              {canUnban && canUnbanOpenworldAccount(ban.uuid) && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => open({ kind: 'unban', uuid: ban.uuid, name: ban.name })}
                >
                  {t(key('unban'))}
                </button>
              )}
            </>
          )}
        />
      </section>
      {visibleForm && (
        <RuleActionDialog
          form={visibleForm}
          serverId={server.serverId}
          processRef={data.processRef}
          difficulty={data.difficulty}
          onClose={() => setForm(null)}
          onSaved={() => {
            setNotice(visibleForm.kind === 'difficulty' ? 'difficultySaved' : 'unbanSaved');
            setForm(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Rules(server: TelemetryViewProps) {
  const t = useT();
  const canRead = server.permissionKeys.includes('game.openworld.rules.view');
  const running = server.runtimeState === 'running';
  const query = useQuery({
    queryKey: [
      'openworld-rules',
      ...server.viewerScope,
      server.serverId,
      server.runtimeState,
      canRead,
    ],
    queryFn: ({ signal }) =>
      readApi<Snapshot>(
        `/v1/servers/${encodeURIComponent(server.serverId)}/openworld/rules`,
        signal,
      ),
    enabled: canRead && running,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  });
  if (!canRead) return <ErrorNotice error={new ApiError('forbidden', 'errors.forbidden')} />;
  if (!running)
    return (
      <section className="ow-panel">
        <p className="ow-empty">{t(key('offline'))}</p>
      </section>
    );
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (!query.data) return <Loading />;
  return (
    <RulesData
      key={JSON.stringify([
        query.data.processRef,
        server.permissionKeys.includes('game.openworld.rules.manage'),
        server.permissionKeys.includes('game.openworld.bans.manage'),
      ])}
      data={query.data}
      server={server}
      refresh={query.refetch}
      refreshing={query.isFetching}
    />
  );
}

export const OpenworldRules = withTelemetrySession(Rules);
