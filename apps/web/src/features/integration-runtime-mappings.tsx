import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Database } from '../../../../packages/database/src/index.js';
import type { GameManifest } from '../../../../packages/game-sdk/src/index.js';
import type { Egg, Nest, Node } from '../../../../packages/pterodactyl-adapter/src/types.js';
import { ApiError, api, queryClient } from '../api/client.js';
import type { Json } from '../api/contracts.js';
import { useT } from '../app/i18n.js';
import {
  ActionForm,
  Check,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  number,
  Section,
  Select,
  Textarea,
  text,
} from '../components/ui.js';
import { TableRegion } from './servers.js';

type Row<T> = Json<{ [K in keyof T]: T[K] extends { __select__: infer S } ? S : T[K] }>;
type Mapping = Row<Database['runtime_egg_mappings']> & { inUse: boolean };
type ManagedNode = Row<Database['managed_nodes']>;
type Inventory = { nodes: Node[]; nests: Nest[] };
const path = (value: string) => `/v1/owner/${value}`;
function QueryContent<T>({
  query,
  children,
}: {
  query: UseQueryResult<T>;
  children: (value: T) => ReactNode;
}) {
  if (query.isPending) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} retry={() => void query.refetch()} />;
  if (query.data === undefined) return <Empty />;
  return children(query.data);
}
function MappingForm({
  initial,
  gameId,
  runtimeId: selectedRuntimeId,
  manifest,
  onSaved,
}: {
  initial: Mapping | null;
  gameId: string;
  runtimeId: string;
  manifest: GameManifest;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [nestId, setNestId] = useState(String(initial?.nest_id ?? '')),
    [eggId, setEggId] = useState(String(initial?.egg_id ?? '')),
    [runtimeId, setRuntimeId] = useState(initial?.runtime_id ?? selectedRuntimeId),
    [imageModeOverride, setImageModeOverride] = useState<'static' | 'integration' | undefined>(
      initial?.image_mode ?? (initial ? 'static' : undefined),
    );
  const [variables, setVariables] = useState(
    Object.entries(initial?.environment ?? {}).map(([name, value]) => ({
      key: crypto.randomUUID(),
      name,
      value,
    })),
  );
  const modules = useQuery({
    queryKey: ['owner-game-modules'],
    queryFn: () => api<Array<{ id: string; manifest: GameManifest }>>('/v1/owner/game-modules'),
  });
  const nodes = useQuery({
    queryKey: ['owner-nodes'],
    queryFn: () => api<ManagedNode[]>(path('nodes')),
  });
  const inventory = useQuery({
    queryKey: ['owner-provider'],
    queryFn: () => api<Inventory>(path('infrastructure')),
  });
  const eggs = useQuery({
    queryKey: ['owner-eggs', nestId],
    queryFn: () => api<Egg[]>(path(`nests/${encodeURIComponent(nestId)}/eggs`)),
    enabled: Boolean(nestId),
  });
  const policy = modules.data
    ?.find((module) => module.id === gameId)
    ?.manifest.runtimes.find((runtime) => runtime.id === runtimeId)?.imagePolicy;
  const imageMode = imageModeOverride ?? (policy ? 'integration' : 'static');
  const egg = eggs.data?.find((item) => String(item.id) === eggId);
  const images = egg
    ? [...new Set([egg.docker_image, ...Object.values(egg.docker_images ?? {})])]
    : [];
  const roles = [
    ...(manifest?.ports ?? []),
    ...(initial?.port_roles ?? [])
      .filter((role) => !manifest?.ports.some((port) => port.role === role.role))
      .map((role) => ({
        role: role.role,
        required: true,
        transport:
          role.protocols.length === 2 ? ('both' as const) : (role.protocols[0] ?? ('tcp' as const)),
      })),
  ];
  return (
    <ActionForm
      onSubmit={async (data) => {
        if (new Set(variables.map((variable) => variable.name)).size !== variables.length)
          throw new ApiError('validation_failed', 'errors.validation_failed');
        await api(path('runtime-mappings'), {
          method: 'PUT',
          body: initial?.inUse
            ? {
                id: initial.id,
                gameId: initial.game_id,
                runtimeId: initial.runtime_id,
                nodeId: initial.node_id,
                nestId: initial.nest_id,
                eggId: initial.egg_id,
                imageMode: initial.image_mode,
                ...(initial.image_mode === 'static' ? { dockerImage: initial.docker_image } : {}),
                startup: initial.startup,
                environment: initial.environment,
                portRoles: initial.port_roles,
                featureLimits: initial.feature_limits,
                enabled: data.has('enabled'),
              }
            : {
                ...(initial ? { id: initial.id } : {}),
                gameId,
                runtimeId,
                nodeId: text(data, 'node'),
                nestId: Number(nestId),
                eggId: Number(eggId),
                imageMode,
                ...(imageMode === 'static' ? { dockerImage: text(data, 'image') } : {}),
                startup: text(data, 'startup'),
                environment: Object.fromEntries(
                  variables.map((variable) => [variable.name, variable.value]),
                ),
                portRoles: roles
                  .filter((role) => role.required || data.has(`include-${role.role}`))
                  .map((role) => ({
                    role: role.role,
                    protocols: role.transport === 'both' ? ['tcp', 'udp'] : [role.transport],
                    primary: text(data, 'primary') === role.role,
                    ...(text(data, `variable-${role.role}`)
                      ? { environmentVariable: text(data, `variable-${role.role}`) }
                      : {}),
                  })),
                featureLimits: {
                  databases: 0,
                  allocations: number(data, 'allocations'),
                  backups: number(data, 'backups'),
                },
                enabled: data.has('enabled'),
              },
        });
        await onSaved();
      }}
    >
      {initial?.inUse && <Notice>{t('ownerIntegration.mappingInUse')}</Notice>}
      <fieldset disabled={initial?.inUse} className="mapping-fields">
        <Select
          key={`${gameId}-${manifest?.version ?? 'pending'}`}
          label={t('infra.runtime')}
          name="runtime"
          value={runtimeId}
          onChange={(event) => {
            setRuntimeId(event.target.value);
            setImageModeOverride(undefined);
          }}
          required
        >
          <option value="">{t('infra.select')}</option>
          {manifest?.runtimes.map((runtime) => (
            <option key={runtime.id} value={runtime.id}>
              {t(runtime.nameKey)}
            </option>
          ))}
        </Select>
        <QueryContent query={nodes}>
          {(rows) => (
            <Select
              label={t('infra.providerNode')}
              name="node"
              defaultValue={initial?.node_id ?? ''}
              required
            >
              <option value="">{t('infra.select')}</option>
              {rows.map((node) => (
                <option key={node.id} value={node.id}>
                  {inventory.data?.nodes.find((item) => item.id === node.pterodactyl_node_id)
                    ?.name ?? `${t('infra.providerNode')} ${node.pterodactyl_node_id}`}
                </option>
              ))}
            </Select>
          )}
        </QueryContent>
        <QueryContent query={inventory}>
          {(value) => (
            <Select
              label={t('infra.nest')}
              value={nestId}
              onChange={(event) => {
                setNestId(event.target.value);
                setEggId('');
              }}
              required
            >
              <option value="">{t('infra.select')}</option>
              {value.nests.map((nest) => (
                <option key={nest.id} value={nest.id}>
                  {nest.name}
                </option>
              ))}
            </Select>
          )}
        </QueryContent>
        {nestId && (
          <QueryContent query={eggs}>
            {(rows) => (
              <Select
                label={t('infra.egg')}
                value={eggId}
                onChange={(event) => {
                  setEggId(event.target.value);
                  const next = rows.find((item) => String(item.id) === event.target.value);
                  setVariables(
                    (next?.relationships?.variables?.data ?? []).map(({ attributes }) => ({
                      key: crypto.randomUUID(),
                      name: attributes.env_variable,
                      value: attributes.default_value ?? '',
                    })),
                  );
                }}
                required
              >
                <option value="">{t('infra.select')}</option>
                {rows.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            )}
          </QueryContent>
        )}
        <QueryContent query={modules}>
          {() => (
            <>
              <Select
                label={t('infra.imageMode')}
                value={imageMode}
                onChange={(event) =>
                  setImageModeOverride(event.target.value as 'static' | 'integration')
                }
              >
                {(policy || imageMode === 'integration') && (
                  <option value="integration">{t('infra.imageIntegration')}</option>
                )}
                <option value="static">{t('infra.imageStatic')}</option>
              </Select>
              {imageMode === 'integration' ? (
                <Notice>{t('infra.imageManaged')}</Notice>
              ) : (
                <Select
                  key={`image-${egg?.id ?? 'pending'}`}
                  label={t('infra.image')}
                  name="image"
                  defaultValue={
                    eggId === String(initial?.egg_id) ? initial?.docker_image : (images[0] ?? '')
                  }
                  required
                >
                  <option value="">{t('infra.select')}</option>
                  {images.map((image) => (
                    <option key={image} value={image}>
                      {image}
                    </option>
                  ))}
                </Select>
              )}
            </>
          )}
        </QueryContent>
        <Textarea
          key={`startup-${eggId}`}
          label={t('infra.startup')}
          name="startup"
          defaultValue={eggId === String(initial?.egg_id) ? initial?.startup : egg?.startup}
          required
        />
        <details open>
          <summary>{t('infra.variables')}</summary>
          {variables.map((variable, index) => (
            <div className="form-grid" key={variable.key}>
              <Input
                label={t('infra.variableName')}
                value={variable.name}
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                required
                onChange={(event) =>
                  setVariables((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  )
                }
              />
              <Input
                label={t('infra.variableValue')}
                value={variable.value}
                onChange={(event) =>
                  setVariables((current) =>
                    current.map((entry, at) =>
                      at === index ? { ...entry, value: event.target.value } : entry,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="secondary"
                onClick={() => setVariables((current) => current.filter((_, at) => at !== index))}
              >
                {t('web.remove')}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() =>
              setVariables((current) => [
                ...current,
                { key: crypto.randomUUID(), name: '', value: '' },
              ])
            }
          >
            {t('infra.addVariable')}
          </button>
        </details>
        <fieldset>
          <legend>{t('infra.portRoles')}</legend>
          <Select
            key={`${gameId}-${manifest?.version ?? 'pending'}`}
            name="primary"
            label={t('infra.primary')}
            defaultValue={initial?.port_roles.find((role) => role.primary)?.role ?? ''}
            required
          >
            <option value="">{t('infra.select')}</option>
            {roles.map((role) => (
              <option key={role.role} value={role.role}>
                {role.role} · {role.transport.toUpperCase()}
              </option>
            ))}
          </Select>
          {roles.map((role) => (
            <div key={role.role}>
              <p>
                {role.role} · {role.transport.toUpperCase()}
              </p>
              {!role.required && (
                <Check
                  label={t('infra.enabled')}
                  name={`include-${role.role}`}
                  defaultChecked={
                    initial?.port_roles.some((old) => old.role === role.role) ?? false
                  }
                />
              )}
              <Input
                label={t('infra.portVariable')}
                name={`variable-${role.role}`}
                defaultValue={
                  initial?.port_roles.find((old) => old.role === role.role)?.environmentVariable ??
                  ''
                }
                pattern="[A-Za-z_][A-Za-z0-9_]*"
              />
            </div>
          ))}
        </fieldset>
        <Input
          label={t('infra.allocationLimit')}
          name="allocations"
          type="number"
          min={1}
          max={32}
          defaultValue={initial?.feature_limits.allocations ?? Math.max(1, roles.length)}
          required
        />
        <Input
          label={t('infra.backupLimit')}
          name="backups"
          type="number"
          min={0}
          max={10}
          defaultValue={initial?.feature_limits.backups ?? 1}
          required
        />
      </fieldset>
      <Check label={t('infra.enabled')} name="enabled" defaultChecked={initial?.enabled ?? true} />
    </ActionForm>
  );
}

export function IntegrationRuntimeMappings({
  gameId,
  manifest,
}: {
  gameId: string;
  manifest: GameManifest;
}) {
  const t = useT();
  const [params, setParams] = useSearchParams();
  const selected =
    manifest.runtimes.find((runtime) => runtime.id === params.get('runtime')) ??
    manifest.runtimes[0];
  const [editing, setEditing] = useState<Mapping | null | undefined>();
  const mappings = useQuery({
    queryKey: ['runtime-mappings'],
    queryFn: ({ signal }) => api<Mapping[]>(path('runtime-mappings'), { signal }),
    staleTime: 30_000,
  });
  const nodes = useQuery({
    queryKey: ['owner-nodes'],
    queryFn: () => api<ManagedNode[]>(path('nodes')),
    staleTime: 30_000,
  });
  const inventory = useQuery({
    queryKey: ['owner-provider'],
    queryFn: () => api<Inventory>(path('infrastructure')),
    staleTime: 30_000,
  });
  const nodeName = (nodeId: string) => {
    const id = nodes.data?.find((node) => node.id === nodeId)?.pterodactyl_node_id;
    return (
      inventory.data?.nodes.find((node) => node.id === id)?.name ??
      (id ? `${t('infra.providerNode')} ${id}` : t('web.unavailable'))
    );
  };
  return (
    <div className="stack">
      <fieldset className="integration-runtime-selector" aria-label={t('ownerIntegration.runtime')}>
        {manifest.runtimes.map((runtime) => (
          <button
            type="button"
            className="secondary"
            key={runtime.id}
            aria-pressed={selected?.id === runtime.id}
            onClick={() =>
              setParams(
                (current) => {
                  current.set('runtime', runtime.id);
                  return current;
                },
                { replace: true },
              )
            }
          >
            {t(runtime.nameKey)}
          </button>
        ))}
      </fieldset>
      {nodes.error && <ErrorNotice error={nodes.error} retry={() => void nodes.refetch()} />}
      {inventory.error && (
        <ErrorNotice error={inventory.error} retry={() => void inventory.refetch()} />
      )}
      <Section
        title={selected ? t(selected.nameKey) : t('infra.mappings')}
        actions={
          <button type="button" disabled={!selected} onClick={() => setEditing(null)}>
            {t('infra.addMapping')}
          </button>
        }
      >
        <QueryContent query={mappings}>
          {(all) => {
            const rows = all.filter(
              (row) => row.game_id === gameId && row.runtime_id === selected?.id,
            );
            return rows.length ? (
              <TableRegion label={t('infra.mappings')}>
                <table>
                  <thead>
                    <tr>
                      <th>{t('infra.providerNode')}</th>
                      <th>{t('infra.egg')}</th>
                      <th>{t('infra.image')}</th>
                      <th>{t('web.status')}</th>
                      <th>{t('web.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.id}>
                        <th scope="row">{nodeName(row.node_id)}</th>
                        <td>
                          {row.nest_id} / {row.egg_id}
                        </td>
                        <td>
                          {row.image_mode === 'integration'
                            ? t('infra.imageIntegration')
                            : row.docker_image}
                        </td>
                        <td>{t(row.enabled ? 'web.enabled' : 'web.disabled')}</td>
                        <td>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => setEditing(row)}
                          >
                            {t('web.edit')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableRegion>
            ) : (
              <Empty text={t('ownerIntegration.noMappings')} />
            );
          }}
        </QueryContent>
        <Link
          to={`/owner/integrations/${encodeURIComponent(gameId)}/sleep?runtime=${encodeURIComponent(selected?.id ?? '')}`}
        >
          {t('sleepTiming.title')}
        </Link>
      </Section>
      <Dialog
        open={editing !== undefined}
        title={t('infra.mappings')}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && selected && (
          <MappingForm
            initial={editing}
            gameId={gameId}
            runtimeId={selected.id}
            manifest={manifest}
            onSaved={async () => {
              await Promise.all([
                queryClient.invalidateQueries({ queryKey: ['runtime-mappings'] }),
                queryClient.invalidateQueries({ queryKey: ['owner-minecraft-compatibility'] }),
              ]);
              setEditing(undefined);
            }}
          />
        )}
      </Dialog>
    </div>
  );
}
