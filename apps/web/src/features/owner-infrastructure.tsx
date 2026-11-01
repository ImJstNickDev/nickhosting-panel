import { type UseQueryResult, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import type { Database } from '../../../../packages/database/src/index.js';
import type { Allocation, Nest, Node } from '../../../../packages/pterodactyl-adapter/src/types.js';
import type { listGatewayRoutes } from '../../../../packages/server-management/src/gateway-registry.js';
import type { getOwnerHealth } from '../../../../packages/server-management/src/health.js';
import type { listPlatformServers } from '../../../../packages/server-management/src/platform-queries.js';
import { ApiError, api } from '../api/client.js';
import type { Json, Result } from '../api/contracts.js';
import { useFormat, useT } from '../app/i18n.js';
import {
  ActionForm,
  Badge,
  Check,
  Details,
  Dialog,
  Empty,
  ErrorNotice,
  Input,
  Loading,
  Notice,
  number,
  Page,
  Section,
  Select,
  Textarea,
  Time,
  text,
} from '../components/ui.js';
import { AllocationPoolEditor } from './allocation-pool-editor.js';
import { allocationPins, initialAllocationSelection } from './allocation-pool-model.js';
import { TableRegion } from './servers.js';

type Row<T> = Json<{ [K in keyof T]: T[K] extends { __select__: infer S } ? S : T[K] }>;
type HostRow = Row<Database['physical_hosts']>;
type Host = {
  stored: HostRow;
  effective: HostRow;
  locked: boolean;
  effectiveUploadPolicy: HostRow['upload_policy'];
  uploadPolicyLocked: boolean;
};
type ManagedNode = Row<Database['managed_nodes']> & {
  effectiveBackendAllocationPool: Row<Database['managed_nodes']>['backend_allocation_pool'];
  backendAllocationPoolLocked: boolean;
  effectiveMemoryOverheadPercent: number;
  memoryOverheadLocked: boolean;
};
type Mapping = Row<Database['runtime_egg_mappings']>;
type Inventory = { nodes: Node[]; nests: Nest[] };
type Claim = Pick<
  Row<Database['server_allocations']>,
  | 'id'
  | 'node_id'
  | 'pterodactyl_allocation_id'
  | 'address'
  | 'backend_address'
  | 'port'
  | 'role'
  | 'protocols'
  | 'is_primary'
>;
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
function State({ status }: { status: string }) {
  const t = useT();
  return <Badge value={status} label={t(`infra.state.${status}`)} />;
}

export function OwnerHealthPage() {
  const t = useT(),
    format = useFormat();
  const health = useQuery({
    queryKey: ['owner-health'],
    queryFn: () => api<Result<typeof getOwnerHealth>>(path('health')),
    refetchInterval: 15000,
  });
  return (
    <Page
      title={t('infra.health')}
      actions={
        <button
          type="button"
          className="secondary"
          disabled={health.isFetching}
          onClick={() => void health.refetch()}
        >
          {t('infra.refresh')}
        </button>
      }
    >
      <QueryContent query={health}>
        {(value) => (
          <>
            <Section>
              <TableRegion label={t('infra.health')}>
                <table>
                  <thead>
                    <tr>
                      <th scope="col">{t('infra.component')}</th>
                      <th scope="col">{t('web.status')}</th>
                      <th scope="col">{t('infra.observed')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ['api', value.api],
                      ['database', value.database],
                      ['redis', value.redis],
                      ['worker', value.worker],
                      ['gatewayContact', value.gateway.controlPlane],
                      ['gatewayListeners', value.gateway.listenerReadiness],
                      ['provider', value.provider],
                    ].map(([key, check]) => {
                      const current = check as { status: string; observedAt: string | null };
                      return (
                        <tr key={String(key)}>
                          <th scope="row">{t(`infra.${key}`)}</th>
                          <td>
                            <State status={current.status} />
                          </td>
                          <td>
                            <Time value={current.observedAt} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableRegion>
              <p className="muted">{t('infra.contactLimit')}</p>
            </Section>
            <Section title={t('web.operations')}>
              <Details
                values={(['queued', 'running', 'failed', 'uncertain'] as const).map((key) => [
                  t(`infra.${key}`),
                  format.number(value.operations[key]),
                ])}
              />
              <Link to="/owner/operations">{t('web.viewActivity')}</Link>
            </Section>
            <Section title={t('infra.hosts')}>
              {value.hosts.items.length ? (
                <TableRegion label={t('infra.hosts')}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{t('web.name')}</th>
                        <th scope="col">{t('web.status')}</th>
                        <th scope="col">{t('infra.observed')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {value.hosts.items.map((host) => (
                        <tr key={host.id}>
                          <th scope="row">{host.name}</th>
                          <td>
                            <State status={host.status} />
                            {host.reason && <small>{t(`infra.reason.${host.reason}`)}</small>}
                          </td>
                          <td>
                            <Time value={host.observedAt} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableRegion>
              ) : (
                <Empty />
              )}
              <Link to="/owner/infrastructure">{t('web.infrastructure')}</Link>
            </Section>
            <Section title={t('infra.provider')}>
              {value.provider.readScopes.length ? (
                <ul className="plain-list">
                  {value.provider.readScopes.map((scope) => (
                    <li key={scope.scope}>
                      <span>{t(`infra.scope.${scope.scope}`)}</span>{' '}
                      <State status={scope.available ? 'healthy' : 'unavailable'} />
                    </li>
                  ))}
                </ul>
              ) : (
                <State status={value.provider.status} />
              )}
              <p className="muted">{t('infra.writeUnverified')}</p>
            </Section>
            <Section title={t('infra.gateway')}>
              <Details
                values={[
                  [t('infra.activeRoutes'), format.number(value.gateway.routes.enabled)],
                  [t('infra.leasedRoutes'), format.number(value.gateway.routes.leased)],
                ]}
              />
            </Section>
            <Notice>
              <Link to="https://github.com/ImJstNickDev/nickhosting-panel/issues/18">
                {t('infra.sftpGate')}
              </Link>
            </Notice>
          </>
        )}
      </QueryContent>
    </Page>
  );
}

export function OwnerInfrastructurePage() {
  const t = useT();
  const [tab, setTab] = useState<'hosts' | 'nodes' | 'mappings' | 'gateway' | 'providerInventory'>(
    'hosts',
  );
  return (
    <Page title={t('web.infrastructure')}>
      <nav className="tabs" aria-label={t('web.infrastructure')}>
        {(['hosts', 'nodes', 'mappings', 'gateway', 'providerInventory'] as const).map((value) => (
          <button
            type="button"
            className="secondary"
            aria-pressed={tab === value}
            key={value}
            onClick={() => setTab(value)}
          >
            {t(`infra.${value}`)}
          </button>
        ))}
      </nav>
      {tab === 'hosts' && <Hosts />}
      {tab === 'nodes' && <Nodes />}
      {tab === 'mappings' && <Mappings />}
      {tab === 'gateway' && <Routes />}
      {tab === 'providerInventory' && <ProviderInventory />}
    </Page>
  );
}
function Hosts() {
  const t = useT(),
    format = useFormat();
  const [editing, setEditing] = useState<Host | null | undefined>();
  const hosts = useQuery({
    queryKey: ['owner-hosts'],
    queryFn: () => api<Host[]>(path('resource-hosts')),
  });
  return (
    <Section
      title={t('infra.hosts')}
      actions={
        <button type="button" onClick={() => setEditing(null)}>
          {t('infra.addHost')}
        </button>
      }
    >
      <QueryContent query={hosts}>
        {(rows) =>
          rows.length ? (
            <TableRegion label={t('infra.hosts')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('web.name')}</th>
                    <th scope="col">{t('web.memory')}</th>
                    <th scope="col">{t('web.cpu')}</th>
                    <th scope="col">{t('web.status')}</th>
                    <th scope="col">{t('web.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.stored.id}>
                      <th scope="row">{row.stored.name}</th>
                      <td>{format.number(row.effective.memory_limit_mib)} MiB</td>
                      <td>{format.number(row.effective.cpu_limit_percent)}%</td>
                      <td>{t(row.effective.enabled ? 'infra.enabled' : 'infra.state.disabled')}</td>
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          disabled={row.locked}
                          onClick={() => setEditing(row)}
                        >
                          {t('web.edit')}
                        </button>
                        {row.locked && <small>{t('infra.locked')}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          ) : (
            <Empty />
          )
        }
      </QueryContent>
      <Dialog
        open={editing !== undefined}
        title={t(editing ? 'web.edit' : 'infra.addHost')}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <HostForm
            initial={editing}
            onSaved={async () => {
              await hosts.refetch();
              setEditing(undefined);
            }}
          />
        )}
      </Dialog>
    </Section>
  );
}
function HostForm({ initial, onSaved }: { initial: Host | null; onSaved: () => Promise<void> }) {
  const t = useT();
  const value = initial?.stored;
  const [uploads, setUploads] = useState(Boolean(value?.upload_policy));
  return (
    <ActionForm
      onSubmit={async (data) => {
        await api(path('resource-hosts'), {
          method: 'PUT',
          body: {
            ...(value ? { id: value.id } : {}),
            name: text(data, 'name'),
            memoryLimitMiB: number(data, 'memory'),
            cpuLimitPercent: number(data, 'cpu'),
            storagePoolMiB: number(data, 'storage'),
            memoryHeadroomMiB: number(data, 'memoryHeadroom'),
            cpuHeadroomPercent: number(data, 'cpuHeadroom'),
            diskHeadroomMiB: number(data, 'diskHeadroom'),
            localDiskPath: text(data, 'diskPath'),
            observerId: text(data, 'observer'),
            enabled: data.has('enabled'),
            ...(initial?.uploadPolicyLocked
              ? {}
              : {
                  uploadPolicy: uploads
                    ? {
                        providerMaxFileBytes: number(data, 'providerMax'),
                        temporaryDiskPath: text(data, 'temporaryPath'),
                        temporaryDiskBudgetBytes: number(data, 'temporaryBudget'),
                        temporaryDiskHeadroomBytes: number(data, 'temporaryHeadroom'),
                      }
                    : null,
                }),
          },
        });
        await onSaved();
      }}
    >
      <Input
        label={t('web.name')}
        name="name"
        defaultValue={value?.name}
        maxLength={100}
        required
      />
      <Input
        label={t('infra.observer')}
        name="observer"
        defaultValue={value?.observer_id}
        pattern="[a-zA-Z0-9_-]{1,64}"
        required
      />
      <Input
        label={t('infra.diskPath')}
        name="diskPath"
        defaultValue={value?.local_disk_path}
        required
      />
      <div className="form-grid">
        {[
          ['memory', 'memoryLimit', value?.memory_limit_mib, 1],
          ['cpu', 'cpuLimit', value?.cpu_limit_percent, 1],
          ['storage', 'storagePool', value?.storage_pool_mib, 1],
          ['memoryHeadroom', 'memoryHeadroom', value?.memory_headroom_mib ?? 256, 256],
          ['cpuHeadroom', 'cpuHeadroom', value?.cpu_headroom_percent ?? 0, 0],
          ['diskHeadroom', 'diskHeadroom', value?.disk_headroom_mib ?? 256, 256],
        ].map(([name, label, defaultValue, min]) => (
          <Input
            key={String(name)}
            label={t(`infra.${label}`)}
            name={String(name)}
            type="number"
            min={Number(min)}
            step={1}
            defaultValue={defaultValue ?? undefined}
            required
          />
        ))}
      </div>
      <Check label={t('infra.enabled')} name="enabled" defaultChecked={value?.enabled ?? true} />
      <details>
        <summary>{t('infra.uploadPolicy')}</summary>
        {initial?.uploadPolicyLocked && <Notice>{t('infra.locked')}</Notice>}
        <fieldset disabled={initial?.uploadPolicyLocked}>
          <Check
            label={t('infra.uploadEnabled')}
            checked={uploads}
            onChange={(event) => setUploads(event.target.checked)}
          />
          {uploads && (
            <>
              <Input
                label={t('infra.providerMaxFile')}
                name="providerMax"
                type="number"
                min={1}
                step={1}
                defaultValue={value?.upload_policy?.providerMaxFileBytes}
                required
              />
              <Input
                label={t('infra.temporaryPath')}
                name="temporaryPath"
                defaultValue={value?.upload_policy?.temporaryDiskPath}
                required
              />
              <Input
                label={t('infra.temporaryBudget')}
                name="temporaryBudget"
                type="number"
                min={65536}
                step={1}
                defaultValue={value?.upload_policy?.temporaryDiskBudgetBytes}
                required
              />
              <Input
                label={t('infra.temporaryHeadroom')}
                name="temporaryHeadroom"
                type="number"
                min={0}
                step={1}
                defaultValue={value?.upload_policy?.temporaryDiskHeadroomBytes ?? 0}
                required
              />
            </>
          )}
        </fieldset>
      </details>
    </ActionForm>
  );
}
function Nodes() {
  const t = useT();
  const [editing, setEditing] = useState<ManagedNode | null | undefined>();
  const nodes = useQuery({
    queryKey: ['owner-nodes'],
    queryFn: () => api<ManagedNode[]>(path('nodes')),
  });
  const hosts = useQuery({
    queryKey: ['owner-hosts'],
    queryFn: () => api<Host[]>(path('resource-hosts')),
  });
  return (
    <Section
      title={t('infra.nodes')}
      actions={
        <button type="button" onClick={() => setEditing(null)}>
          {t('infra.addNode')}
        </button>
      }
    >
      <QueryContent query={nodes}>
        {(rows) =>
          rows.length ? (
            <TableRegion label={t('infra.nodes')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('infra.providerNode')}</th>
                    <th scope="col">{t('infra.host')}</th>
                    <th scope="col">{t('infra.pool')}</th>
                    <th scope="col">{t('web.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">{row.pterodactyl_node_id}</th>
                      <td>
                        {hosts.data?.find((host) => host.stored.id === row.physical_host_id)?.stored
                          .name ?? row.physical_host_id}
                      </td>
                      <td>{row.effectiveBackendAllocationPool?.allocations.length ?? 0}</td>
                      <td>
                        <button type="button" className="secondary" onClick={() => setEditing(row)}>
                          {t('web.edit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          ) : (
            <Empty />
          )
        }
      </QueryContent>
      <Notice>{t('infra.noInfrastructureMutation')}</Notice>
      <Dialog
        open={editing !== undefined}
        title={t('infra.nodes')}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <NodeForm
            initial={editing}
            onSaved={async () => {
              await nodes.refetch();
              setEditing(undefined);
            }}
          />
        )}
      </Dialog>
    </Section>
  );
}
function NodeForm({
  initial,
  onSaved,
}: {
  initial: ManagedNode | null;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [providerNode, setProviderNode] = useState(String(initial?.pterodactyl_node_id ?? ''));
  const [pool, setPool] = useState(Boolean(initial?.backend_allocation_pool));
  const [selected, setSelected] = useState(
    initialAllocationSelection(initial?.backend_allocation_pool?.allocations),
  );
  const [eggs, setEggs] = useState(
    initial?.backend_allocation_pool?.loopbackRemap?.verifiedEggs.map((egg) => ({
      ...egg,
      key: crypto.randomUUID(),
    })) ?? [],
  );
  const inventory = useQuery({
    queryKey: ['owner-provider'],
    queryFn: () => api<Inventory>(path('infrastructure')),
  });
  const hosts = useQuery({
    queryKey: ['owner-hosts'],
    queryFn: () => api<Host[]>(path('resource-hosts')),
  });
  const allocations = useQuery({
    queryKey: ['owner-provider-allocations', providerNode],
    queryFn: () => api<Allocation[]>(path(`nodes/${encodeURIComponent(providerNode)}/allocations`)),
    enabled: Boolean(providerNode),
  });
  const hasLoopback =
    allocations.data?.some(
      (allocation) => selected.has(allocation.id) && allocation.ip === '127.0.0.1',
    ) ?? false;
  return (
    <ActionForm
      onSubmit={async (data) => {
        if (pool && !initial?.backendAllocationPoolLocked && !allocations.data)
          throw new ApiError('integration_unavailable', 'errors.integration_unavailable');
        let pins: ReturnType<typeof allocationPins> = [];
        try {
          pins =
            pool && !initial?.backendAllocationPoolLocked && allocations.data
              ? allocationPins(selected, allocations.data, text(data, 'bridgeAddress'))
              : [];
        } catch {
          throw new ApiError('validation_failed', 'errors.validation_failed');
        }
        await api(path('nodes'), {
          method: 'PUT',
          body: {
            ...(initial ? { id: initial.id } : {}),
            physicalHostId: text(data, 'host'),
            pterodactylNodeId: Number(providerNode),
            installerMemoryMiB: number(data, 'installerMemory'),
            installerCpuPercent: number(data, 'installerCpu'),
            memoryOverheadPercent: initial?.memoryOverheadLocked
              ? initial.memory_overhead_percent
              : number(data, 'overhead'),
            enabled: data.has('enabled'),
            ...(initial?.backendAllocationPoolLocked
              ? {}
              : {
                  backendAllocationPool: pool
                    ? {
                        allocations: pins,
                        gatewayBindAddresses: text(data, 'gatewayBinds')
                          .split(/\s+/)
                          .filter(Boolean),
                        ...(hasLoopback
                          ? {
                              loopbackRemap: {
                                wingsVersion: '1.11.13',
                                networkMode: text(data, 'networkMode'),
                                networkDriver: 'bridge',
                                gatewayMode: 'nat',
                                interfaceAddress: text(data, 'bridgeAddress'),
                                ispn: false,
                                verifiedEggs: eggs.map(({ key, ...egg }) => egg),
                              },
                            }
                          : {}),
                      }
                    : null,
                }),
          },
        });
        await onSaved();
      }}
    >
      <QueryContent query={hosts}>
        {(rows) => (
          <Select
            label={t('infra.host')}
            name="host"
            defaultValue={initial?.physical_host_id ?? ''}
            required
          >
            <option value="">{t('infra.select')}</option>
            {rows.map((host) => (
              <option key={host.stored.id} value={host.stored.id}>
                {host.stored.name}
              </option>
            ))}
          </Select>
        )}
      </QueryContent>
      <QueryContent query={inventory}>
        {(value) => (
          <Select
            label={t('infra.providerNode')}
            value={providerNode}
            onChange={(event) => {
              setProviderNode(event.target.value);
              setSelected(new Map());
              setEggs([]);
            }}
            required
          >
            <option value="">{t('infra.select')}</option>
            {value.nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.name} · {node.id}
              </option>
            ))}
          </Select>
        )}
      </QueryContent>
      <Input
        label={t('infra.installerMemory')}
        name="installerMemory"
        type="number"
        min={1}
        defaultValue={initial?.installer_memory_mib ?? 1024}
        required
      />
      <Input
        label={t('infra.installerCpu')}
        name="installerCpu"
        type="number"
        min={1}
        defaultValue={initial?.installer_cpu_percent ?? 100}
        required
      />
      <Input
        label={t('infra.overhead')}
        name="overhead"
        type="number"
        min={100}
        max={400}
        defaultValue={initial?.effectiveMemoryOverheadPercent ?? 115}
        disabled={initial?.memoryOverheadLocked}
        required
      />
      {initial?.memoryOverheadLocked && <Notice>{t('infra.locked')}</Notice>}
      <Check label={t('infra.enabled')} name="enabled" defaultChecked={initial?.enabled ?? true} />
      <details open={pool}>
        <summary>{t('infra.pool')}</summary>
        {initial?.backendAllocationPoolLocked && <Notice>{t('infra.locked')}</Notice>}
        <fieldset disabled={initial?.backendAllocationPoolLocked}>
          <Check
            label={t('infra.configurePool')}
            checked={pool}
            onChange={(event) => setPool(event.target.checked)}
          />
          {pool && (
            <>
              <Textarea
                label={t('infra.gatewayBinds')}
                name="gatewayBinds"
                defaultValue={initial?.backend_allocation_pool?.gatewayBindAddresses.join('\n')}
              />
              <Notice>{t('infra.directHelp')}</Notice>
              {providerNode && (
                <QueryContent query={allocations}>
                  {(rows) => (
                    <AllocationPoolEditor
                      key={providerNode}
                      rows={rows}
                      selected={selected}
                      retained={initialAllocationSelection(
                        Number(providerNode) === initial?.pterodactyl_node_id
                          ? initial.backend_allocation_pool?.allocations
                          : [],
                      )}
                      onChange={setSelected}
                    />
                  )}
                </QueryContent>
              )}
              {hasLoopback && (
                <fieldset>
                  <legend>{t('infra.remap')}</legend>
                  <p>{t('infra.remapWarning')}</p>
                  <Input
                    label={t('infra.networkMode')}
                    name="networkMode"
                    defaultValue={initial?.backend_allocation_pool?.loopbackRemap?.networkMode}
                    required
                  />
                  <Input
                    label={t('infra.bridgeAddress')}
                    name="bridgeAddress"
                    defaultValue={initial?.backend_allocation_pool?.loopbackRemap?.interfaceAddress}
                    required
                  />
                  <h3>{t('infra.verifiedEggs')}</h3>
                  {eggs.map((egg, index) => (
                    <div className="form-grid" key={egg.key}>
                      <Input
                        label={t('infra.nest')}
                        type="number"
                        min={1}
                        value={egg.nestId || ''}
                        required
                        onChange={(event) =>
                          setEggs((current) =>
                            current.map((entry, at) =>
                              at === index
                                ? { ...entry, nestId: Number(event.target.value) }
                                : entry,
                            ),
                          )
                        }
                      />
                      <Input
                        label={t('infra.egg')}
                        type="number"
                        min={1}
                        value={egg.eggId || ''}
                        required
                        onChange={(event) =>
                          setEggs((current) =>
                            current.map((entry, at) =>
                              at === index
                                ? { ...entry, eggId: Number(event.target.value) }
                                : entry,
                            ),
                          )
                        }
                      />
                      <button
                        type="button"
                        className="secondary"
                        onClick={() =>
                          setEggs((current) => current.filter((_, at) => at !== index))
                        }
                      >
                        {t('web.remove')}
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() =>
                      setEggs((current) => [
                        ...current,
                        { key: crypto.randomUUID(), nestId: 0, eggId: 0, forceOutgoingIp: false },
                      ])
                    }
                  >
                    {t('infra.addEgg')}
                  </button>
                  <Check label={t('infra.remapConsent')} required />
                </fieldset>
              )}
            </>
          )}
        </fieldset>
      </details>
    </ActionForm>
  );
}

function Mappings() {
  const t = useT();
  const mappings = useQuery({
    queryKey: ['runtime-mappings'],
    queryFn: () => api<Mapping[]>(path('runtime-mappings')),
  });
  return (
    <Section title={t('infra.mappings')}>
      <QueryContent query={mappings}>
        {(rows) =>
          rows.length ? (
            <TableRegion label={t('infra.mappings')}>
              <table>
                <thead>
                  <tr>
                    <th>{t('infra.game')}</th>
                    <th>{t('infra.runtime')}</th>
                    <th>{t('infra.egg')}</th>
                    <th>{t('web.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">{row.game_id}</th>
                      <td>{row.runtime_id}</td>
                      <td>
                        {row.nest_id} / {row.egg_id}
                      </td>
                      <td>
                        <Link
                          to={`/owner/integrations/${encodeURIComponent(row.game_id)}/runtime?runtime=${encodeURIComponent(row.runtime_id)}`}
                        >
                          {t('web.edit')}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          ) : (
            <Empty />
          )
        }
      </QueryContent>
      <Link to="/owner/integrations">{t('web.integrations')}</Link>
    </Section>
  );
}
function Routes() {
  const t = useT();
  const [editing, setEditing] = useState<
    Result<typeof listGatewayRoutes>[number] | null | undefined
  >();
  const routes = useQuery({
    queryKey: ['owner-gateway-routes'],
    queryFn: () => api<Result<typeof listGatewayRoutes>>(path('gateway/routes')),
  });
  return (
    <Section
      title={t('infra.gateway')}
      actions={
        <button type="button" onClick={() => setEditing(null)}>
          {t('infra.addRoute')}
        </button>
      }
    >
      <QueryContent query={routes}>
        {(rows) =>
          rows.length ? (
            <TableRegion label={t('infra.gateway')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('web.servers')}</th>
                    <th scope="col">{t('infra.publicAddress')}</th>
                    <th scope="col">{t('infra.transport')}</th>
                    <th scope="col">{t('infra.revision')}</th>
                    <th scope="col">{t('web.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <Link to={`/servers/${row.server_id}`}>{row.server_id}</Link>
                      </td>
                      <td>
                        {row.public_address}:{row.public_port}
                      </td>
                      <td>{row.transport.toUpperCase()}</td>
                      <td>
                        {row.revision} · {t(row.enabled ? 'infra.enabled' : 'infra.state.disabled')}
                      </td>
                      <td>
                        <button type="button" className="secondary" onClick={() => setEditing(row)}>
                          {t('web.edit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          ) : (
            <Empty />
          )
        }
      </QueryContent>
      <p>
        <Link to="/owner/settings">{t('infra.gatewaySettings')}</Link>
      </p>
      <Dialog
        open={editing !== undefined}
        title={t('infra.gateway')}
        onClose={() => setEditing(undefined)}
      >
        {editing !== undefined && (
          <RouteForm
            initial={editing}
            onSaved={async () => {
              await routes.refetch();
              setEditing(undefined);
            }}
          />
        )}
      </Dialog>
    </Section>
  );
}
function RouteForm({
  initial,
  onSaved,
}: {
  initial: Result<typeof listGatewayRoutes>[number] | null;
  onSaved: () => Promise<void>;
}) {
  const t = useT();
  const [server, setServer] = useState(initial?.server_id ?? ''),
    [q, setQ] = useState('');
  const servers = useQuery({
    queryKey: ['owner-route-servers', q],
    queryFn: () =>
      api<Result<typeof listPlatformServers>>(
        `/v1/platform/servers?q=${encodeURIComponent(q)}&limit=100`,
      ),
  });
  const claims = useQuery({
    queryKey: ['owner-server-claims', server],
    queryFn: () => api<Claim[]>(path(`servers/${encodeURIComponent(server)}/allocations`)),
    enabled: Boolean(server),
  });
  const [claim, setClaim] = useState(initial?.allocation_id ?? '');
  const selected = claims.data?.find((row) => row.id === claim);
  return (
    <ActionForm
      onSubmit={async (data) => {
        await api(path('gateway/routes'), {
          method: 'PUT',
          body: {
            ...(initial ? { id: initial.id } : {}),
            serverId: server,
            allocationId: claim,
            publicAddress: text(data, 'address'),
            publicPort: number(data, 'port'),
            transport: text(data, 'transport'),
            enabled: data.has('enabled'),
          },
        });
        await onSaved();
      }}
    >
      <Input label={t('web.search')} value={q} onChange={(event) => setQ(event.target.value)} />
      <QueryContent query={servers}>
        {(rows) => (
          <Select
            label={t('web.servers')}
            value={server}
            onChange={(event) => {
              setServer(event.target.value);
              setClaim('');
            }}
            required
          >
            <option value="">{t('infra.select')}</option>
            {initial && !rows.items.some((row) => row.id === initial.server_id) && (
              <option value={initial.server_id}>{initial.server_id}</option>
            )}
            {rows.items.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </Select>
        )}
      </QueryContent>
      {server && (
        <QueryContent query={claims}>
          {(rows) => (
            <Select
              label={t('infra.allocation')}
              value={claim}
              onChange={(event) => setClaim(event.target.value)}
              required
            >
              <option value="">{t('infra.select')}</option>
              {rows.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.role} · {row.backend_address}:{row.port} · {row.protocols.join('/')}
                </option>
              ))}
            </Select>
          )}
        </QueryContent>
      )}
      <Input
        label={t('infra.publicAddress')}
        name="address"
        defaultValue={initial?.public_address}
        required
      />
      <Input
        label={t('infra.port')}
        name="port"
        type="number"
        min={1}
        max={65535}
        defaultValue={initial?.public_port}
        required
      />
      <Select
        key={claim}
        label={t('infra.transport')}
        name="transport"
        defaultValue={initial?.transport ?? selected?.protocols[0] ?? ''}
        required
      >
        <option value="">{t('infra.select')}</option>
        {selected?.protocols.map((protocol) => (
          <option key={protocol} value={protocol}>
            {protocol.toUpperCase()}
          </option>
        ))}
      </Select>
      <Check label={t('infra.enabled')} name="enabled" defaultChecked={initial?.enabled ?? false} />
      <Notice>{t('infra.routeGuard')}</Notice>
      <Check label={t('web.confirm')} required />
    </ActionForm>
  );
}
function ProviderInventory() {
  const t = useT(),
    format = useFormat();
  const [node, setNode] = useState('');
  const inventory = useQuery({
    queryKey: ['owner-provider'],
    queryFn: () => api<Inventory>(path('infrastructure')),
  });
  const allocations = useQuery({
    queryKey: ['owner-provider-allocations', node],
    queryFn: () => api<Allocation[]>(path(`nodes/${encodeURIComponent(node)}/allocations`)),
    enabled: Boolean(node),
  });
  return (
    <Section title={t('infra.providerInventory')}>
      <QueryContent query={inventory}>
        {(value) => (
          <>
            <TableRegion label={t('infra.nodes')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('web.name')}</th>
                    <th scope="col">{t('infra.configuredMemory')}</th>
                    <th scope="col">{t('infra.allocatedMemory')}</th>
                    <th scope="col">{t('web.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {value.nodes.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">{item.name}</th>
                      <td>{format.number(item.memory)}</td>
                      <td>
                        {item.allocated_resources
                          ? format.number(item.allocated_resources.memory)
                          : t('web.unknown')}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setNode(String(item.id))}
                        >
                          {t('infra.pool')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
            <p className="muted">{t('infra.allocatedNotUsage')}</p>
          </>
        )}
      </QueryContent>
      {node && (
        <QueryContent query={allocations}>
          {(rows) => (
            <TableRegion label={t('infra.pool')}>
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t('infra.address')}</th>
                    <th scope="col">{t('infra.port')}</th>
                    <th scope="col">{t('web.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.ip}</td>
                      <td>{row.port}</td>
                      <td>{t(row.assigned ? 'infra.assigned' : 'infra.available')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableRegion>
          )}
        </QueryContent>
      )}
    </Section>
  );
}
