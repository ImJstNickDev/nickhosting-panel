import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError, api, queryClient } from '../api/client.js';
import { useFormat, useT } from '../app/i18n.js';
import { CatalogBrowser, initialCatalogRequest } from '../components/catalog-browser.js';
import { ScanProgress } from '../components/scan-progress.js';
import {
  ActionForm,
  Check,
  Details,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Page,
  Section,
  Select,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { type CatalogBatch, type CatalogMeasurement, syncCatalogPages } from './catalog-sync.js';

const checks = [
  'installation',
  'status',
  'intentionalJoin',
  'sleepingResponse',
  'wakingResponse',
  'blockedResponse',
  'manualStop',
  'transparentLogin',
  'readiness',
  'playerIdle',
  'wakeAdmission',
  'gracefulSave',
] as const;
const semantics = [
  'release',
  'buildId',
  'loaderVersion',
  'loaderCoordinate',
  'installerVersion',
  'serverArtifactUrl',
  'installerArtifactUrl',
] as const;
interface Mapping {
  id: string;
  game_id: string;
  runtime_id: string;
  nest_id: number;
  egg_id: number;
  docker_image: string;
  image_mode?: 'static' | 'integration';
  environment: Record<string, string>;
}
interface Egg {
  id: number;
  name: string;
  relationships?: { variables?: { data: { attributes: { env_variable: string } }[] } };
}
interface Evidence {
  runId: string;
  kind: string;
  recordedAt: string;
  checks: Record<string, boolean>;
  client?: { implementation: string; version: string; protocolId: number };
  server?: { uuid: string; javaMajor: number; imageDigest: string };
  evidenceSha256: string;
}
interface Combination {
  id: string;
  mappingId: string;
  enabled: boolean;
  support: string;
  releaseTime?: string | null;
  releaseTimeStatus?: 'available' | 'unknown' | 'unavailable';
  supportAuthority?: 'integration' | 'evidence';
  capabilities?: {
    installation: boolean;
    directConnection: boolean;
    gateway: boolean;
    readiness: boolean;
    playerIdle: boolean;
    sleepWake: boolean;
    playerManagement: boolean;
  };
  combination: {
    release: string;
    releaseType?: string;
    profile: string;
    javaMajor: number;
    protocolId: number | null;
    family: string;
    buildId?: string;
    loaderVersion?: string;
  };
  evidence: Evidence[];
}

/** Owner-only technical UI. Ordinary creation never imports this support matrix. */
export function OwnerMinecraftPage() {
  const t = useT();
  const [catalogRequest, setCatalogRequest] = useState(initialCatalogRequest);
  const combinations = useQuery({
    queryKey: ['owner-minecraft-compatibility', catalogRequest],
    staleTime: 60_000,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) =>
      api<{
        items: Combination[];
        total: number;
        page: number;
        pageSize: number;
        runtimes: string[];
        metadataStatus: { lastSuccessAt: string | null; stale: boolean };
      }>(
        `/v1/owner/minecraft/compatibility?${new URLSearchParams({ view: 'summary', pageSize: '25', page: String(catalogRequest.page), search: catalogRequest.search, order: catalogRequest.order, ...Object.fromEntries(Object.entries(catalogRequest.filters).filter(([, value]) => value)) })}`,
        { signal },
      ),
  });
  const [selected, setSelected] = useState<string>('');
  const detail = useQuery({
    queryKey: ['owner-minecraft-detail', selected],
    enabled: Boolean(selected),
    queryFn: ({ signal }) =>
      api<Combination>(`/v1/owner/minecraft/compatibility/${selected}`, { signal }),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['owner-minecraft-compatibility'] });
    if (selected) void detail.refetch();
  };
  return (
    <Page title={t('gameAdmin.minecraft')}>
      <Notice>{t('gameAdmin.evidenceBoundary')}</Notice>
      <Section title={t('gameAdmin.combinations')}>
        {combinations.isPending ? (
          <Loading />
        ) : combinations.error ? (
          <ErrorNotice error={combinations.error} retry={() => void combinations.refetch()} />
        ) : (
          <CatalogBrowser
            server={{
              request: catalogRequest,
              total: combinations.data?.total ?? 0,
              pending: combinations.isFetching,
              onChange: setCatalogRequest,
            }}
            items={(combinations.data?.items ?? []).map((choice) => ({
              ...choice,
              label: choice.combination.release,
            }))}
            label={t('gameAdmin.combinations')}
            filters={[
              {
                id: 'runtime',
                label: t('gameAdmin.runtime'),
                value: (choice) => choice.combination.profile,
                options: [...(combinations.data?.runtimes ?? [])]
                  .sort()
                  .map((value) => ({ value, label: value })),
              },
              {
                id: 'releaseType',
                label: t('catalog.releaseType'),
                value: (choice) => choice.combination.releaseType ?? 'unknown',
                options: ['release', 'snapshot', 'old_beta', 'old_alpha', 'unknown'].map(
                  (value) => ({ value, label: t(`catalog.type.${value}`) }),
                ),
              },
              {
                id: 'availability',
                label: t('gameAdmin.availability'),
                value: (choice) => String(choice.enabled),
                options: [
                  { value: 'enabled', label: t('web.enabled') },
                  { value: 'disabled', label: t('web.disabled') },
                ],
              },
            ]}
          >
            {(visible) => (
              <table>
                <thead>
                  <tr>
                    <th>{t('gameAdmin.version')}</th>
                    <th>{t('catalog.releaseDate')}</th>
                    <th>{t('gameAdmin.runtime')}</th>
                    <th>{t('gameAdmin.java')}</th>
                    <th>{t('gameAdmin.protocol')}</th>
                    <th>{t('gameAdmin.installationSupport')}</th>
                    <th>{t('gameAdmin.availability')}</th>
                    <th>{t('web.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((choice) => (
                    <tr key={choice.id}>
                      <td>{choice.combination.release}</td>
                      <td>
                        {choice.releaseTime ? (
                          <Time value={choice.releaseTime} />
                        ) : (
                          t('web.unknown')
                        )}
                      </td>
                      <td>{choice.combination.profile}</td>
                      <td>{choice.combination.javaMajor}</td>
                      <td>{choice.combination.protocolId ?? t('web.unknown')}</td>
                      <td>
                        {t(
                          choice.capabilities?.installation
                            ? 'gameAdmin.declaredSupported'
                            : 'web.unavailable',
                        )}
                      </td>
                      <td>{t(choice.enabled ? 'web.enabled' : 'web.disabled')}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setSelected(choice.id)}
                        >
                          {t('web.details')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CatalogBrowser>
        )}
        {combinations.data?.metadataStatus && (
          <div>
            {!combinations.data.metadataStatus.lastSuccessAt ? (
              <Notice>{t('catalog.metadataMissing')}</Notice>
            ) : (
              <>
                {combinations.data.metadataStatus.stale && (
                  <Notice>{t('catalog.metadataStale')}</Notice>
                )}
                <p className="muted">
                  {t('catalog.metadataUpdated')}:{' '}
                  <Time value={combinations.data.metadataStatus.lastSuccessAt} />
                </p>
              </>
            )}
          </div>
        )}
      </Section>
      {selected &&
        (detail.isPending ? (
          <Loading />
        ) : detail.error ? (
          <ErrorNotice error={detail.error} retry={() => void detail.refetch()} />
        ) : detail.data ? (
          <CombinationDetail key={detail.data.id} choice={detail.data} refresh={refresh} />
        ) : null)}
      <SyncVanillaCatalog refresh={refresh} />
      <details>
        <summary>{t('gameAdmin.advancedRegistration')}</summary>
        <RegisterCombination refresh={refresh} />
      </details>
    </Page>
  );
}
function CombinationDetail({ choice, refresh }: { choice: Combination; refresh: () => void }) {
  const t = useT();
  return (
    <>
      <Section title={`${choice.combination.release} · ${choice.combination.profile}`}>
        <Details
          values={[
            [t('gameAdmin.choiceId'), choice.id],
            [t('gameAdmin.mapping'), choice.mappingId],
            [t('gameAdmin.family'), choice.combination.family],
            [t('gameAdmin.build'), choice.combination.buildId ?? '—'],
            [t('gameAdmin.loader'), choice.combination.loaderVersion ?? '—'],
          ]}
        />
        {choice.capabilities && (
          <Details
            values={[
              [
                t('gameAdmin.authority'),
                t(
                  choice.supportAuthority === 'integration'
                    ? 'gameAdmin.integrationAuthority'
                    : 'gameAdmin.evidence',
                ),
              ],
              ...(
                [
                  'installation',
                  'directConnection',
                  'gateway',
                  'readiness',
                  'playerIdle',
                  'sleepWake',
                  'playerManagement',
                ] as const
              ).map((capability): [string, string] => [
                t(`gameAdmin.capability.${capability}`),
                t(choice.capabilities?.[capability] ? 'gameUi.yes' : 'gameUi.no'),
              ]),
            ]}
          />
        )}
        <ActionForm
          onSubmit={async (data) => {
            await api(`/v1/owner/minecraft/compatibility/${choice.id}/availability`, {
              method: 'PUT',
              body: { enabled: data.get('enabled') === 'on' },
            });
            refresh();
          }}
        >
          <Check label={t('gameAdmin.offer')} name="enabled" defaultChecked={choice.enabled} />
        </ActionForm>
        <p className="muted">{t('gameAdmin.availabilityBoundary')}</p>
      </Section>
      <Section title={t('gameAdmin.evidence')}>
        {choice.evidence.length ? (
          choice.evidence.map((report) => (
            <details key={report.runId}>
              <summary>
                <Time value={report.recordedAt} /> · {t(`gameAdmin.${report.kind}`)}
              </summary>
              <Details
                values={[
                  [t('gameAdmin.run'), report.runId],
                  [
                    t('gameAdmin.client'),
                    report.client
                      ? `${report.client.implementation} ${report.client.version}`
                      : '—',
                  ],
                  [t('gameAdmin.server'), report.server?.uuid ?? '—'],
                  [t('gameAdmin.digest'), report.evidenceSha256],
                ]}
              />
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t('gameAdmin.check')}</th>
                      <th>{t('gameAdmin.result')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((check) => (
                      <tr key={check}>
                        <td>{t(`gameAdmin.check.${check}`)}</td>
                        <td>
                          {t(
                            report.checks[check] === true
                              ? 'gameAdmin.passed'
                              : report.checks[check] === false
                                ? 'gameAdmin.failed'
                                : 'web.unknown',
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          ))
        ) : (
          <Empty text={t('gameAdmin.noEvidence')} />
        )}
        <ActionForm
          onSubmit={async (data) => {
            const file = data.get('evidence');
            if (!(file instanceof File) || file.size < 1 || file.size > 4 * 1024 * 1024)
              throw new ApiError('validation_failed', 'gameAdmin.evidenceInvalid');
            let raw: unknown;
            try {
              raw = JSON.parse(await file.text());
            } catch {
              throw new ApiError('validation_failed', 'gameAdmin.evidenceInvalid');
            }
            const envelope = z
              .object({
                report: z.record(z.string(), z.unknown()),
                signature: z.string().regex(/^[a-f0-9]{64}$/),
              })
              .strict()
              .safeParse(raw);
            if (!envelope.success)
              throw new ApiError('validation_failed', 'gameAdmin.evidenceInvalid');
            await api(`/v1/owner/minecraft/compatibility/${choice.id}/evidence`, {
              body: envelope.data,
            });
            refresh();
          }}
          submitLabel={t('gameAdmin.importEvidence')}
        >
          <Input
            label={t('gameAdmin.signedReport')}
            name="evidence"
            type="file"
            accept=".json"
            required
          />
          <p className="muted">{t('gameAdmin.signatureBoundary')}</p>
        </ActionForm>
      </Section>
    </>
  );
}
function SyncVanillaCatalog({ refresh }: { refresh: () => void }) {
  const t = useT();
  const format = useFormat();
  const mappings = useQuery({
    queryKey: ['runtime-mappings'],
    queryFn: ({ signal }) => api<Mapping[]>('/v1/owner/runtime-mappings', { signal }),
  });
  const eligible =
    mappings.data?.filter((m) => m.game_id === 'minecraft-java' && m.runtime_id === 'vanilla') ??
    [];
  const [mappingId, setMappingId] = useState('');
  const [all, setAll] = useState(false);
  const [enableSupported, setEnableSupported] = useState(false);
  const [batch, setBatch] = useState<CatalogBatch>();
  const [measurement, setMeasurement] = useState<CatalogMeasurement>();
  const [busy, setBusy] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const selected = mappingId || (eligible.length === 1 ? eligible[0]?.id : '');
  async function sync() {
    if (!selected || controller.current) return;
    const active = new AbortController();
    controller.current = active;
    setBusy(true);
    setCancelled(false);
    setFailure(undefined);
    setMeasurement(undefined);
    if (batch?.nextCursor === null) setBatch(undefined);
    try {
      await syncCatalogPages({
        previous: batch,
        signal: active.signal,
        request: (cursor, signal) =>
          api<CatalogBatch>('/v1/owner/minecraft/catalog/sync', {
            signal,
            body: { mappingId: selected, all, enableSupported, cursor, limit: 20 },
          }),
        progress: (result, measured) => {
          setBatch(result);
          setMeasurement(measured);
        },
      });
    } catch (error) {
      if (mounted.current) {
        if (!active.signal.aborted) setFailure(error);
        else setCancelled(true);
      }
    } finally {
      controller.current = null;
      if (mounted.current) {
        setBusy(false);
        refresh();
      }
    }
  }
  return (
    <Section title={t('gameAdmin.syncCatalog')}>
      <Notice>{t('gameAdmin.syncHelp')}</Notice>
      {mappings.isPending ? (
        <Loading />
      ) : mappings.error ? (
        <ErrorNotice error={mappings.error} />
      ) : !eligible.length ? (
        <Empty text={t('gameAdmin.noMapping')} />
      ) : (
        <div className="stack">
          <Select
            label={t('gameAdmin.mapping')}
            value={selected}
            disabled={busy}
            onChange={(event) => {
              setMappingId(event.target.value);
              setBatch(undefined);
              setCancelled(false);
              setFailure(undefined);
            }}
          >
            <option value="">{t('gameAdmin.mapping')}</option>
            {eligible.map((mapping) => (
              <option key={mapping.id} value={mapping.id}>
                {mapping.runtime_id} · {mapping.id}
              </option>
            ))}
          </Select>
          <Check
            label={t('gameAdmin.includeHistorical')}
            checked={all}
            disabled={busy}
            onChange={(event) => {
              setAll(event.target.checked);
              setBatch(undefined);
              setCancelled(false);
              setFailure(undefined);
            }}
          />
          <Check
            label={t('gameAdmin.enableSupportedBatch')}
            checked={enableSupported}
            disabled={busy}
            onChange={(event) => {
              setEnableSupported(event.target.checked);
              setBatch(undefined);
              setCancelled(false);
              setFailure(undefined);
            }}
          />
          {failure !== undefined && <ErrorNotice error={failure} />}
          {cancelled && <Notice>{t('gameAdmin.syncCancelled')}</Notice>}
          <button type="button" disabled={busy || !selected} onClick={() => void sync()}>
            {t(
              busy
                ? 'web.loading'
                : batch?.nextCursor || cancelled || failure !== undefined
                  ? 'gameAdmin.syncResume'
                  : 'gameAdmin.syncCatalog',
            )}
          </button>
          {busy && (
            <button type="button" className="secondary" onClick={() => controller.current?.abort()}>
              {t('web.cancel')}
            </button>
          )}
          {(busy || batch) && (
            <div className="stack">
              <ScanProgress
                label={t('gameAdmin.scanProgress')}
                completed={batch ? (batch.nextCursor ?? batch.total) : undefined}
                total={batch?.total}
                status={
                  batch
                    ? t(
                        busy
                          ? 'gameAdmin.syncProgress'
                          : batch.nextCursor === null
                            ? 'gameAdmin.syncComplete'
                            : 'gameAdmin.syncPartial',
                        { count: batch.nextCursor ?? batch.total, total: batch.total },
                      )
                    : t('gameAdmin.scanPreparing')
                }
                estimate={
                  busy
                    ? measurement?.remainingSeconds != null
                      ? t('gameAdmin.scanEstimate', {
                          minutes: format.number(
                            Math.max(1, Math.ceil(measurement.remainingSeconds / 60)),
                            0,
                          ),
                        })
                      : t('gameAdmin.scanEstimating')
                    : undefined
                }
                logLabel={t('gameAdmin.scanLog')}
              >
                {batch && (
                  <ul>
                    {batch.items.map((item) => (
                      <li key={item.version}>
                        {item.version}:{' '}
                        {t(
                          item.status === 'registered' ? 'gameAdmin.registered' : 'web.unavailable',
                        )}
                        {item.reason && <> — {t(`gameAdmin.catalogReason.${item.reason}`)}</>}
                      </li>
                    ))}
                  </ul>
                )}
              </ScanProgress>
              {batch && <p>{t('gameAdmin.syncEvidence')}</p>}
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
function RegisterCombination({ refresh }: { refresh: () => void }) {
  const t = useT();
  const mappings = useQuery({
    queryKey: ['runtime-mappings'],
    queryFn: ({ signal }) => api<Mapping[]>('/v1/owner/runtime-mappings', { signal }),
  });
  const [mappingId, setMappingId] = useState('');
  const eligible = mappings.data?.filter((m) => m.game_id === 'minecraft-java') ?? [],
    mapping = eligible.find((m) => m.id === mappingId);
  const eggs = useQuery({
    queryKey: ['runtime-eggs', mapping?.nest_id],
    enabled: Boolean(mapping),
    queryFn: ({ signal }) => api<Egg[]>(`/v1/owner/nests/${mapping?.nest_id}/eggs`, { signal }),
  });
  const egg = eggs.data?.find((egg) => egg.id === mapping?.egg_id),
    variables = egg?.relationships?.variables?.data.map((v) => v.attributes.env_variable) ?? [];
  const profile = mapping?.runtime_id;
  async function register(data: FormData) {
    if (!mapping || !egg || !variables.length)
      throw new ApiError('integration_unavailable', 'gameAdmin.eggUnavailable');
    const release = text(data, 'release'),
      bindings = Object.fromEntries(
        semantics.flatMap((semantic) => {
          const value = text(data, `binding-${semantic}`);
          return value ? [[semantic, value]] : [];
        }),
      );
    const optional = (name: string) => text(data, name) || undefined;
    await api('/v1/owner/minecraft/compatibility', {
      body: {
        mappingId,
        runtime: {
          release,
          profile,
          ...(data.has('buildId') ? { buildId: Number(data.get('buildId')) } : {}),
          ...(optional('loaderVersion') ? { loaderVersion: optional('loaderVersion') } : {}),
          ...(optional('installerVersion')
            ? { installerVersion: optional('installerVersion') }
            : {}),
        },
        binding: {
          profile,
          release,
          ...(mapping.image_mode === 'integration'
            ? {}
            : {
                image: mapping.docker_image,
                imageJavaMajor: Number(data.get('imageJavaMajor')),
              }),
          declaredEggVariables: variables,
          bindings,
          fixedVariables: {},
          installationKind: text(data, 'installationKind'),
          artifactPaths: {
            ...(optional('serverPath') ? { server: optional('serverPath') } : {}),
            ...(optional('installerPath') ? { installer: optional('installerPath') } : {}),
          },
          supportedProperties: text(data, 'supportedProperties')
            .split(/\r?\n/)
            .map((v) => v.trim())
            .filter(Boolean),
        },
      },
    });
    refresh();
  }
  return (
    <Section title={t('gameAdmin.register')}>
      {mappings.isPending ? (
        <Loading />
      ) : mappings.error ? (
        <ErrorNotice error={mappings.error} />
      ) : eligible.length === 0 ? (
        <Empty text={t('gameAdmin.noMapping')} />
      ) : (
        <>
          <Select
            label={t('gameAdmin.mapping')}
            value={mappingId}
            onChange={(event) => setMappingId(event.target.value)}
          >
            <option value="">{t('gameUi.select')}</option>
            {eligible.map((mapping) => (
              <option key={mapping.id} value={mapping.id}>
                {mapping.runtime_id} · {mapping.docker_image} · {mapping.id.slice(0, 8)}
              </option>
            ))}
          </Select>
          {mapping &&
            (eggs.isPending ? (
              <Loading />
            ) : eggs.error ? (
              <ErrorNotice error={eggs.error} />
            ) : !egg ? (
              <Notice>{t('gameAdmin.eggUnavailable')}</Notice>
            ) : (
              <ActionForm key={mappingId} onSubmit={register} submitLabel={t('gameAdmin.register')}>
                <Details
                  values={[
                    [t('gameAdmin.runtime'), mapping.runtime_id],
                    [t('gameAdmin.image'), mapping.docker_image],
                    [t('gameAdmin.egg'), egg.name],
                  ]}
                />
                <Input label={t('gameAdmin.version')} name="release" maxLength={96} required />
                {(profile === 'paper' || profile === 'folia') && (
                  <Input
                    label={t('gameAdmin.build')}
                    name="buildId"
                    type="number"
                    min={1}
                    step={1}
                    required
                  />
                )}
                {(profile === 'fabric' || profile === 'forge') && (
                  <Input
                    label={t('gameAdmin.loader')}
                    name="loaderVersion"
                    maxLength={96}
                    required
                  />
                )}
                {profile === 'fabric' && (
                  <Input
                    label={t('gameAdmin.installerVersion')}
                    name="installerVersion"
                    maxLength={96}
                    required
                  />
                )}
                {mapping?.image_mode === 'integration' ? (
                  <Notice>{t('infra.imageManaged')}</Notice>
                ) : (
                  <Input
                    label={t('gameAdmin.java')}
                    name="imageJavaMajor"
                    type="number"
                    min={8}
                    max={100}
                    step={1}
                    required
                  />
                )}
                <Select
                  label={t('gameAdmin.installationKind')}
                  name="installationKind"
                  defaultValue={
                    profile === 'fabric'
                      ? 'fabric-installer'
                      : profile === 'forge'
                        ? 'forge-installer'
                        : 'server-jar'
                  }
                >
                  <option value="server-jar">{t('gameAdmin.serverJar')}</option>
                  <option value="fabric-installer">Fabric</option>
                  <option value="forge-installer">Forge</option>
                </Select>
                <Input
                  label={t('gameAdmin.serverPath')}
                  name="serverPath"
                  maxLength={500}
                  required={profile === 'vanilla' || profile === 'paper' || profile === 'folia'}
                />
                <Input label={t('gameAdmin.installerPath')} name="installerPath" maxLength={500} />
                <details>
                  <summary>{t('gameAdmin.variableBindings')}</summary>
                  <div className="stack">
                    {semantics.map((semantic) => (
                      <Select
                        key={semantic}
                        label={t(`gameAdmin.binding.${semantic}`)}
                        name={`binding-${semantic}`}
                        required={semantic === 'release'}
                      >
                        <option value="">{t('gameAdmin.notBound')}</option>
                        {variables.map((variable) => (
                          <option key={variable} value={variable}>
                            {variable}
                          </option>
                        ))}
                      </Select>
                    ))}
                  </div>
                </details>
                <Textarea
                  label={t('gameAdmin.propertyDeclaration')}
                  name="supportedProperties"
                  maxLength={100000}
                />
                <Notice>{t('gameAdmin.registrationBoundary')}</Notice>
              </ActionForm>
            ))}
        </>
      )}
    </Section>
  );
}
