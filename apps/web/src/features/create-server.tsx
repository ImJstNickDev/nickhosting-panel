import { type UiOption, validateUiValues } from '@nickhosting/game-sdk/ui';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { api, idempotencyKey } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { useSession } from '../app/session.js';
import {
  Check,
  Details,
  Empty,
  ErrorNotice,
  Input,
  JobNotice,
  Loading,
  Page,
  Section,
} from '../components/ui.js';
import { creationGamesQuery, prefetchCreationCatalog } from './creation-catalog.js';
import { GameFields } from './game-sections.js';
import { PlayerList, VersionList } from './installer-fields.js';
import { gameUiClient, gameUiRegistry, getGameArtwork } from './integrations.js';
import './installer.css';

type Quota = {
  remaining: { memoryMiB: number; cpuPercent: number; storageMiB: number | null };
  storagePolicy: 'GLOBAL_POOL' | 'PER_USER_BUDGET';
  creationStorage: { mode: 'shared' | 'limited'; defaultDiskMiB: number };
};
export function CreateServerPage() {
  const t = useT(),
    format = useFormat(),
    session = useSession();
  const [step, setStep] = useState(0),
    [gameId, setGameId] = useState(''),
    [values, setValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState(''),
    [memory, setMemory] = useState(2048),
    [cpu, setCpu] = useState(100),
    [disk, setDisk] = useState(4096),
    [preset, setPreset] = useState('small'),
    [autoStart, setAutoStart] = useState(true);
  const [choices, setChoices] = useState<Record<string, UiOption[]>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [failure, setFailure] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{ jobId: string; serverId: string }>();
  const [playerPending, setPlayerPending] = useState(false);
  const [preparedSummary, setPreparedSummary] = useState<{ labelKey: string; value: string }[]>([]);
  const heading = useRef<HTMLHeadingElement>(null),
    key = useRef(idempotencyKey()),
    seeded = useRef(new Set<string>()),
    initializedDisk = useRef(false);
  const games = useQuery(creationGamesQuery);
  const quota = useQuery({
    queryKey: ['creation-quota'],
    queryFn: ({ signal }) => api<Quota>('/v1/platform/quotas', { signal }),
  });
  const module = gameUiRegistry.get(gameId);
  const declaredPages = module?.descriptor.creation.pages ?? [];
  const versionField = declaredPages.find((entry) => entry.kind === 'version-list')?.field;
  const chosenCapabilities = versionField
    ? choices[versionField]?.find((entry) => entry.value === values[versionField])?.capabilities
    : undefined;
  const pages = declaredPages.filter(
    (entry) =>
      !entry.requiredCapability || chosenCapabilities?.[entry.requiredCapability] !== false,
  );
  const beforeName = pages.filter((entry) => entry.position === 'before-name');
  const configurationPages = pages.filter((entry) => entry.position !== 'before-name');
  const nameStep = 1 + beforeName.length,
    configurationStep = nameStep + 1,
    resourcesStep = configurationStep + (configurationPages.length || 1),
    finalStep = resourcesStep + 1;
  const page =
    step > 0 && step < nameStep
      ? beforeName[step - 1]
      : configurationPages[step - configurationStep];
  const title =
    step === 0
      ? 'gameUi.chooseGame'
      : step === nameStep
        ? 'gameUi.nameQuestion'
        : step === resourcesStep
          ? 'gameUi.playersQuestion'
          : step === finalStep
            ? 'gameUi.review'
            : (page?.titleKey ?? 'gameUi.configure');
  const available =
    games.data?.filter(
      (g) => g.access.canCreate && gameUiRegistry.get(g.id) && Boolean(g.manifest.runtimes?.length),
    ) ?? [];
  const shared = quota.data?.creationStorage.mode === 'shared';
  const agreement = module?.descriptor.creation.agreement;
  useEffect(() => {
    heading.current?.focus({ preventScroll: step === 0 });
  }, [step]);
  useEffect(() => {
    if (quota.data && !initializedDisk.current) {
      setDisk(quota.data.creationStorage.defaultDiskMiB);
      initializedDisk.current = true;
    }
  }, [quota.data]);
  const update = (id: string, value: unknown) => {
    const resets = page?.field === id && values[id] !== value ? page.resetFields : [];
    setValues((v) => {
      const next = { ...v, [id]: value };
      for (const field of resets) {
        delete next[field];
        if (module?.descriptor.creation.defaults[field] !== undefined)
          next[field] = module.descriptor.creation.defaults[field];
      }
      return next;
    });
    if (resets.length) {
      setChoices((previous) =>
        Object.fromEntries(Object.entries(previous).filter(([field]) => !resets.includes(field))),
      );
      seeded.current.clear();
      setPreparedSummary([]);
    }
    setErrors((e) => ({ ...e, [id]: '' }));
    key.current = idempotencyKey();
  };
  const receiveChoices = useCallback(
    (options: UiOption[]) => {
      setChoices((previous) => ({ ...previous, [page?.field ?? 'choiceId']: options }));
    },
    [page?.field],
  );
  function selectGame(id: string) {
    const extension = gameUiRegistry.get(id);
    if (!extension) return;
    prefetchCreationCatalog(extension);
    setGameId(id);
    setValues({ ...extension.descriptor.creation.defaults });
    setChoices({});
    seeded.current.clear();
    const initial = extension.descriptor.creation.resourcePresets[0];
    setPreset(initial?.id ?? 'custom');
    if (initial) {
      setMemory(initial.memoryMiB);
      setCpu(initial.cpuPercent);
    }
    key.current = idempotencyKey();
  }
  async function next(event: FormEvent) {
    event.preventDefault();
    if (busy || playerPending || result || !module) return;
    setFailure(undefined);
    setErrors({});
    if (step === nameStep && !name.trim()) {
      setErrors({ name: 'required' });
      return;
    }
    if (page?.kind === 'version-list' || page?.kind === 'choice-list') {
      const selected = choices[page.field]?.some(
        (o) => o.value === values[page.field] && !o.disabled,
      );
      if (!selected) {
        setErrors({ [page.field]: 'unavailable' });
        return;
      }
    }
    if (step === resourcesStep && !quota.data) return;
    let submitValues = values;
    if (step === resourcesStep - 1 || step === finalStep) {
      const effective = agreement ? { ...values, [agreement.field]: true } : values;
      const invalid = validateUiValues(module.descriptor.creation.fields, effective, choices);
      if (invalid.length) {
        setErrors(Object.fromEntries(invalid.map((e) => [e.field, e.code])));
        return;
      }
      if (module.descriptor.creation.prepareHandler) {
        setBusy(true);
        try {
          const prepared = z
            .object({
              values: z.record(z.string(), z.unknown()),
              summary: z.array(z.object({ labelKey: z.string(), value: z.string() })).max(16),
            })
            .parse(
              await module.handlers[module.descriptor.creation.prepareHandler]?.(gameUiClient, {
                values: effective,
              }),
            );
          setValues(prepared.values);
          submitValues = prepared.values;
          setPreparedSummary(prepared.summary);
        } catch (e) {
          setFailure(e);
          return;
        } finally {
          setBusy(false);
        }
      }
    }
    if (step < finalStep) {
      setStep((s) => s + 1);
      return;
    }
    setBusy(true);
    try {
      const submitted = {
        ...submitValues,
        ...(agreement ? { [agreement.field]: true } : {}),
        name,
        limits: { memory, cpu, ...(!shared ? { disk } : {}) },
        autoStart,
      };
      const response = await module.handlers[module.descriptor.creation.createHandler]?.(
        gameUiClient,
        { values: submitted, idempotencyKey: key.current },
      );
      setResult(z.object({ serverId: z.uuid(), jobId: z.uuid() }).parse(response));
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }
  if (result)
    return (
      <Page title={t('web.createServer')}>
        <Section>
          <JobNotice jobId={result.jobId} />
          <Link to={`/servers/${result.serverId}`}>{t('web.overview')}</Link>
        </Section>
      </Page>
    );
  const names = (id: string) => (Array.isArray(values[id]) ? (values[id] as string[]) : []);
  const enabled = page?.toggleField ? values[page.toggleField] === true : false;
  return (
    <div
      className={`installer-shell ${page?.kind === 'toggle-players' ? 'installer-whitelist' : ''} ${enabled ? 'is-enabled' : ''}`}
    >
      <div className="installer-position">
        {t('gameUi.stepOf', { current: step + 1, total: finalStep + 1 })}
      </div>
      <form className="installer-form" onSubmit={(e) => void next(e)} aria-busy={busy}>
        <header className="installer-heading">
          <h1 ref={heading} tabIndex={-1}>
            {t(title)}
          </h1>
          {step === nameStep && <p>{t('gameUi.nameHint')}</p>}
        </header>
        {failure !== undefined && <ErrorNotice error={failure} />}
        {Object.values(errors).some(Boolean) && <div role="alert">{t('gameUi.required')}</div>}
        <fieldset disabled={busy}>
          {step === 0 &&
            (games.isPending ? (
              <Loading />
            ) : games.error ? (
              <ErrorNotice error={games.error} retry={() => void games.refetch()} />
            ) : !available.length ? (
              <>
                <Empty text={t('gameUi.noGames')} />
                {session.data?.context.role === 'owner' && (
                  <Link to="/owner/integrations">{t('gameUi.noGamesOwner')}</Link>
                )}
              </>
            ) : (
              <div className="installer-games">
                {available.map((game) => {
                  const extension = gameUiRegistry.get(game.id);
                  if (!extension) return null;
                  const art = getGameArtwork(game.id);
                  return (
                    <button
                      type="button"
                      key={game.id}
                      className="game-card secondary"
                      aria-pressed={gameId === game.id}
                      onClick={() => selectGame(game.id)}
                    >
                      {art && <img src={art} alt="" width={480} height={240} />}
                      <span>{t(extension.descriptor.nameKey)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          {step === nameStep && (
            <Input
              label={t('gameUi.serverName')}
              required
              maxLength={100}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                key.current = idempotencyKey();
              }}
            />
          )}
          {page && module && (
            <>
              {(page.kind === 'version-list' || page.kind === 'choice-list') && (
                <VersionList
                  module={module}
                  fieldId={page.field}
                  versionFilter={page.kind === 'version-list'}
                  presentation={page.kind === 'choice-list' ? 'cards' : 'list'}
                  values={values}
                  value={values[page.field]}
                  onChange={(v) => update(page.field, v)}
                  onChoices={receiveChoices}
                />
              )}
              {page.kind === 'players' && page.lookupHandler && (
                <PlayerList
                  module={module}
                  handler={page.lookupHandler}
                  onPendingChange={setPlayerPending}
                  names={names(page.field)}
                  onChange={(v) => update(page.field, v)}
                />
              )}
              {page.kind === 'toggle-players' && page.toggleField && (
                <>
                  <fieldset className="installer-toggle" aria-label={t(page.titleKey)}>
                    {[true, false].map((on) => (
                      <button
                        key={String(on)}
                        type="button"
                        className={enabled === on ? '' : 'secondary'}
                        aria-pressed={enabled === on}
                        disabled={playerPending}
                        onClick={() => {
                          if (on && !seeded.current.has(page.id)) {
                            update(page.field, page.seedField ? [...names(page.seedField)] : []);
                            seeded.current.add(page.id);
                          }
                          update(page.toggleField as string, on);
                        }}
                      >
                        {t(on ? 'gameUi.yes' : 'gameUi.no')}
                      </button>
                    ))}
                  </fieldset>
                  <div className="installer-reveal" inert={!enabled} aria-hidden={!enabled}>
                    <div>
                      {page.lookupHandler && (
                        <PlayerList
                          module={module}
                          handler={page.lookupHandler}
                          onPendingChange={setPlayerPending}
                          names={names(page.field)}
                          onChange={(v) => update(page.field, v)}
                        />
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
          {step === configurationStep && !configurationPages.length && module && (
            <GameFields
              module={module}
              fields={module.descriptor.creation.fields}
              values={values}
              onChange={update}
              errors={errors}
              onChoices={(field, options) => setChoices((v) => ({ ...v, [field]: options }))}
            />
          )}
          {step === resourcesStep &&
            (quota.isPending ? (
              <Loading />
            ) : quota.error ? (
              <ErrorNotice error={quota.error} retry={() => void quota.refetch()} />
            ) : (
              <>
                <fieldset className="installer-presets" aria-label={t('gameUi.resources')}>
                  {module?.descriptor.creation.resourcePresets.map((p) => (
                    <button
                      type="button"
                      key={p.id}
                      className={preset === p.id ? '' : 'secondary'}
                      aria-pressed={preset === p.id}
                      onClick={() => {
                        setPreset(p.id);
                        setMemory(p.memoryMiB);
                        setCpu(p.cpuPercent);
                        key.current = idempotencyKey();
                      }}
                    >
                      {t(p.labelKey)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={preset === 'custom' ? '' : 'secondary'}
                    aria-pressed={preset === 'custom'}
                    onClick={() => setPreset('custom')}
                  >
                    {t('gameUi.customResources')}
                  </button>
                </fieldset>
                {preset !== 'custom' && (
                  <>
                    <p className="muted">{t('gameUi.resourceSuggestion')}</p>
                    <Details
                      values={[
                        [t('gameUi.memory'), format.number(memory)],
                        [t('gameUi.cpu'), format.number(cpu)],
                      ]}
                    />
                  </>
                )}
                {preset === 'custom' && (
                  <div className="installer-custom">
                    <Input
                      label={t('gameUi.memory')}
                      type="number"
                      min={32}
                      max={1048576}
                      required
                      value={memory}
                      onChange={(e) => {
                        setMemory(Number(e.target.value));
                        key.current = idempotencyKey();
                      }}
                    />
                    <Input
                      label={t('gameUi.cpu')}
                      type="number"
                      min={1}
                      max={100000}
                      required
                      value={cpu}
                      onChange={(e) => {
                        setCpu(Number(e.target.value));
                        key.current = idempotencyKey();
                      }}
                    />
                  </div>
                )}
                {shared ? (
                  <p className="muted">{t('gameUi.sharedStorage')}</p>
                ) : (
                  <Input
                    label={t('gameUi.disk')}
                    type="number"
                    min={16}
                    max={1073741824}
                    required
                    value={disk}
                    onChange={(e) => {
                      setDisk(Number(e.target.value));
                      key.current = idempotencyKey();
                    }}
                  />
                )}
                <Check
                  label={t('gameUi.startAfter')}
                  checked={autoStart}
                  onChange={(e) => {
                    setAutoStart(e.target.checked);
                    key.current = idempotencyKey();
                  }}
                />
                {autoStart && <p className="muted">{t('gameUi.startCapacity')}</p>}
              </>
            ))}
          {step === finalStep && (
            <>
              <Details
                values={[
                  [t('gameUi.serverName'), name],
                  ...preparedSummary.map(({ labelKey, value }): [string, string] => [
                    t(labelKey),
                    value,
                  ]),
                  [t('gameUi.memory'), format.number(memory)],
                  [t('gameUi.cpu'), format.number(cpu)],
                ]}
              />
              {agreement && (
                <p className="installer-agreement">
                  {t(agreement.textKey)}{' '}
                  <a href={agreement.url} target="_blank" rel="noopener noreferrer">
                    {t(agreement.linkKey)}
                  </a>
                  .
                </p>
              )}
            </>
          )}
        </fieldset>
        <footer className="installer-actions">
          {step > 0 && (
            <button
              type="button"
              className="secondary"
              disabled={busy || playerPending}
              onClick={() => {
                setErrors({});
                setFailure(undefined);
                setStep((s) => s - 1);
              }}
            >
              {t('web.back')}
            </button>
          )}
          <button
            type="submit"
            disabled={busy || playerPending || !module || (step === resourcesStep && !quota.data)}
          >
            {t(step === finalStep ? 'web.createServer' : 'web.next')}
          </button>
        </footer>
      </form>
    </div>
  );
}
