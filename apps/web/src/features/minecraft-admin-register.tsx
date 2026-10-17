import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiError, api } from '../api/client.js';
import { useT } from '../app/i18n.js';
import {
  ActionForm,
  Details,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  Section,
  Select,
  Textarea,
  text,
} from '../components/ui.js';
import { type Egg, type Mapping, useMappingLabel } from './minecraft-admin-model.js';

const semantics = [
  'release',
  'buildId',
  'loaderVersion',
  'loaderCoordinate',
  'installerVersion',
  'serverArtifactUrl',
  'installerArtifactUrl',
] as const;
export function RegisterCombination({ refresh }: { refresh: () => void }) {
  const t = useT();
  const mappingLabel = useMappingLabel();
  const mappings = useQuery({
    queryKey: ['runtime-mappings'],
    queryFn: ({ signal }) => api<Mapping[]>('/v1/owner/runtime-mappings', { signal }),
  });
  const [mappingId, setMappingId] = useState('');
  const eligible = mappings.data?.filter((m) => m.game_id === 'minecraft') ?? [],
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
                {mappingLabel(mapping)}
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
