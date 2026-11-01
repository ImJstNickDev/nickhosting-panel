import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, idempotencyKey } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { ErrorNotice } from '../../components/ui.js';
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
      api<Version[]>(`${base}/versions/${encodeURIComponent(project!.reference)}`, { signal }),
  });
  const selection = draft ?? snapshot.data?.selection ?? [];
  const busy = props.pending || submitting;
  const editable = props.canManage && !busy && !!snapshot.data;
  const changed = JSON.stringify(selection) !== JSON.stringify(snapshot.data?.selection ?? []);
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
      <p>{t(key('applyHint'))}</p>
      {(error ?? snapshot.error ?? catalog.error ?? versions.error) != null && (
        <ErrorNotice error={error ?? snapshot.error ?? catalog.error ?? versions.error} />
      )}
      {snapshot.isPending ? (
        <p role="status">{t('web.loading')}</p>
      ) : (
        <>
          <h3>{t(key('selected'))}</h3>
          {selection.length === 0 ? (
            <p>{t(key('empty'))}</p>
          ) : (
            <ul>
              {selection.map((mod) => (
                <li key={mod.reference}>
                  <strong>{mod.reference}</strong> <span>{mod.version}</span>{' '}
                  <button
                    type="button"
                    disabled={!editable}
                    onClick={() =>
                      choose({ id: mod.reference, reference: mod.reference, name: mod.reference })
                    }
                  >
                    {t(key('changeVersion'))}
                  </button>{' '}
                  <button
                    type="button"
                    disabled={!editable}
                    onClick={() =>
                      setDraft(selection.filter((item) => item.reference !== mod.reference))
                    }
                  >
                    {t('web.remove')}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button type="button" disabled={!editable || !changed} onClick={() => void apply()}>
            {t(key('apply'))}
          </button>{' '}
          <button type="button" disabled={!changed || busy} onClick={() => setDraft(undefined)}>
            {t('web.cancel')}
          </button>
          <details>
            <summary>{t(key('dependencies'))}</summary>
            <ul>
              {Object.entries(snapshot.data?.lock.mods ?? {}).map(([reference, mod]) => (
                <li key={reference}>
                  {reference} {mod.version}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(query);
          setOffset(0);
        }}
      >
        <label>
          {t(key('search'))}
          <input value={query} maxLength={256} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="submit">{t('web.search')}</button>
      </form>
      {catalog.isPending ? (
        <p role="status">{t('web.loading')}</p>
      ) : (
        <ul>
          {catalog.data?.items.map((item) => (
            <li key={item.id}>
              <button type="button" onClick={() => choose(item)}>
                {item.name}
              </button>{' '}
              <code>{item.reference}</code>
            </li>
          ))}
        </ul>
      )}
      {catalog.data?.items.length === 0 && <p>{t(key('noResults'))}</p>}
      <nav aria-label={t(key('pages'))}>
        <button
          type="button"
          disabled={offset === 0 || catalog.isFetching}
          onClick={() => setOffset(Math.max(0, offset - 30))}
        >
          {t(key('previous'))}
        </button>{' '}
        <button
          type="button"
          disabled={!catalog.data || offset + 30 >= catalog.data.total || catalog.isFetching}
          onClick={() => setOffset(offset + 30)}
        >
          {t(key('next'))}
        </button>
      </nav>
      {project && (
        <fieldset disabled={!editable}>
          <legend>{project.name}</legend>
          {versions.isPending ? (
            <p role="status">{t('web.loading')}</p>
          ) : (
            <>
              <label>
                {t(key('version'))}
                <select value={version} onChange={(event) => setVersion(event.target.value)}>
                  <option value="">{t(key('chooseVersion'))}</option>
                  {versions.data?.map((item) => (
                    <option key={item.version} value={item.version}>
                      {item.version} · {item.gameVersion}
                    </option>
                  ))}
                </select>
              </label>
              {versions.data?.length === 0 && <p>{t(key('noVersions'))}</p>}
              <ul>
                {versions.data
                  ?.find((item) => item.version === version)
                  ?.dependencies.map((dependency) => (
                    <li key={dependency.mod_id}>
                      {dependency.mod_id} {dependency.condition}
                      {dependency.optional ? ` (${t(key('optional'))})` : ''}
                    </li>
                  ))}
              </ul>
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
            </>
          )}
        </fieldset>
      )}
    </section>
  );
}
