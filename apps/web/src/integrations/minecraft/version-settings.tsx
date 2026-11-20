import {
  createMinecraftUiController,
  type MinecraftVersionChangeRequest,
} from '@nickhosting/minecraft/ui';
import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router';
import { ApiError, idempotencyKey } from '../../api/client.js';
import { useT } from '../../app/i18n.js';
import { Check, Dialog, ErrorNotice, Loading, Select } from '../../components/ui.js';
import type { GameFormViewProps } from '../../features/game-form-view.js';
import { gameUiClient } from '../../features/integrations.js';

const controller = createMinecraftUiController(gameUiClient);
const key = (id: string) => `games.minecraft.versionChange.${id}`;
type Catalog = Awaited<ReturnType<typeof controller.versionCatalog>>;
type Target = Catalog['choices'][number];
type Review = { target: Target; sourceCombinationId: string; loaderVersion?: string };
function loaderChoices(catalog: Catalog, target: Target) {
  const runtime = target.runtime;
  if (runtime === 'forge' || runtime === 'neoforge')
    return catalog.loaders[runtime][target.version] ?? [];
  if (runtime === 'fabric' || runtime === 'quilt') return catalog.loaders[runtime];
  return undefined;
}

export function MinecraftVersionSettings(props: GameFormViewProps) {
  const t = useT();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState<string>();
  const [choice, setChoice] = useState('');
  const [loader, setLoader] = useState('');
  const [review, setReview] = useState<Review>();
  const [mode, setMode] = useState<MinecraftVersionChangeRequest['mode']>();
  const [backup, setBackup] = useState(false);
  const [uncertain, setUncertain] = useState<MinecraftVersionChangeRequest>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [job, setJob] = useState<string>();
  const lock = useRef(false);
  const catalog = useQuery({
    queryKey: ['minecraft-version-catalog', props.serverId],
    queryFn: ({ signal }) => controller.versionCatalog(props.serverId, signal),
    enabled: open,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const data = catalog.data;
  const selectedRuntime = runtime ?? data?.current.runtime;
  const choices = data?.choices.filter((entry) => entry.runtime === selectedRuntime) ?? [];
  const target = choices.find((entry) => entry.id === choice);
  const loaders = target && data ? loaderChoices(data, target) : undefined;
  const canBackup = props.permissions.includes('backups.create');
  const backupUnavailable = mode === 'keep' && backup && !canBackup;
  const stopped = props.runtimeState === 'offline' || props.runtimeState === 'stopped';
  const blocked = props.operationPending || props.dirty || !stopped;
  const changed =
    target &&
    data &&
    (target.runtime !== data.current.runtime ||
      target.version !== data.current.version ||
      (loader || null) !== data.current.loaderVersion);
  const ready =
    !blocked &&
    !catalog.isFetching &&
    !catalog.error &&
    changed &&
    (!loaders || loaders.includes(loader));
  const runtimeLabel = (value: string) => t(`games.minecraft.runtimes.${value}`);
  const currentRuntime = props.data.metadata?.runtime;
  const currentVersion = props.data.metadata?.version;
  function openDialog() {
    if (!uncertain) {
      setRuntime(undefined);
      setChoice('');
      setLoader('');
      setMode(undefined);
      setBackup(false);
      setReview(undefined);
      setError(undefined);
    }
    setOpen(true);
  }
  async function submit() {
    if (lock.current || !review || !mode || ((blocked || backupUnavailable) && !uncertain)) return;
    const request = uncertain ?? {
      sourceCombinationId: review.sourceCombinationId,
      choiceId: review.target.id,
      ...(review.loaderVersion ? { loaderVersion: review.loaderVersion } : {}),
      mode,
      confirm: true,
      backupBefore: mode === 'keep' && backup,
      idempotencyKey: idempotencyKey(),
    };
    setBusy(true);
    lock.current = true;
    setError(undefined);
    try {
      const result = await controller.changeVersion(props.serverId, request);
      setUncertain(undefined);
      setJob(result.jobId);
      setOpen(false);
      props.onAccepted(result.jobId);
    } catch (failure) {
      // A lost response must replay exactly the confirmed request, even after closing the dialog.
      if (
        uncertain ||
        !(failure instanceof ApiError) ||
        failure.status >= 500 ||
        failure.code === 'operation_uncertain'
      )
        setUncertain(request);
      else setUncertain(undefined);
      setError(failure);
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  return (
    <section className="minecraft-settings-group" aria-labelledby={id}>
      <h2 id={id}>{t(key('heading'))}</h2>
      <div className="minecraft-settings-surface minecraft-settings-row">
        <div>
          {typeof currentRuntime === 'string' && typeof currentVersion === 'string' && (
            <strong>
              {runtimeLabel(currentRuntime)} {currentVersion}
            </strong>
          )}
          {!stopped && <p className="minecraft-settings-hint">{t(key('stopFirst'))}</p>}
          {props.dirty && <p className="minecraft-settings-hint">{t(key('saveFirst'))}</p>}
          {job && (
            <p className="minecraft-settings-hint" role="status">
              <Link to={`/activity/${job}`}>{t(key('operation'))}</Link>
            </p>
          )}
        </div>
        <button
          type="button"
          className="secondary"
          disabled={blocked && !uncertain}
          onClick={openDialog}
        >
          {t(key('change'))}
        </button>
      </div>
      {open &&
        createPortal(
          <Dialog
            open
            closeIcon
            title={t(key('change'))}
            closeDisabled={busy}
            className="minecraft-version-dialog"
            onClose={() => {
              if (!lock.current) setOpen(false);
            }}
          >
            {!review ? (
              <>
                {catalog.error ? (
                  <ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} />
                ) : !data ? (
                  <Loading />
                ) : (
                  <div className="minecraft-version-fields">
                    <Select
                      label={t('games.minecraft.fields.runtime')}
                      value={selectedRuntime ?? ''}
                      onChange={(event) => {
                        setRuntime(event.target.value);
                        setChoice('');
                        setLoader('');
                      }}
                    >
                      {[
                        ...new Set([
                          data.current.runtime,
                          ...data.choices.map((entry) => entry.runtime),
                        ]),
                      ].map((item) => (
                        <option key={item} value={item}>
                          {runtimeLabel(item)}
                        </option>
                      ))}
                    </Select>
                    <Select
                      label={t(key('target'))}
                      value={choice}
                      onChange={(event) => {
                        setChoice(event.target.value);
                        setLoader('');
                      }}
                    >
                      <option value="">{t('games.minecraft.installer.version')}</option>
                      {choices.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.version}
                        </option>
                      ))}
                    </Select>
                    {loaders && (
                      <Select
                        label={t('games.minecraft.fields.loaderVersion')}
                        value={loader}
                        onChange={(event) => setLoader(event.target.value)}
                      >
                        <option value="">{t('games.minecraft.installer.loader')}</option>
                        {loaders.map((item) => (
                          <option key={item} value={item}>
                            {item}
                          </option>
                        ))}
                      </Select>
                    )}
                    {!choices.length && <p role="status">{t(key('noChoices'))}</p>}
                  </div>
                )}
                <div className="dialog-actions">
                  <button
                    type="button"
                    disabled={!ready}
                    onClick={() => {
                      if (target && data && ready)
                        setReview({
                          target,
                          sourceCombinationId: data.current.combinationId,
                          ...(loader ? { loaderVersion: loader } : {}),
                        });
                    }}
                  >
                    {t(key('continue'))}
                  </button>
                </div>
              </>
            ) : (
              <>
                <p className="minecraft-version-target">
                  {runtimeLabel(review.target.runtime)} {review.target.version}
                  {review.loaderVersion ? ` · ${review.loaderVersion}` : ''}
                </p>
                <fieldset className="minecraft-version-modes" disabled={busy || Boolean(uncertain)}>
                  <legend>{t(key('files'))}</legend>
                  {(['keep', 'fresh'] as const).map((value) => (
                    <label key={value}>
                      <input
                        type="radio"
                        name={`${id}-mode`}
                        checked={mode === value}
                        onChange={() => {
                          setMode(value);
                          setBackup(false);
                          setError(undefined);
                        }}
                      />
                      <span>
                        <strong>{t(key(value))}</strong>
                        <small>{t(key(`${value}Hint`))}</small>
                      </span>
                    </label>
                  ))}
                  {mode === 'keep' && (canBackup || backup) && (
                    <Check
                      label={t(key('backup'))}
                      checked={backup}
                      onChange={(event) => setBackup(event.target.checked)}
                    />
                  )}
                </fieldset>
                {backupUnavailable && <p role="status">{t(key('backupUnavailable'))}</p>}
                {error && <ErrorNotice error={error} />}
                <div className="dialog-actions">
                  {!uncertain && (
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        setReview(undefined);
                        setMode(undefined);
                        setBackup(false);
                        setError(undefined);
                      }}
                    >
                      {t(key('back'))}
                    </button>
                  )}
                  <button
                    type="button"
                    className={mode === 'fresh' ? 'danger' : undefined}
                    disabled={busy || !mode || ((blocked || backupUnavailable) && !uncertain)}
                    onClick={() => void submit()}
                  >
                    {t(key(uncertain ? 'retry' : mode === 'fresh' ? 'confirmFresh' : 'change'))}
                  </button>
                </div>
              </>
            )}
          </Dialog>,
          document.body,
        )}
    </section>
  );
}
