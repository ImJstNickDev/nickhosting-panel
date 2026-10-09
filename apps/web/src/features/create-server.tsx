import { type UiOption, validateUiValues } from '@nickhosting/game-sdk/ui';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import { api, idempotencyKey } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  Check,
  Details,
  Empty,
  ErrorNotice,
  Input,
  JobNotice,
  Loading,
  Notice,
  Page,
  Section,
  Select,
} from '../components/ui.js';
import { GameFields } from './game-sections.js';
import { gameUiClient, gameUiRegistry, getGameArtwork } from './integrations.js';

type GameEntry = { id: string; access: { canCreate: boolean }; manifest: { runtimes?: unknown[] } };
type Quota = {
  remaining: { memoryMiB: number; cpuPercent: number; storageMiB: number | null };
  limits: { memoryMiB: number; cpuPercent: number; storageMiB: number | null };
};
export function CreateServerPage() {
  const t = useT(),
    format = useFormat();
  const [step, setStep] = useState(0),
    [gameId, setGameId] = useState(''),
    [values, setValues] = useState<Record<string, unknown>>({});
  const [name, setName] = useState(''),
    [projectId, setProjectId] = useState(''),
    [memory, setMemory] = useState(1024),
    [cpu, setCpu] = useState(100),
    [disk, setDisk] = useState(4096),
    [autoStart, setAutoStart] = useState(true);
  const [choices, setChoices] = useState<Record<string, UiOption[]>>({}),
    [errors, setErrors] = useState<Record<string, string>>({}),
    [failure, setFailure] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<{ jobId: string; serverId: string }>();
  const [preparedSummary, setPreparedSummary] = useState<{ labelKey: string; value: string }[]>([]);
  const heading = useRef<HTMLHeadingElement>(null),
    errorSummary = useRef<HTMLDivElement>(null),
    key = useRef(idempotencyKey());
  const games = useQuery({
    queryKey: ['creation-games'],
    queryFn: ({ signal }) => api<GameEntry[]>('/v1/games', { signal }),
  });
  const projects = useQuery({
    queryKey: ['creation-projects'],
    queryFn: ({ signal }) =>
      api<{ items: { id: string; name: string }[] }>('/v1/platform/projects?limit=100', { signal }),
  });
  const quota = useQuery({
    queryKey: ['creation-quota'],
    queryFn: ({ signal }) => api<Quota>('/v1/platform/quotas', { signal }),
  });
  const module = gameUiRegistry.get(gameId);
  const available =
    games.data?.filter(
      (game) =>
        game.access.canCreate &&
        gameUiRegistry.get(game.id) &&
        Boolean(game.manifest.runtimes?.length),
    ) ?? [];
  const steps = ['gameUi.chooseGame', 'gameUi.configure', 'gameUi.resources', 'gameUi.create'];
  useEffect(() => {
    heading.current?.focus({ preventScroll: step === 0 });
  }, [step]);
  const update = (id: string, value: unknown) => {
    setValues((previous) => ({ ...previous, [id]: value }));
    setErrors((previous) => ({ ...previous, [id]: '' }));
    key.current = idempotencyKey();
  };
  async function next(event: FormEvent) {
    event.preventDefault();
    if (busy || result) return;
    setFailure(undefined);
    if (step === 0) {
      if (!module) return;
      setStep(1);
      return;
    }
    if (step === 1 && module) {
      const invalid = validateUiValues(module.descriptor.creation.fields, values, choices);
      setErrors(Object.fromEntries(invalid.map((e) => [e.field, e.code])));
      if (invalid.length || !name.trim()) {
        setTimeout(() => errorSummary.current?.focus(), 0);
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
                values,
              }),
            );
          setValues(prepared.values);
          setPreparedSummary(prepared.summary);
        } catch (error) {
          setFailure(error);
          return;
        } finally {
          setBusy(false);
        }
      }
      setStep(2);
      return;
    }
    if (step === 2) {
      setStep(3);
      return;
    }
    if (!module) return;
    setBusy(true);
    try {
      const submitted = {
        ...values,
        name,
        projectId: projectId || undefined,
        limits: { memory, cpu, disk },
        autoStart,
      };
      const response = await module.handlers[module.descriptor.creation.createHandler]?.(
        gameUiClient,
        { values: submitted, idempotencyKey: key.current },
      );
      setResult(z.object({ serverId: z.uuid(), jobId: z.uuid() }).parse(response));
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title={t('web.createServer')}>
      <nav aria-label={t('gameUi.steps')}>
        <ol className="toolbar">
          {steps.map((label, index) => (
            <li key={label} aria-current={step === index ? 'step' : undefined}>
              {t(label)}
            </li>
          ))}
        </ol>
      </nav>
      {result ? (
        <Section>
          <JobNotice jobId={result.jobId} />
          <Link to={`/servers/${result.serverId}`}>{t('web.overview')}</Link>
        </Section>
      ) : (
        <Section>
          <h2 ref={heading} tabIndex={-1}>
            {t(steps[step] ?? 'gameUi.create')}
          </h2>
          {failure !== undefined && <ErrorNotice error={failure} />}
          <form className="form" onSubmit={(event) => void next(event)} aria-busy={busy}>
            <fieldset disabled={busy}>
              {step === 0 &&
                (games.isPending ? (
                  <Loading />
                ) : games.error ? (
                  <ErrorNotice error={games.error} retry={() => void games.refetch()} />
                ) : !available.length ? (
                  <Empty text={t('gameUi.noGames')} />
                ) : (
                  <div className="columns">
                    {available.map((game) => {
                      const extension = gameUiRegistry.get(game.id);
                      if (!extension) return null;
                      const art = getGameArtwork(game.id);
                      return (
                        <button
                          key={game.id}
                          type="button"
                          className="game-card secondary"
                          aria-pressed={gameId === game.id}
                          onClick={() => {
                            setGameId(game.id);
                            setValues({ ...extension.descriptor.creation.defaults });
                            setChoices({});
                            key.current = idempotencyKey();
                          }}
                        >
                          <span
                            style={{
                              display: 'grid',
                              gap: '.7rem',
                              textAlign: 'left',
                              width: '100%',
                            }}
                          >
                            {art && (
                              <img
                                src={art}
                                alt=""
                                width={480}
                                height={240}
                                style={{
                                  width: '100%',
                                  height: 'auto',
                                  aspectRatio: '2 / 1',
                                  objectFit: 'cover',
                                  borderRadius: 3,
                                }}
                                onError={(event) => {
                                  event.currentTarget.hidden = true;
                                }}
                              />
                            )}
                            <span>{t(extension.descriptor.nameKey)}</span>
                            {gameId === game.id && <small>{t('gameUi.selected')}</small>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
              {step === 1 && module && (
                <>
                  {Object.values(errors).some(Boolean) && (
                    <div role="alert" tabIndex={-1} ref={errorSummary}>
                      {t('gameUi.required')}
                    </div>
                  )}
                  <Input
                    label={t('gameUi.serverName')}
                    required
                    maxLength={100}
                    value={name}
                    onChange={(event) => {
                      setName(event.target.value);
                      key.current = idempotencyKey();
                    }}
                  />
                  {projects.error ? (
                    <ErrorNotice error={projects.error} />
                  ) : (
                    <Select
                      label={t('gameUi.project')}
                      value={projectId}
                      disabled={projects.isPending}
                      onChange={(event) => setProjectId(event.target.value)}
                    >
                      <option value="">{t('gameUi.noProject')}</option>
                      {projects.data?.items.map((project) => (
                        <option key={project.id} value={project.id}>
                          {project.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  <GameFields
                    module={module}
                    fields={module.descriptor.creation.fields}
                    values={values}
                    onChange={update}
                    errors={errors}
                    onChoices={(field, options) =>
                      setChoices((previous) => ({ ...previous, [field]: options }))
                    }
                  />
                </>
              )}
              {step === 2 && (
                <>
                  {quota.isPending ? (
                    <Loading />
                  ) : quota.error ? (
                    <ErrorNotice error={quota.error} retry={() => void quota.refetch()} />
                  ) : (
                    quota.data && (
                      <div className="stack">
                        <p>
                          {t('gameUi.remainingMemory', {
                            value: format.number(quota.data.remaining.memoryMiB),
                          })}
                        </p>
                        <p>
                          {t('gameUi.remainingCpu', {
                            value: format.number(quota.data.remaining.cpuPercent),
                          })}
                        </p>
                        <p>
                          {quota.data.remaining.storageMiB === null
                            ? t('gameUi.sharedStorage')
                            : t('gameUi.remainingDisk', {
                                value: format.number(quota.data.remaining.storageMiB),
                              })}
                        </p>
                      </div>
                    )
                  )}
                  <Input
                    label={t('gameUi.memory')}
                    type="number"
                    min={32}
                    max={1048576}
                    step={1}
                    required
                    value={memory}
                    onChange={(event) => {
                      setMemory(Number(event.target.value));
                      key.current = idempotencyKey();
                    }}
                  />
                  <Input
                    label={t('gameUi.cpu')}
                    type="number"
                    min={1}
                    max={100000}
                    step={1}
                    required
                    value={cpu}
                    onChange={(event) => {
                      setCpu(Number(event.target.value));
                      key.current = idempotencyKey();
                    }}
                  />
                  <Input
                    label={t('gameUi.disk')}
                    type="number"
                    min={16}
                    max={1073741824}
                    step={1}
                    required
                    value={disk}
                    onChange={(event) => {
                      setDisk(Number(event.target.value));
                      key.current = idempotencyKey();
                    }}
                  />
                  <Check
                    label={t('gameUi.startAfter')}
                    checked={autoStart}
                    onChange={(event) => {
                      setAutoStart(event.target.checked);
                      key.current = idempotencyKey();
                    }}
                  />
                  {autoStart && <Notice>{t('gameUi.startCapacity')}</Notice>}
                </>
              )}
              {step === 3 && module && (
                <Details
                  values={[
                    [t('gameUi.serverName'), name],
                    [t('gameUi.chooseGame'), t(module.descriptor.nameKey)],
                    ...preparedSummary.map(({ labelKey, value }): [string, string] => [
                      t(labelKey),
                      value,
                    ]),
                    [
                      t('gameUi.project'),
                      projects.data?.items.find((p) => p.id === projectId)?.name ??
                        t('gameUi.noProject'),
                    ],
                    [t('gameUi.memory'), format.number(memory)],
                    [t('gameUi.cpu'), format.number(cpu)],
                    [t('gameUi.disk'), format.number(disk)],
                    [t('gameUi.startAfter'), t(autoStart ? 'gameUi.yes' : 'gameUi.no')],
                  ]}
                />
              )}
            </fieldset>
            <div className="actions">
              {step > 0 && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => setStep((previous) => previous - 1)}
                >
                  {t('web.back')}
                </button>
              )}
              <button type="submit" disabled={busy || (step === 0 && !module)}>
                {t(step === 3 ? 'web.createServer' : 'web.next')}
              </button>
            </div>
          </form>
        </Section>
      )}
    </Page>
  );
}
