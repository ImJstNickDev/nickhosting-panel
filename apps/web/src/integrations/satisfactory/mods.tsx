import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api, idempotencyKey } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { useUnsavedChanges } from '../../components/navigation-guard.js';
import { Dialog, ErrorNotice, Select } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import './mods.css';
import type { GameSectionViewProps } from '../../features/game-section-view.js';

type Choice = { reference: string; version: string };
type Snapshot = {
  selection: Choice[];
  lock: { mods: Record<string, { version: string; dependencies: Record<string, string> | null }> };
};
type Project = { id: string; reference: string; name: string };
type Version = {
  version: string;
  gameVersion: string;
  dependencies: { mod_id: string; condition: string; optional: boolean }[];
};
const key = (name: string) => `games.satisfactory.mods.${name}`;

export function SatisfactoryModsSection(props: GameSectionViewProps) {
  const t = useT();
  const searchHintId = useId();
  const base = `/v1/servers/${encodeURIComponent(props.serverId)}/satisfactory/mods`;
  const [draft, setDraft] = useState<Choice[] | undefined>();
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [project, setProject] = useState<Project>();
  const [version, setVersion] = useState('');
  const [error, setError] = useState<unknown>();
  const [submitting, setSubmitting] = useState(false);
  const snapshot = useQuery({
    queryKey: ['satisfactory-mods', props.serverId, props.pending],
    queryFn: ({ signal }) => api<Snapshot>(base, { signal }),
  });
  const catalog = useQuery({
    queryKey: ['satisfactory-mods-catalog', props.serverId, search, offset],
    queryFn: ({ signal }) =>
      api<{ total: number; items: Project[] }>(
        `${base}/catalog?query=${encodeURIComponent(search)}&offset=${offset}`,
        { signal },
      ),
  });
  const versions = useQuery({
    queryKey: ['satisfactory-mod-versions', props.serverId, project?.reference],
    enabled: !!project,
    queryFn: ({ signal }) =>
      project
        ? api<Version[]>(`${base}/versions/${encodeURIComponent(project.reference)}`, { signal })
        : Promise.resolve([]),
  });
  const selection = draft ?? snapshot.data?.selection ?? [];
  const busy = props.pending || submitting;
  const editable = props.canManage && !busy && !!snapshot.data;
  const changed = JSON.stringify(selection) !== JSON.stringify(snapshot.data?.selection ?? []);
  const validSearch = query.trim().length === 0 || query.trim().length >= 3;
  useUnsavedChanges(changed, submitting);
  function choose(item: Project) {
    setProject(item);
    setVersion('');
  }
  async function apply() {
    if (!editable || !changed) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await api<{ jobId: string }>(`${base}/apply`, {
        method: 'POST',
        body: { selection, idempotencyKey: idempotencyKey() },
      });
      setDraft(undefined);
      props.onAccepted(result.jobId);
    } catch (cause) {
      setError(cause);
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <section className="workspace-surface satisfactory-mods">
      <h2>{t(key('title'))}</h2>
      <p className="muted">{t(key('applyHint'))}</p>
      {(error ?? snapshot.error ?? catalog.error) != null && (
        <ErrorNotice
          error={error ?? snapshot.error ?? catalog.error}
          retry={() => {
            setError(undefined);
            void snapshot.refetch();
            void catalog.refetch();
          }}
        />
      )}
      {snapshot.isPending ? (
        <p role="status">{t('web.loading')}</p>
      ) : (
        <>
          <h3>{t(key('selected'))}</h3>
          {selection.length === 0 ? (
            <p>{t(key('empty'))}</p>
          ) : (
            <ul className="satisfactory-mod-list">
              {selection.map((mod) => (
                <li key={mod.reference}>
                  <div className="satisfactory-mod-name">
                    <strong>{mod.reference}</strong> <span>{mod.version}</span>
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={!editable}
                      onClick={() =>
                        choose({ id: mod.reference, reference: mod.reference, name: mod.reference })
                      }
                    >
                      {t(key('changeVersion'))}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!editable}
                      onClick={() =>
                        setDraft(selection.filter((item) => item.reference !== mod.reference))
                      }
                    >
                      {t('web.remove')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="form-footer">
            <button
              type="button"
              className="secondary"
              disabled={!changed || busy}
              onClick={() => setDraft(undefined)}
            >
              {t('web.cancel')}
            </button>
            <button type="button" disabled={!editable || !changed} onClick={() => void apply()}>
              {t(key('apply'))}
            </button>
          </div>
          <details>
            <summary>{t(key('dependencies'))}</summary>
            {Object.keys(snapshot.data?.lock.mods ?? {}).length === 0 ? (
              <p className="muted">{t(key('noDependencies'))}</p>
            ) : (
              <ul className="satisfactory-dependencies">
                {Object.entries(snapshot.data?.lock.mods ?? {}).map(([reference, mod]) => (
                  <li key={reference}>
                    {reference} {mod.version}
                  </li>
                ))}
              </ul>
            )}
          </details>
        </>
      )}
      <form
        className="satisfactory-mod-search"
        onSubmit={(event) => {
          event.preventDefault();
          if (!validSearch) return;
          setSearch(query.trim());
          setOffset(0);
        }}
      >
        <SearchField
          label={t(key('search'))}
          value={query}
          minLength={3}
          maxLength={256}
          aria-describedby={searchHintId}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" className="secondary" disabled={!validSearch}>
          {t('web.search')}
        </button>
      </form>
      <small id={searchHintId}>{t(key('searchHint'))}</small>
      {catalog.isPending ? (
        <p role="status">{t('web.loading')}</p>
      ) : (
        <ul className="satisfactory-mod-list satisfactory-catalog">
          {catalog.data?.items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="satisfactory-project-action"
                onClick={() => choose(item)}
              >
                {item.name}
              </button>
              <code>{item.reference}</code>
            </li>
          ))}
        </ul>
      )}
      {catalog.data?.items.length === 0 && <p>{t(key('noResults'))}</p>}
      <Pagination
        label={t(key('pages'))}
        previousLabel={t(key('previous'))}
        nextLabel={t(key('next'))}
        summary={catalog.data ? t(key('results'), { count: catalog.data.total }) : t('web.loading')}
        canPrevious={offset > 0}
        canNext={!!catalog.data && offset + 30 < catalog.data.total}
        disabled={catalog.isFetching}
        onPrevious={() => setOffset(Math.max(0, offset - 30))}
        onNext={() => setOffset(offset + 30)}
      />
      {project && (
        <Dialog
          open
          title={project.name}
          onClose={() => setProject(undefined)}
          initialFocusSelector="select"
          className="satisfactory-version-dialog"
        >
          {versions.error && (
            <ErrorNotice error={versions.error} retry={() => void versions.refetch()} />
          )}
          {!versions.error && (
            <fieldset disabled={!editable}>
              {versions.isPending ? (
                <p role="status">{t('web.loading')}</p>
              ) : (
                <>
                  <Select
                    label={t(key('version'))}
                    value={version}
                    onChange={(event) => setVersion(event.target.value)}
                  >
                    <option value="">{t(key('chooseVersion'))}</option>
                    {versions.data?.map((item) => (
                      <option key={item.version} value={item.version}>
                        {item.version} · {item.gameVersion}
                      </option>
                    ))}
                  </Select>
                  {versions.data?.length === 0 && <p>{t(key('noVersions'))}</p>}
                  <ul className="satisfactory-dependencies">
                    {versions.data
                      ?.find((item) => item.version === version)
                      ?.dependencies.map((dependency) => (
                        <li key={dependency.mod_id}>
                          {dependency.mod_id} {dependency.condition}
                          {dependency.optional ? ` (${t(key('optional'))})` : ''}
                        </li>
                      ))}
                  </ul>
                  <div className="form-footer">
                    <button
                      type="button"
                      disabled={!version}
                      onClick={() => {
                        setDraft([
                          ...selection.filter((item) => item.reference !== project.reference),
                          { reference: project.reference, version },
                        ]);
                        setProject(undefined);
                      }}
                    >
                      {t(key('select'))}
                    </button>
                  </div>
                </>
              )}
            </fieldset>
          )}
        </Dialog>
      )}
    </section>
  );
}
