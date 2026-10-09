import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { ApiError, api } from '../api/client.js';
import { useT } from '../app/i18n.js';
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
  combination: {
    release: string;
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
  const combinations = useQuery({
    queryKey: ['owner-minecraft-compatibility'],
    queryFn: ({ signal }) => api<Combination[]>('/v1/owner/minecraft/compatibility', { signal }),
  });
  const [selected, setSelected] = useState<string>('');
  return (
    <Page title={t('gameAdmin.minecraft')}>
      <Notice>{t('gameAdmin.evidenceBoundary')}</Notice>
      <Section title={t('gameAdmin.combinations')}>
        {combinations.isPending ? (
          <Loading />
        ) : combinations.error ? (
          <ErrorNotice error={combinations.error} retry={() => void combinations.refetch()} />
        ) : !combinations.data?.length ? (
          <Empty />
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t('gameAdmin.version')}</th>
                  <th>{t('gameAdmin.runtime')}</th>
                  <th>{t('gameAdmin.java')}</th>
                  <th>{t('gameAdmin.protocol')}</th>
                  <th>{t('gameAdmin.support')}</th>
                  <th>{t('gameAdmin.availability')}</th>
                  <th>{t('web.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {combinations.data.map((choice) => (
                  <tr key={choice.id}>
                    <td>{choice.combination.release}</td>
                    <td>{choice.combination.profile}</td>
                    <td>{choice.combination.javaMajor}</td>
                    <td>{choice.combination.protocolId ?? t('web.unknown')}</td>
                    <td>{t(`gameAdmin.${choice.support}`)}</td>
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
          </div>
        )}
      </Section>
      {combinations.data
        ?.filter((c) => c.id === selected)
        .map((choice) => (
          <CombinationDetail
            key={choice.id}
            choice={choice}
            refresh={() => void combinations.refetch()}
          />
        ))}
      <RegisterCombination refresh={() => void combinations.refetch()} />
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
          image: mapping.docker_image,
          imageJavaMajor: Number(data.get('imageJavaMajor')),
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
                <Input
                  label={t('gameAdmin.java')}
                  name="imageJavaMajor"
                  type="number"
                  min={8}
                  max={100}
                  step={1}
                  required
                />
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
