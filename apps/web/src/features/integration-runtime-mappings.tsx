import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { Database } from '../../../../packages/database/src/index.js';
import type { GameManifest } from '../../../../packages/game-sdk/src/index.js';
import type { Egg, Nest, Node } from '../../../../packages/pterodactyl-adapter/src/types.js';
import { ApiError, api, queryClient } from '../api/client.js';
import type { Json } from '../api/contracts.js';
import { useT } from '../app/i18n.js';
import { Tooltip } from '../components/tooltip.js';
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
function MappingIcon({ kind }: { kind: 'integration' | 'static' | 'plus' | 'remove' }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === 'integration' ? (
        <>
          <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
          <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
        </>
      ) : kind === 'static' ? (
        <>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8 9h8M8 15h8M10 7v4M14 13v4" />
        </>
      ) : kind === 'plus' ? (
        <path d="M12 5v14M5 12h14" />
      ) : (
        <path d="m6 6 12 12M6 18 18 6" />
      )}
    </svg>
  );
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
  const runtimeId = initial?.runtime_id ?? selectedRuntimeId;
  const runtime = manifest.runtimes.find((entry) => entry.id === runtimeId);
  const [nestOverride, setNestId] = useState<string | undefined>(
    initial ? String(initial.nest_id) : undefined,
  );
  const [nodeOverride, setNodeId] = useState<string | undefined>(initial?.node_id);
  const [eggId, setEggId] = useState(String(initial?.egg_id ?? ''));
  const [startup, setStartup] = useState(initial?.startup ?? '');
  const [image, setImage] = useState(initial?.docker_image ?? '');
  const [imageMode, setImageMode] = useState<'static' | 'integration'>(
    initial?.image_mode ?? (runtime?.imagePolicy ? 'integration' : 'static'),
  );
  const [variables, setVariables] = useState(
    Object.entries(initial?.environment ?? {}).map(([name, value]) => ({
      key: crypto.randomUUID(),
      name,
      value,
    })),
  );
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
  const nestId =
    nestOverride ?? (inventory.data?.nests.length === 1 ? String(inventory.data.nests[0]?.id) : '');
  const nodeId = nodeOverride ?? (nodes.data?.length === 1 ? (nodes.data[0]?.id ?? '') : '');
  const eggs = useQuery({
    queryKey: ['owner-eggs', nestId],
    queryFn: () => api<Egg[]>(path(`nests/${encodeURIComponent(nestId)}/eggs`)),
    enabled: Boolean(nestId),
    staleTime: 30_000,
  });
  const egg = eggs.data?.find((entry) => String(entry.id) === eggId);
  const images = egg
    ? [...new Set([egg.docker_image, ...Object.values(egg.docker_images ?? {})])]
    : [];
  if (
    eggId === String(initial?.egg_id) &&
    initial?.docker_image &&
    !images.includes(initial.docker_image)
  )
    images.push(initial.docker_image);
  const roles = [
    ...manifest.ports,
    ...(initial?.port_roles ?? [])
      .filter((role) => !manifest.ports.some((port) => port.role === role.role))
      .map((role) => ({
        role: role.role,
        required: true,
        transport:
          role.protocols.length === 2 ? ('both' as const) : (role.protocols[0] ?? ('tcp' as const)),
      })),
  ];
  const [included, setIncluded] = useState(
    () =>
      new Set(
        roles
          .filter(
            (role) => role.required || initial?.port_roles.some((old) => old.role === role.role),
          )
          .map((role) => role.role),
      ),
  );
  const [primary, setPrimary] = useState(
    initial?.port_roles.find((role) => role.primary)?.role ??
      (roles.length === 1 && roles[0]?.required ? roles[0].role : ''),
  );
  const canSave =
    initial?.inUse ||
    Boolean(
      nodeId &&
        nestId &&
        egg &&
        nodes.data?.some((node) => node.id === nodeId) &&
        !nodes.error &&
        !inventory.error &&
        !eggs.error,
    );
  return (
    <ActionForm
      className="form runtime-mapping-form"
      submitLabel={t(initial ? 'web.save' : 'mapping.createAction')}
      submitDisabled={!canSave}
      footerStart={
        <div className="mapping-availability">
          <Check
            label={t('mapping.available')}
            name="enabled"
            defaultChecked={initial?.enabled ?? true}
          />
        </div>
      }
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
                nodeId,
                nestId: Number(nestId),
                eggId: Number(eggId),
                imageMode,
                ...(imageMode === 'static' ? { dockerImage: text(data, 'image') } : {}),
                startup,
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
      <div className="runtime-mapping-body">
        {initial?.inUse && <Notice>{t('ownerIntegration.mappingInUse')}</Notice>}
        <fieldset
          disabled={initial?.inUse}
          className="mapping-fields"
          onInvalidCapture={(event) => {
            // Native validation must reveal required fields inside collapsed advanced sections.
            const details =
              event.target instanceof HTMLElement ? event.target.closest('details') : null;
            if (details) details.open = true;
          }}
        >
          <div className="mapping-association">
            <div className="mapping-pair">
              <div className="mapping-runtime-context">
                <span>{t('infra.runtime')}</span>
                <strong>{runtime ? t(runtime.nameKey) : runtimeId}</strong>
              </div>
              <div>
                <Select
                  label={t('infra.providerNode')}
                  name="node"
                  value={nodeId}
                  onChange={(event) => setNodeId(event.target.value)}
                  required
                  disabled={nodes.isPending || Boolean(nodes.error)}
                >
                  <option value="">{t('infra.select')}</option>
                  {nodes.data?.map((node) => (
                    <option key={node.id} value={node.id}>
                      {inventory.data?.nodes.find((entry) => entry.id === node.pterodactyl_node_id)
                        ?.name ?? `${t('infra.providerNode')} ${node.pterodactyl_node_id}`}
                    </option>
                  ))}
                </Select>
                {nodes.isPending && <Loading />}
                {nodes.error && (
                  <ErrorNotice error={nodes.error} retry={() => void nodes.refetch()} />
                )}
                {nodes.data?.length === 0 && <p className="muted">{t('mapping.noNodes')}</p>}
              </div>
            </div>
            <div className="mapping-pair">
              <div>
                <Select
                  label={t('infra.nest')}
                  value={nestId}
                  onChange={(event) => {
                    setNestId(event.target.value);
                    setEggId('');
                    setStartup('');
                    setImage('');
                    setVariables([]);
                  }}
                  required
                  disabled={inventory.isPending || Boolean(inventory.error)}
                >
                  <option value="">{t('infra.select')}</option>
                  {inventory.data?.nests.map((nest) => (
                    <option key={nest.id} value={nest.id}>
                      {nest.name}
                    </option>
                  ))}
                </Select>
                {inventory.isPending && <Loading />}
                {inventory.error && (
                  <ErrorNotice error={inventory.error} retry={() => void inventory.refetch()} />
                )}
                {inventory.data?.nests.length === 0 && (
                  <p className="muted">{t('mapping.noNests')}</p>
                )}
              </div>
              <div>
                <Select
                  label={t('infra.egg')}
                  value={eggId}
                  onChange={(event) => {
                    const next = eggs.data?.find(
                      (entry) => String(entry.id) === event.target.value,
                    );
                    setEggId(event.target.value);
                    setStartup(next?.startup ?? '');
                    setImage(next?.docker_image ?? '');
                    setVariables(
                      (next?.relationships?.variables?.data ?? []).map(({ attributes }) => ({
                        key: crypto.randomUUID(),
                        name: attributes.env_variable,
                        value: attributes.default_value ?? '',
                      })),
                    );
                  }}
                  required
                  disabled={!nestId || eggs.isPending || Boolean(eggs.error)}
                >
                  <option value="">{t('infra.select')}</option>
                  {eggs.data?.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.name}
                    </option>
                  ))}
                </Select>
                {nestId && eggs.isPending && <Loading />}
                {nestId && eggs.error && (
                  <ErrorNotice error={eggs.error} retry={() => void eggs.refetch()} />
                )}
                {nestId && eggs.data?.length === 0 && (
                  <p className="muted">{t('mapping.noEggs')}</p>
                )}
              </div>
            </div>
          </div>
          <fieldset className="mapping-image-policy" aria-label={t('infra.image')}>
            <legend>{t('infra.image')}</legend>
            <div className="mapping-image-options">
              {(runtime?.imagePolicy || imageMode === 'integration') && (
                <button
                  type="button"
                  className="mapping-image-option"
                  aria-pressed={imageMode === 'integration'}
                  onClick={() => setImageMode('integration')}
                >
                  <MappingIcon kind="integration" />
                  {t('infra.imageIntegration')}
                </button>
              )}
              <button
                type="button"
                className="mapping-image-option"
                aria-pressed={imageMode === 'static'}
                onClick={() => setImageMode('static')}
              >
                <MappingIcon kind="static" />
                {t('infra.imageStatic')}
              </button>
            </div>
            {imageMode === 'static' && (
              <Select
                label={t('infra.image')}
                name="image"
                value={image}
                onChange={(event) => setImage(event.target.value)}
                required
                disabled={!egg}
              >
                <option value="">{t('infra.select')}</option>
                {images.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </Select>
            )}
          </fieldset>
          <div className="mapping-advanced">
            <details>
              <summary>
                <span>{t('mapping.startup')}</span>
                <code>{startup}</code>
              </summary>
              <div className="mapping-details-body">
                <Textarea
                  label={t('infra.startup')}
                  name="startup"
                  value={startup}
                  onChange={(event) => setStartup(event.target.value)}
                  required
                  spellCheck={false}
                />
              </div>
            </details>
            <details>
              <summary>
                <span>{t('mapping.variables')}</span>
                <span className="mapping-count">{variables.length}</span>
              </summary>
              <div className="mapping-details-body">
                {variables.length > 0 && (
                  <div className="mapping-variable-head" aria-hidden="true">
                    <span>{t('infra.variableName')}</span>
                    <span>{t('infra.variableValue')}</span>
                  </div>
                )}
                {variables.map((variable, index) => (
                  <div className="mapping-variable-row" key={variable.key}>
                    <input
                      aria-label={`${t('infra.variableName')} ${index + 1}`}
                      value={variable.name}
                      pattern="[A-Za-z_][A-Za-z0-9_]*"
                      required
                      spellCheck={false}
                      onChange={(event) =>
                        setVariables((current) =>
                          current.map((entry, at) =>
                            at === index ? { ...entry, name: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                    <input
                      aria-label={`${t('infra.variableValue')} ${index + 1}`}
                      value={variable.value}
                      onChange={(event) =>
                        setVariables((current) =>
                          current.map((entry, at) =>
                            at === index ? { ...entry, value: event.target.value } : entry,
                          ),
                        )
                      }
                    />
                    <Tooltip
                      content={t('mapping.removeVariable', {
                        name: variable.name || String(index + 1),
                      })}
                    >
                      <button
                        type="button"
                        className="mapping-icon-button"
                        aria-label={t('mapping.removeVariable', {
                          name: variable.name || String(index + 1),
                        })}
                        onClick={() =>
                          setVariables((current) => current.filter((_, at) => at !== index))
                        }
                      >
                        <MappingIcon kind="remove" />
                      </button>
                    </Tooltip>
                  </div>
                ))}
                <button
                  type="button"
                  className="mapping-add-variable"
                  onClick={() =>
                    setVariables((current) => [
                      ...current,
                      { key: crypto.randomUUID(), name: '', value: '' },
                    ])
                  }
                >
                  <MappingIcon kind="plus" />
                  {t('infra.addVariable')}
                </button>
              </div>
            </details>
            <details>
              <summary>
                <span>{t('mapping.portsLimits')}</span>
                <span className="mapping-count">{included.size}</span>
              </summary>
              <div className="mapping-details-body">
                {roles.length === 1 && roles[0]?.required ? (
                  <input type="hidden" name="primary" value={primary} />
                ) : (
                  <Select
                    label={t('infra.primary')}
                    name="primary"
                    value={primary}
                    onChange={(event) => setPrimary(event.target.value)}
                    required
                  >
                    <option value="">{t('infra.select')}</option>
                    {roles
                      .filter((role) => included.has(role.role))
                      .map((role) => (
                        <option key={role.role} value={role.role}>
                          {role.role} · {role.transport.toUpperCase()}
                        </option>
                      ))}
                  </Select>
                )}
                {roles.map((role) => (
                  <div className="mapping-port-row" key={role.role}>
                    <div className="mapping-port-role">
                      {role.required ? (
                        <strong>{role.role}</strong>
                      ) : (
                        <Check
                          label={role.role}
                          name={`include-${role.role}`}
                          checked={included.has(role.role)}
                          onChange={(event) => {
                            setIncluded((current) => {
                              const next = new Set(current);
                              if (event.target.checked) next.add(role.role);
                              else next.delete(role.role);
                              return next;
                            });
                            if (!event.target.checked && primary === role.role) setPrimary('');
                          }}
                        />
                      )}
                      <span className="mapping-transport">{role.transport.toUpperCase()}</span>
                    </div>
                    <Input
                      key={`${role.role}-${eggId}`}
                      label={t('infra.portVariable')}
                      name={`variable-${role.role}`}
                      defaultValue={
                        eggId === String(initial?.egg_id)
                          ? (initial?.port_roles.find((old) => old.role === role.role)
                              ?.environmentVariable ?? '')
                          : ''
                      }
                      pattern="[A-Za-z_][A-Za-z0-9_]*"
                      disabled={!included.has(role.role)}
                    />
                  </div>
                ))}
                <div className="mapping-pair mapping-limits">
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
                </div>
              </div>
            </details>
          </div>
        </fieldset>
      </div>
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
        title={t(editing ? 'mapping.edit' : 'mapping.create')}
        className="runtime-mapping-dialog"
        closeIcon
        initialFocusSelector="select:not(:disabled), input[name=enabled]"
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
