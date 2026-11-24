import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { Empty, ErrorNotice, Loading, Section, Time } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import './versions.css';

interface Catalog {
  source: 'metiva' | 'official';
  syncedAt: string;
  releases: {
    version: string;
    size: number;
    sha256: string;
    gatewayFailure?: { reason: 'version_mismatch' | 'protocol_mismatch'; checkedAt: string };
  }[];
}
interface Settings {
  noticeSeconds: number;
  locked: boolean;
}
const path = '/v1/owner/integrations/openworld/versions';
const queryKey = ['integration-versions', 'openworld'];
const pageSize = 25;

const settingsPath = '/v1/owner/integrations/openworld/update-settings';
const settingsKey = ['integration-update-settings', 'openworld'];

function UpdateNoticeSetting() {
  const t = useT();
  const cache = useQueryClient();
  const [draft, setDraft] = useState<string>();
  const settings = useQuery({
    queryKey: settingsKey,
    queryFn: ({ signal }) => api<Settings>(settingsPath, { signal }),
  });
  const save = useMutation({
    mutationFn: (noticeSeconds: number) =>
      api<Settings>(settingsPath, { method: 'PUT', body: { noticeSeconds } }),
    onSuccess: (result) => {
      cache.setQueryData(settingsKey, result);
      setDraft(undefined);
    },
  });
  if (settings.isPending) return <Loading />;
  if (settings.error || !settings.data)
    return <ErrorNotice error={settings.error} retry={() => void settings.refetch()} />;
  const data = settings.data;
  const value = draft ?? String(data.noticeSeconds);
  const valid = /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 86400;
  return (
    <form
      className="openworld-update-notice"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !data.locked && !save.isPending) save.mutate(Number(value));
      }}
    >
      <label htmlFor="openworld-update-notice">{t('games.openworld.defaultNotice')}</label>
      <div>
        <input
          id="openworld-update-notice"
          type="number"
          min={1}
          max={86400}
          step={1}
          required
          disabled={data.locked || save.isPending}
          value={value}
          onChange={(event) => {
            save.reset();
            setDraft(event.target.value);
          }}
        />
        {data.locked ? (
          <span className="muted">{t('owner.source.environment')}</span>
        ) : (
          <button
            className="secondary"
            type="submit"
            disabled={!valid || Number(value) === data.noticeSeconds || save.isPending}
          >
            {t('web.save')}
          </button>
        )}
        {save.isSuccess && (
          <span className="muted" role="status">
            {t('web.saved')}
          </span>
        )}
      </div>
      {save.error && <ErrorNotice error={save.error} />}
    </form>
  );
}

export default function OpenworldVersions() {
  const t = useT();
  const format = useFormat();
  const cache = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const catalog = useQuery({ queryKey, queryFn: ({ signal }) => api<Catalog>(path, { signal }) });
  const sync = useMutation({
    onMutate: () => cache.cancelQueries({ queryKey }),
    mutationFn: () => api<Catalog>(`${path}/sync`, { method: 'POST' }),
    onSuccess: async (result) => {
      cache.setQueryData(queryKey, result);
      await cache.invalidateQueries({ queryKey: ['creation', 'catalog', 'openworld'] });
    },
  });
  const data = catalog.data;
  const filtered = (data?.releases ?? []).filter(({ version }) =>
    version.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const current = Math.min(page, pages);
  return (
    <Section
      title={t('games.openworld.catalogTitle')}
      actions={
        <button
          type="button"
          className="secondary"
          disabled={sync.isPending || catalog.isPending}
          onClick={() => sync.mutate()}
        >
          {t(sync.isPending ? 'fabricCatalog.syncing' : 'versions.detect')}
        </button>
      }
    >
      <UpdateNoticeSetting />
      {sync.error && <ErrorNotice error={sync.error} />}
      {catalog.isPending ? (
        <Loading />
      ) : catalog.error || !data ? (
        <ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} />
      ) : (
        <div className="openworld-versions">
          <div className="openworld-versions-toolbar">
            <SearchField
              label={t('versions.search')}
              maxLength={128}
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
            />
            <span className="muted">{t('versions.count', { count: filtered.length })}</span>
          </div>
          {filtered.length ? (
            <table aria-label={t('games.openworld.versions')}>
              <thead>
                <tr>
                  <th scope="col">{t('games.openworld.version')}</th>
                  <th scope="col">{t('web.size')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice((current - 1) * pageSize, current * pageSize).map((release) => (
                  <tr key={release.version}>
                    <th scope="row">
                      <span>{release.version}</span>
                      {release.gatewayFailure && (
                        <small className="openworld-gateway-failure">
                          {t(`games.openworld.gatewayCheck.${release.gatewayFailure.reason}`)} ·{' '}
                          <Time value={release.gatewayFailure.checkedAt} />
                        </small>
                      )}
                    </th>
                    <td>{format.bytes(release.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty text={t('fabricCatalog.noMatches')} />
          )}
          {pages > 1 && (
            <Pagination
              label={t('versions.pagination')}
              summary={t('versions.page', { page: current, pages })}
              previousLabel={t('web.previous')}
              nextLabel={t('web.next')}
              canPrevious={current > 1}
              canNext={current < pages}
              onPrevious={() => setPage(current - 1)}
              onNext={() => setPage(current + 1)}
            />
          )}
          <div className="openworld-versions-source muted" role="status">
            <span>
              {data.source === 'metiva' ? 'Metiva' : t('games.openworld.officialManifest')}
            </span>
            <span>
              {t('fabricCatalog.lastSync')} <Time value={data.syncedAt} />
            </span>
          </div>
        </div>
      )}
    </Section>
  );
}
