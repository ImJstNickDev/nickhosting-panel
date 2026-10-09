import type { ColumnType, Generated } from 'kysely';

type Json<T> = ColumnType<T, string, string>;
export interface BackendAllocationPool {
  allocations: Array<{ allocationId: number; address: string; port: number }>;
  gatewayBindAddresses: string[];
}
export interface UploadPolicy {
  providerMaxFileBytes: number;
  temporaryDiskPath: string;
  temporaryDiskBudgetBytes: number;
  temporaryDiskHeadroomBytes: number;
}
export interface UploadScope {
  observerId: string;
  nodeId: string;
  pterodactylNodeId: number;
  pterodactylServerId: number;
  pterodactylServerUuid: string;
  externalId: string;
  policy: UploadPolicy;
}
export interface ServerLimits {
  memory: number;
  cpu: number;
  disk: number;
  swap: number;
  io: number;
  threads?: string;
}
export interface HostSnapshot {
  totalMemoryMiB: number;
  availableMemoryMiB: number;
  cpuCapacityPercent: number;
  cpuBusyPercent: number;
  availableDiskMiB: number;
  /** Current actual usage of registered servers only; unrelated workload remains in host totals. */
  managed: Record<string, { memoryMiB: number; cpuPercent: number }>;
  observedAt: string;
}
export interface ServerTables {
  physical_hosts: {
    id: string;
    name: string;
    memory_limit_mib: number;
    cpu_limit_percent: number;
    storage_pool_mib: string;
    memory_headroom_mib: number;
    cpu_headroom_percent: number;
    disk_headroom_mib: string;
    local_disk_path: string;
    upload_policy: ColumnType<UploadPolicy | null, string | null | undefined, string | null>;
    observer_id: string;
    enabled: Generated<boolean>;
    updated_at: Generated<Date>;
  };
  upload_ingestion_claims: {
    id: string;
    physical_host_id: string;
    server_id: string;
    actor_user_id: string;
    declared_bytes: string;
    reserved_bytes: string;
    scope: Json<UploadScope>;
    scope_hash: string;
    created_at: Generated<Date>;
  };
  managed_nodes: {
    id: string;
    physical_host_id: string;
    pterodactyl_node_id: number;
    provision_user_id: number;
    backend_allocation_pool: ColumnType<
      BackendAllocationPool | null,
      string | null | undefined,
      string | null
    >;
    installer_memory_mib: Generated<number>;
    installer_cpu_percent: Generated<number>;
    memory_overhead_percent: Generated<number>;
    enabled: Generated<boolean>;
  };
  runtime_egg_mappings: {
    id: string;
    game_id: string;
    runtime_id: string;
    node_id: string;
    nest_id: number;
    egg_id: number;
    docker_image: string;
    startup: string;
    environment: Json<Record<string, string>>;
    port_roles: Json<
      Array<{
        role: string;
        protocols: ('tcp' | 'udp')[];
        primary: boolean;
        environmentVariable?: string;
      }>
    >;
    feature_limits: Json<{ databases: number; allocations: number; backups: number }>;
    enabled: Generated<boolean>;
  };
  projects: { id: string; owner_id: string; name: string; created_at: Generated<Date> };
  project_members: { project_id: string; user_id: string; role: 'manager' | 'operator' | 'viewer' };
  managed_servers: {
    id: string;
    owner_id: string;
    project_id: string | null;
    mapping_id: string;
    node_id: string;
    name: string;
    external_id: string;
    pterodactyl_id: number | null;
    pterodactyl_uuid: string | null;
    pterodactyl_identifier: string | null;
    limits: Json<ServerLimits>;
    runtime_state: Generated<'offline' | 'starting' | 'running' | 'stopping' | 'unknown'>;
    readiness: Generated<'unknown' | 'loading' | 'ready' | 'degraded'>;
    intent: Generated<'manually_stopped' | 'maintenance' | 'auto_wake_enabled' | 'sleeping'>;
    installation_state: Generated<'pending' | 'installing' | 'installed' | 'failed'>;
    active_operation_id: string | null;
    last_observed_at: Date | null;
    deleted_at: Date | null;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  server_allocations: {
    id: string;
    server_id: string;
    node_id: string;
    pterodactyl_allocation_id: number;
    address: string;
    port: number;
    role: string;
    protocols: ('tcp' | 'udp')[];
    is_primary: boolean;
  };
  resource_reservations: {
    server_id: string;
    owner_id: string;
    physical_host_id: string;
    memory_mib: number;
    physical_memory_mib: number;
    cpu_percent: number;
    operation_id: string;
    state: 'starting' | 'running' | 'restarting' | 'stopping' | 'uncertain';
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  resource_user_limits: {
    user_id: string;
    memory_mib: number;
    cpu_percent: number;
    storage_mib: string;
    expires_at: Date | null;
    updated_at: Generated<Date>;
  };
  installation_reservations: {
    server_id: string;
    physical_host_id: string;
    operation_id: string;
    memory_mib: number;
    cpu_percent: number;
    created_at: Generated<Date>;
    updated_at: Generated<Date>;
  };
  host_observations: {
    host_id: string;
    observer_id: string;
    snapshot: Json<HostSnapshot>;
    observed_at: Date;
  };
  server_operations: {
    job_id: string;
    server_id: string;
    action:
      | 'provision'
      | 'start'
      | 'stop'
      | 'restart'
      | 'reinstall'
      | 'wipe'
      | 'delete'
      | 'backup'
      | 'restore'
      | 'configure';
    phase: Generated<string>;
    plan: Json<Record<string, unknown>>;
    effect_state: Generated<'none' | 'prepared' | 'uncertain' | 'confirmed'>;
    effect_started_at: Date | null;
    lease_until: Date | null;
    lease_token: string | null;
    updated_at: Generated<Date>;
  };
  server_events: {
    id: Generated<string>;
    server_id: string;
    job_id: string | null;
    actor_id: string | null;
    subject_id: string | null;
    support_session_id: string | null;
    message_key: string;
    data: Json<Record<string, unknown>>;
    created_at: Generated<Date>;
  };
  server_metrics: {
    server_id: string;
    observed_at: Date;
    memory_bytes: string;
    cpu_percent: number;
    disk_bytes: string;
    network_rx_bytes: string;
    network_tx_bytes: string;
  };
  test_asset_provenance: {
    server_id: string;
    run_id: string;
    pr_number: number;
    external_id: string;
    pterodactyl_id: number;
    pterodactyl_uuid: string;
    created_at: Date;
    verified_at: Date;
    deleted_at: Date | null;
  };
  external_sftp_credentials: {
    id: string;
    server_id: string;
    actor_id: string;
    envelope: Json<unknown>;
    provider_ref: Json<unknown> | null;
    expires_at: Date;
    state: 'pending' | 'active' | 'revoking' | 'revoked' | 'uncertain';
    created_at: Generated<Date>;
  };
  dns_assignments: {
    id: string;
    server_id: string;
    hostname: string;
    ownership_token: string;
    plan: Json<unknown>;
    ledger: Json<unknown>;
    state: 'pending' | 'active' | 'deleting' | 'deleted' | 'uncertain';
    updated_at: Generated<Date>;
  };
}
