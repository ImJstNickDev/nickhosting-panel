import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { satisfactorySaveDirectory } from '../../../../../games/satisfactory/src/world-paths.js';
import { api } from '../../api/client.js';
import { useFormat, useLocale, useT } from '../../app/i18n.js';
import { useUnsavedChanges } from '../../components/navigation-guard.js';
import { ConfirmDialog, ErrorNotice, Input } from '../../components/ui.js';
import { IconAction, Pagination, SearchField } from '../../components/workspace-controls.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import { type WorldSave as Save, useWorldsStream, type WorldSession } from './worlds-stream.js';
import './worlds.css';

const key = (name: string) => `games.satisfactory.worlds.${name}`;
type Action = { kind: 'save' | 'create' } | { kind: 'load'; save: Save };
type Retention = {
  defaultKeep: number;
  minimumKeep: number;
  maximumKeep: number;
  environmentLocked: boolean;
  policies: { sessionName: string; keep: number }[];
};
const category = (save: Save) =>
  save.safety ? 'safety' : /(?:^|_)autosave(?:_\d+)?$/i.test(save.saveName) ? 'autosave' : 'manual';

export function SatisfactoryWorldsSection(props: GameSectionViewProps) {
  const t = useT(),
    format = useFormat(),
    client = useQueryClient();
  const { locale } = useLocale();
  const base = `/v1/servers/${encodeURIComponent(props.serverId)}/satisfactory/api`;
  const online = props.runtimeState === 'running' || props.runtimeState === 'online';
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0);
  const [action, setAction] = useState<Action>(),
    [name, setName] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const [completed, setCompleted] = useState(false),
    [loadingUntil, setLoadingUntil] = useState(0);
  const [retentionBusy, setRetentionBusy] = useState(false),
    [retentionError, setRetentionError] = useState<unknown>();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!loadingUntil) return;
    const timer = setTimeout(() => setLoadingUntil(0), Math.max(0, loadingUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [loadingUntil]);
  const lock = useRef(false);
  useUnsavedChanges(Boolean(action && name), busy);
  const worlds = useWorldsStream(props.serverId, props.runtimeState, loadingUntil > Date.now());
  const retention = useQuery({
    queryKey: ['satisfactory-worlds-retention', props.serverId],
    queryFn: ({ signal }) => api<Retention>(`${base}/worlds/retention`, { signal }),
  });
  const editable =
    props.canManage &&
    online &&
    worlds.view.phase === 'ready' &&
    !worlds.isFetching &&
    !props.pending &&
    !busy &&
    !loadingUntil;
  const sessions = useMemo(
    () =>
      worlds.view.sessions
        .map((session, index) => ({ session, index }))
        .filter(({ session }) =>
          session.sessionName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
        ),
    [worlds.view.sessions, search],
  );
  const lastPage = Math.max(0, Math.ceil(sessions.length / 12) - 1),
    currentPage = Math.min(page, lastPage);
  const age = worlds.view.observedAt ? Math.max(0, (now - worlds.view.observedAt) / 1000) : 0;
  const unit = age >= 86400 ? 'day' : age >= 3600 ? 'hour' : 'minute';
  const relative =
    age < 60
      ? t('games.satisfactory.overview.justNow')
      : new Intl.RelativeTimeFormat(locale === 'it' ? 'it' : 'en', { numeric: 'always' }).format(
          -Math.floor(age / (unit === 'day' ? 86400 : unit === 'hour' ? 3600 : 60)),
          unit,
        );
  async function updateRetention(sessionName: string, keep: number) {
    if (retentionBusy || !props.canManage) return;
    setRetentionBusy(true);
    setRetentionError(undefined);
    try {
      const result = await api<Retention>(`${base}/worlds/retention`, {
        method: 'PUT',
        body: { sessionName, keep },
      });
      client.setQueryData(['satisfactory-worlds-retention', props.serverId], result);
    } catch (cause) {
      setRetentionError(cause);
    } finally {
      setRetentionBusy(false);
    }
  }
  const nameExists =
    worlds.view.sessions.some((session) =>
      session.saveHeaders.some((save) => save.saveName.toLowerCase() === name.toLowerCase()),
    ) === true;
  const nameValid =
    action?.kind === 'save'
      ? /^[A-Za-z0-9_-]{1,80}$/.test(name) && !nameExists
      : name.trim().length > 0 &&
        name.length <= 128 &&
        !/[\\/]/.test(name) &&
        !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
        !worlds.view.sessions.some(
          (session) => session.sessionName.toLowerCase() === name.trim().toLowerCase(),
        );
  function choose(next: Action) {
    setAction(next);
    setName('');
    setError(undefined);
    setCompleted(false);
  }
  async function submit() {
    if (!action || !editable || lock.current || (action.kind !== 'load' && !nameValid)) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setCompleted(false);
    try {
      await api(`${base}/worlds/${action.kind}`, {
        method: 'POST',
        body:
          action.kind === 'load'
            ? { saveName: action.save.saveName, confirm: true }
            : action.kind === 'save'
              ? { saveName: name }
              : { sessionName: name.trim(), confirm: true },
      });
      if (action.kind !== 'save') setLoadingUntil(Date.now() + 30000);
      setAction(undefined);
      setName('');
      setCompleted(true);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['satisfactory-worlds', props.serverId] }),
        client.invalidateQueries({ queryKey: ['satisfactory-state', props.serverId] }),
        client.invalidateQueries({ queryKey: ['satisfactory-overview', props.serverId] }),
        client.invalidateQueries({ queryKey: ['satisfactory-advanced-settings', props.serverId] }),
      ]);
    } catch (cause) {
      setError(cause);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="workspace-surface satisfactory-worlds">
      <header className="satisfactory-worlds-toolbar">
        <div className="satisfactory-worlds-heading">
          <h2>{t(key('heading'))}</h2>
          {worlds.view.source && (
            <span className="satisfactory-worlds-source">
              {t(
                key(
                  worlds.view.source === 'live' && worlds.view.phase === 'ready'
                    ? 'live'
                    : 'cached',
                ),
              )}
            </span>
          )}
        </div>
        <div className="actions">
          {props.canManage && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={!editable}
                onClick={() => choose({ kind: 'save' })}
              >
                {t(key('save'))}
              </button>
              <button type="button" disabled={!editable} onClick={() => choose({ kind: 'create' })}>
                {t(key('create'))}
              </button>
            </>
          )}
        </div>
      </header>
      {worlds.error != null && <ErrorNotice error={worlds.error} />}
      {!worlds.view.configured && <p>{t(key('unconfigured'))}</p>}
      {worlds.view.phase === 'starting' && <p role="status">{t(key('starting'))}</p>}
      {worlds.view.phase === 'offline' && <p role="status">{t(key('startFirst'))}</p>}
      {worlds.isFetching && <p role="status">{t(key('refreshing'))}</p>}
      {!worlds.view.known && !worlds.isFetching && <p>{t(key('unknown'))}</p>}
      {!props.canManage && <p>{t(key('readOnly'))}</p>}
      {props.pending && <p role="status">{t(key('pending'))}</p>}
      {completed && <p role="status">{t(key(loadingUntil ? 'loadingWorld' : 'completed'))}</p>}
      {retentionError != null && <ErrorNotice error={retentionError} />}
      {retention.error != null && <ErrorNotice error={retention.error} />}
      {(worlds.view.known || worlds.view.sessions.length > 0) && (
        <>
          <SearchField
            label={t(key('search'))}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
          {sessions.length === 0 ? (
            <p role="status">
              {t(key(search.trim() ? 'noMatches' : worlds.view.known ? 'empty' : 'refreshing'))}
            </p>
          ) : (
            <div className="satisfactory-worlds-list">
              {sessions
                .slice(currentPage * 12, (currentPage + 1) * 12)
                .map(({ session, index }) => (
                  <WorldCard
                    key={session.sessionName}
                    session={session}
                    active={index === worlds.view.currentSessionIndex}
                    historical={worlds.view.source !== 'live' || worlds.view.phase !== 'ready'}
                    canManage={props.canManage}
                    editable={editable}
                    load={(save) => choose({ kind: 'load', save })}
                    retention={retention.data}
                    retentionBusy={retentionBusy}
                    updateRetention={updateRetention}
                  />
                ))}
            </div>
          )}
          {lastPage > 0 && (
            <Pagination
              label={t(key('worldPages'))}
              previousLabel={t(key('previous'))}
              nextLabel={t(key('next'))}
              summary={t(key('page'), { page: currentPage + 1, total: lastPage + 1 })}
              canPrevious={currentPage > 0}
              canNext={currentPage < lastPage}
              onPrevious={() => setPage(currentPage - 1)}
              onNext={() => setPage(currentPage + 1)}
            />
          )}
        </>
      )}
      {props.permissionKeys.includes('files.read') && (
        <details className="satisfactory-worlds-transfers">
          <summary>{t(key('transfers'))}</summary>
          <Link
            to={`/servers/${encodeURIComponent(props.serverId)}/files?directory=${encodeURIComponent(satisfactorySaveDirectory)}`}
          >
            {t(key('files'))}
          </Link>
          <p>{t(key('filesHint'))}</p>
        </details>
      )}
      <footer className="satisfactory-worlds-updated">
        {worlds.view.observedAt && (
          <time
            dateTime={new Date(worlds.view.observedAt).toISOString()}
            title={format.date(new Date(worlds.view.observedAt).toISOString())}
          >
            {t('games.satisfactory.overview.lastUpdated', { time: relative })}
          </time>
        )}
        <IconAction
          label={t(key('refresh'))}
          disabled={worlds.isFetching || busy}
          onClick={() => {
            setCompleted(false);
            void worlds.refetch();
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17" />
          </svg>
        </IconAction>
      </footer>
      <ConfirmDialog
        open={Boolean(action)}
        title={action ? t(key(action.kind)) : ''}
        confirmLabel={action ? t(key(action.kind)) : undefined}
        busy={busy}
        submitDisabled={!editable || (action?.kind !== 'load' && !nameValid)}
        onClose={() => {
          if (!lock.current) {
            setAction(undefined);
            setName('');
            setError(undefined);
          }
        }}
        onConfirm={submit}
      >
        {action && (
          <>
            {action.kind === 'load' ? (
              <p>{t(key('confirmLoad'), { name: action.save.saveName })}</p>
            ) : (
              <Input
                label={t(key(action.kind === 'save' ? 'saveName' : 'sessionName'))}
                hint={action.kind === 'save' ? t(key('saveNameHint')) : undefined}
                value={name}
                maxLength={action.kind === 'save' ? 80 : 128}
                disabled={busy}
                onChange={(event) => setName(event.target.value)}
              />
            )}
            {action.kind !== 'save' && <p>{t(key('safetySave'))}</p>}
            {action.kind === 'create' && <p>{t(key('createHint'))}</p>}
            {action.kind === 'save' && nameExists && <p>{t(key('replaceWarning'))}</p>}
            {error != null && (
              <>
                <ErrorNotice error={error} />
                <p>{t(key('uncertain'))}</p>
              </>
            )}
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}

function WorldCard({
  session,
  active,
  historical,
  canManage,
  editable,
  load,
  retention,
  retentionBusy,
  updateRetention,
}: {
  session: WorldSession;
  active: boolean;
  historical: boolean;
  canManage: boolean;
  editable: boolean;
  load(save: Save): void;
  retention?: Retention;
  retentionBusy: boolean;
  updateRetention(name: string, keep: number): Promise<void>;
}) {
  const t = useT(),
    format = useFormat();
  const [search, setSearch] = useState(''),
    [kind, setKind] = useState('all'),
    [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const keep =
    retention?.policies.find((policy) => policy.sessionName === session.sessionName)?.keep ??
    retention?.defaultKeep ??
    5;
  const [draftKeep, setDraftKeep] = useState(String(keep));
  useEffect(() => setDraftKeep(String(keep)), [keep]);
  useUnsavedChanges(canManage && draftKeep !== String(keep), retentionBusy);
  const sorted = useMemo(
    () => [...session.saveHeaders].sort((a, b) => b.saveDateTime.localeCompare(a.saveDateTime)),
    [session.saveHeaders],
  );
  const saves = useMemo(
    () =>
      sorted.filter(
        (save) =>
          (kind === 'all' || category(save) === kind) &&
          save.saveName.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
      ),
    [sorted, kind, search],
  );
  const latest = sorted[0],
    lastPage = Math.max(0, Math.ceil(saves.length / 20) - 1),
    currentPage = Math.min(page, lastPage);
  const date = (save: Save) =>
    Number.isFinite(Date.parse(save.saveDateTime)) ? format.date(save.saveDateTime) : '—';
  const label = (save: Save) =>
    category(save) === 'manual' ? save.saveName : t(key(category(save)));
  return (
    <article className="satisfactory-world-card">
      <header className="satisfactory-world-card-header">
        <div>
          <h3>{session.sessionName || t(key('unnamed'))}</h3>
          <div className="satisfactory-worlds-meta">
            {active && (
              <span className="satisfactory-worlds-active">
                {t(key(historical ? 'lastActiveSession' : 'activeSession'))}
              </span>
            )}
            <span>{t(key('saveCount'), { count: session.saveHeaders.length })}</span>
            {latest?.isModdedSave && <span>{t(key('modded'))}</span>}
            {latest?.isCreativeModeEnabled && <span>{t(key('creative'))}</span>}
          </div>
        </div>
        {canManage && latest && (
          <button
            type="button"
            className="secondary"
            disabled={!editable}
            onClick={() => load(latest)}
            aria-label={t(key('loadLatestNamed'), { name: session.sessionName })}
          >
            {t(key('loadLatest'))}
          </button>
        )}
      </header>
      {latest && (
        <dl className="satisfactory-worlds-details">
          <div>
            <dt>{t(key('latestSave'))}</dt>
            <dd>{date(latest)}</dd>
          </div>
          <div>
            <dt>{t(key('playTime'))}</dt>
            <dd>{t(key('hours'), { value: format.number(latest.playDurationSeconds / 3600) })}</dd>
          </div>
          <div>
            <dt>{t(key('build'))}</dt>
            <dd>{latest.buildVersion}</dd>
          </div>
        </dl>
      )}
      <details
        className="satisfactory-world-history"
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>{t(key('history'))}</summary>
        {expanded && (
          <>
            <div className="satisfactory-history-filters">
              <SearchField
                label={t(key('searchSaves'))}
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(0);
                }}
              />
              <label>
                {t(key('saveType'))}
                <select
                  aria-label={t(key('saveType'))}
                  value={kind}
                  onChange={(event) => {
                    setKind(event.target.value);
                    setPage(0);
                  }}
                >
                  {['all', 'manual', 'autosave', 'safety'].map((type) => (
                    <option key={type} value={type}>
                      {t(key(type))}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {saves.length === 0 ? (
              <p>{t(key('noSaves'))}</p>
            ) : (
              <ul className="satisfactory-save-list">
                {saves.slice(currentPage * 20, (currentPage + 1) * 20).map((save) => (
                  <li key={save.saveName}>
                    <div className="satisfactory-worlds-identity">
                      <strong>{label(save)}</strong>
                      <span className="satisfactory-save-date">{date(save)}</span>
                      <details className="satisfactory-save-technical">
                        <summary>{t(key('details'))}</summary>
                        <dl>
                          <div>
                            <dt>{t(key('filename'))}</dt>
                            <dd>
                              <code>{save.saveName}.sav</code>
                            </dd>
                          </div>
                          <div>
                            <dt>{t(key('build'))}</dt>
                            <dd>{save.buildVersion}</dd>
                          </div>
                          <div>
                            <dt>{t(key('playTime'))}</dt>
                            <dd>
                              {t(key('hours'), {
                                value: format.number(save.playDurationSeconds / 3600),
                              })}
                            </dd>
                          </div>
                        </dl>
                        <div className="satisfactory-worlds-meta">
                          {save.isModdedSave && <span>{t(key('modded'))}</span>}
                          {save.isEditedSave && <span>{t(key('edited'))}</span>}
                          {save.isCreativeModeEnabled && <span>{t(key('creative'))}</span>}
                        </div>
                      </details>
                    </div>
                    {canManage && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={!editable}
                        aria-label={t(key('loadNamed'), { name: save.saveName })}
                        onClick={() => load(save)}
                      >
                        {t(key('load'))}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {lastPage > 0 && (
              <Pagination
                label={t(key('pages'))}
                previousLabel={t(key('previous'))}
                nextLabel={t(key('next'))}
                summary={t(key('page'), { page: currentPage + 1, total: lastPage + 1 })}
                canPrevious={currentPage > 0}
                canNext={currentPage < lastPage}
                onPrevious={() => setPage(currentPage - 1)}
                onNext={() => setPage(currentPage + 1)}
              />
            )}
          </>
        )}
      </details>
      {retention && (
        <details className="satisfactory-world-retention">
          <summary>{t(key('retention'))}</summary>
          <p>{t(key('retentionHint'))}</p>
          {retention.environmentLocked && <p>{t(key('retentionLocked'))}</p>}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void updateRetention(session.sessionName, Number(draftKeep));
            }}
          >
            <Input
              label={t(key('retentionKeep'))}
              type="number"
              min={retention.minimumKeep}
              max={retention.maximumKeep}
              step="1"
              value={draftKeep}
              onChange={(event) => setDraftKeep(event.target.value)}
              disabled={!canManage || retentionBusy || retention.environmentLocked}
            />
            {canManage && !retention.environmentLocked && (
              <button
                type="submit"
                className="secondary"
                disabled={
                  retentionBusy ||
                  !/^\d+$/.test(draftKeep) ||
                  Number(draftKeep) < retention.minimumKeep ||
                  Number(draftKeep) > retention.maximumKeep ||
                  Number(draftKeep) === keep
                }
              >
                {t(key('applyRetention'))}
              </button>
            )}
          </form>
        </details>
      )}
    </article>
  );
}
