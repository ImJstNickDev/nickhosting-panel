import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { satisfactorySaveDirectory } from '../../../../../games/satisfactory/src/world-paths.js';
import { api } from '../../api/client.js';
import { useFormat, useT } from '../../app/i18n.js';
import { useUnsavedChanges } from '../../components/navigation-guard.js';
import { ConfirmDialog, ErrorNotice, Input } from '../../components/ui.js';
import { Pagination, SearchField } from '../../components/workspace-controls.js';
import type { GameSectionViewProps } from '../../features/game-section-view.js';
import './worlds.css';

const key = (name: string) => `games.satisfactory.worlds.${name}`;
type Save = {
  saveName: string;
  sessionName: string;
  saveDateTime: string;
  playDurationSeconds: number;
  buildVersion: number;
  isModdedSave: boolean;
  isEditedSave: boolean;
  isCreativeModeEnabled: boolean;
};
type Worlds = {
  sessions: { sessionName: string; saveHeaders: Save[] }[];
  currentSessionIndex: number;
};
type Action = { kind: 'save' | 'create' } | { kind: 'load'; save: Save };

export function SatisfactoryWorldsSection(props: GameSectionViewProps) {
  const t = useT(),
    format = useFormat(),
    client = useQueryClient();
  const base = `/v1/servers/${encodeURIComponent(props.serverId)}/satisfactory/api`;
  const online = props.runtimeState === 'running' || props.runtimeState === 'online';
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(0);
  const [action, setAction] = useState<Action>(),
    [name, setName] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const [completed, setCompleted] = useState(false);
  const [loadingUntil, setLoadingUntil] = useState(0);
  useEffect(() => {
    if (!loadingUntil) return;
    const timer = setTimeout(() => setLoadingUntil(0), Math.max(0, loadingUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [loadingUntil]);
  const lock = useRef(false);
  useUnsavedChanges(Boolean(action && name), busy);
  const config = useQuery({
    queryKey: ['satisfactory-api', props.serverId],
    queryFn: ({ signal }) => api<{ configured: boolean }>(base, { signal }),
  });
  const enabled = online && config.data?.configured === true;
  const worlds = useQuery({
    queryKey: ['satisfactory-worlds', props.serverId, props.runtimeState],
    enabled,
    queryFn: ({ signal }) => api<Worlds>(`${base}/worlds`, { signal }),
    refetchInterval: loadingUntil > Date.now() ? 3000 : false,
  });
  const rows = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    return (worlds.data?.sessions ?? [])
      .flatMap((session, index) =>
        session.saveHeaders.map((save) => ({
          ...save,
          sessionName: session.sessionName,
          active: index === worlds.data?.currentSessionIndex,
        })),
      )
      .filter(
        (save) =>
          !term || `${save.sessionName} ${save.saveName}`.toLocaleLowerCase().includes(term),
      )
      .sort((a, b) => b.saveDateTime.localeCompare(a.saveDateTime));
  }, [worlds.data, search]);
  const lastPage = Math.max(0, Math.ceil(rows.length / 30) - 1),
    currentPage = Math.min(page, lastPage);
  const editable = props.canManage && enabled && !props.pending && !busy && !loadingUntil;
  const nameExists =
    worlds.data?.sessions.some((session) =>
      session.saveHeaders.some((save) => save.saveName.toLowerCase() === name.toLowerCase()),
    ) === true;
  const nameValid =
    action?.kind === 'save'
      ? /^[A-Za-z0-9_-]{1,80}$/.test(name) && !nameExists
      : name.trim().length > 0 &&
        name.length <= 128 &&
        !/[\\/]/.test(name) &&
        !Array.from(name).some((character) => character.charCodeAt(0) < 32) &&
        !worlds.data?.sessions.some(
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
        client.invalidateQueries({ queryKey: ['satisfactory-advanced', props.serverId] }),
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
      <div className="satisfactory-worlds-toolbar">
        <h2>{t(key('title'))}</h2>
        <div className="actions">
          <button
            type="button"
            className="secondary"
            disabled={!enabled || worlds.isFetching || busy || props.pending}
            onClick={() => {
              setCompleted(false);
              void worlds.refetch();
            }}
          >
            {t(key('refresh'))}
          </button>
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
      </div>
      {props.permissionKeys.includes('files.read') && (
        <div className="satisfactory-worlds-transfers">
          <Link
            to={`/servers/${encodeURIComponent(props.serverId)}/files?directory=${encodeURIComponent(satisfactorySaveDirectory)}`}
          >
            {t(key('files'))}
          </Link>
          <p>{t(key('filesHint'))}</p>
        </div>
      )}
      {(config.error ?? worlds.error) != null && (
        <ErrorNotice error={config.error ?? worlds.error} />
      )}
      {config.isPending && <p role="status">{t('web.loading')}</p>}
      {config.data?.configured === false && <p>{t(key('unconfigured'))}</p>}
      {!online && <p role="status">{t(key('startFirst'))}</p>}
      {!props.canManage && <p>{t(key('readOnly'))}</p>}
      {props.pending && <p role="status">{t(key('pending'))}</p>}
      {completed && <p role="status">{t(key(loadingUntil ? 'loadingWorld' : 'completed'))}</p>}
      {enabled && worlds.isPending && <p role="status">{t('web.loading')}</p>}
      {enabled && worlds.data && (
        <>
          <SearchField
            label={t(key('search'))}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(0);
            }}
          />
          {rows.length === 0 ? (
            <p role="status">{t(key(search.trim() ? 'noMatches' : 'empty'))}</p>
          ) : (
            <ul className="satisfactory-worlds-list">
              {rows.slice(currentPage * 30, (currentPage + 1) * 30).map((save) => (
                <li key={`${save.sessionName}/${save.saveName}`}>
                  <div className="satisfactory-worlds-identity">
                    <strong>{save.saveName}</strong>
                    <div className="satisfactory-worlds-meta">
                      <span>{save.sessionName}</span>
                      {save.active && (
                        <span className="satisfactory-worlds-active">
                          {t(key('activeSession'))}
                        </span>
                      )}
                      {save.isModdedSave && <span>{t(key('modded'))}</span>}
                      {save.isCreativeModeEnabled && <span>{t(key('creative'))}</span>}
                      {save.isEditedSave && <span>{t(key('edited'))}</span>}
                    </div>
                  </div>
                  <dl className="satisfactory-worlds-details">
                    <div>
                      <dt>{t(key('savedAt'))}</dt>
                      <dd>
                        {Number.isFinite(Date.parse(save.saveDateTime))
                          ? format.date(save.saveDateTime)
                          : '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>{t(key('playTime'))}</dt>
                      <dd>
                        {t(key('hours'), { value: format.number(save.playDurationSeconds / 3600) })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t(key('build'))}</dt>
                      <dd>{String(save.buildVersion)}</dd>
                    </div>
                  </dl>
                  {props.canManage && (
                    <button
                      className="secondary"
                      type="button"
                      disabled={!editable}
                      aria-label={t(key('loadNamed'), { name: save.saveName })}
                      onClick={() => choose({ kind: 'load', save })}
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
