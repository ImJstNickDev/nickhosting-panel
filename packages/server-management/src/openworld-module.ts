import { randomBytes } from 'node:crypto';
import {
  type AuthContext,
  DomainError,
  type PlatformConfig,
  type SecretCodec,
} from '@nickhosting/core';
import { gameCatalog, getSettings } from '@nickhosting/database';
import { z } from 'zod';
import {
  openworldLauncherFile,
  openworldStartup,
  openworldTransientConfig,
} from '../../../games/openworld/src/dashboard-launch.js';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import {
  openworldConnectionMode,
  openworldSupportsGateway,
  openworldSupportsRuntime,
  openworldVersionDelivery,
} from '../../../games/openworld/src/version-policy.js';
import type { DB, Environment } from './admission.js';
import {
  assignRoleAllocations,
  backendAllocationAddress,
  effectiveBackendAllocationPool,
  type GatewayListenerConflict,
  gatewayListenerConflicts,
  poolAllowsLoopbackEgg,
} from './allocation-pool.js';
import type { GameRuntimeHooks, TrustedGameModule } from './game-modules.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { issueOpenworldArtifactUrl, listOpenworldReleases } from './openworld-catalog.js';
import { prepareOpenworldDashboardOnStart } from './openworld-dashboard.js';
import { createOpenworldUpdateHooks } from './openworld-update-engine.js';
import { openworldUpdatePlanSchema } from './openworld-update-plan.js';

const id = 'openworld';

function eligibleMappings(db: DB) {
  return db
    .selectFrom('runtime_egg_mappings as m')
    .innerJoin('managed_nodes as n', 'n.id', 'm.node_id')
    .innerJoin('physical_hosts as h', 'h.id', 'n.physical_host_id')
    .select([
      'm.id as mappingId',
      'm.nest_id',
      'm.egg_id',
      'm.port_roles',
      'n.id',
      'n.physical_host_id',
      'n.backend_allocation_pool',
      'n.pterodactyl_node_id as node',
    ])
    .where('h.enabled', '=', true)
    .where('m.game_id', '=', id)
    .where('m.runtime_id', '=', 'dedicated')
    .where('m.enabled', '=', true)
    .where('n.enabled', '=', true)
    .orderBy('n.pterodactyl_node_id');
}

type Mapping = Awaited<ReturnType<ReturnType<typeof eligibleMappings>['execute']>>[number];
const privateRoles = new Set(
  openworldManifest.ports.filter((p) => p.visibility === 'private').map((p) => p.role),
);

function configuredDelivery(
  mapping: Mapping,
  settings: PlatformConfig,
  env: Environment,
  conflicts?: GatewayListenerConflict,
) {
  const pool = effectiveBackendAllocationPool(mapping, env);
  if (!pool) return { gateway: false, direct: false };
  const allowLoopback = poolAllowsLoopbackEgg(pool, mapping);
  const candidates = pool.allocations
    .filter((pin) => pin.address !== '127.0.0.1' || allowLoopback)
    .map((pin) => ({
      ...pin,
      backendAddress: backendAllocationAddress(pin),
      id: pin.allocationId,
      ip: pin.address,
      assigned: false,
    }));
  const bind = pool.gatewayBindAddresses[0];
  const gateway = Boolean(
    settings.gatewayEnabled &&
      settings.gatewayId &&
      settings.gatewayPhysicalHostId === mapping.physical_host_id &&
      pool.gatewayBindAddresses.length === 1 &&
      conflicts,
  );
  // Test the configured pins with the same distinct-port/private-dashboard rules
  // as admission; live provider occupancy is checked only when reserving.
  const canAssign = (mode: 'gateway' | 'direct') => {
    try {
      assignRoleAllocations(
        mapping.port_roles,
        privateRoles,
        candidates,
        mode,
        gateway,
        mode === 'gateway' && bind && conflicts ? { address: bind, conflicts } : undefined,
      );
      return true;
    } catch (error) {
      if (error instanceof DomainError && error.code === 'allocation_unavailable') return false;
      throw error;
    }
  };
  return {
    gateway: gateway && canAssign('gateway'),
    direct: candidates.some((pin) => pin.directEndpoint) && canAssign('direct'),
  };
}

async function configuredMappings(db: DB, env: Environment, mappingId?: string) {
  const mappings = eligibleMappings(db);
  const [rows, { values }] = await Promise.all([
    (mappingId ? mappings.where('m.id', '=', mappingId) : mappings).execute(),
    getSettings(db, env),
  ]);
  const conflicts =
    values.gatewayEnabled &&
    values.gatewayId &&
    values.gatewayPhysicalHostId &&
    rows.some((row) => row.physical_host_id === values.gatewayPhysicalHostId)
      ? await gatewayListenerConflicts(db, values.gatewayPhysicalHostId, values.gatewayId, env)
      : undefined;
  return rows.map((row) => ({
    mappingId: row.mappingId,
    node: row.node,
    delivery: configuredDelivery(row, values, env, conflicts),
  }));
}

export async function openworldCreationChoices(
  db: DB,
  context: AuthContext,
  env: Environment,
  mappingId?: string,
) {
  const game = (await gameCatalog(db, context)).find((entry) => entry.id === id);
  if (!game?.access.canCreate) throw new DomainError('forbidden');
  return configuredMappings(db, env, mappingId);
}

const configurationSchema = z.strictObject({ version: z.string().min(1).max(128) });

export const openworldModule: TrustedGameModule = {
  id,
  manifest: openworldManifest,
  resolveConnectionMode: openworldConnectionMode,
  provisionAsResourceOwner: true,
  validateEggMapping({ startup, portRoles, environment }, egg) {
    const game = portRoles.find((row) => row.role === 'game');
    const dashboard = portRoles.find((row) => row.role === 'dashboard');
    const variables = egg.relationships?.variables?.data.map((v) => v.attributes);
    const required = [
      'OW_VERSION',
      'OW_SHA256',
      'OW_ARCHIVE_SIZE',
      'OW_DOWNLOAD_URL',
      'OW_SERVER_NAME',
      'OW_WEB_PORT',
      'OW_WEB_PASSWORD',
    ];
    if (
      environment.OW_DOWNLOAD_URL ||
      environment.OW_WEB_PASSWORD ||
      startup !== openworldStartup ||
      egg.startup !== startup ||
      !game?.primary ||
      game.protocols.join() !== 'udp' ||
      !dashboard ||
      dashboard.primary ||
      dashboard.protocols.join() !== 'tcp' ||
      portRoles.length !== 2 ||
      portRoles.some(
        (row) =>
          row.environmentVariable &&
          row.environmentVariable !== (row.role === 'dashboard' ? 'OW_WEB_PORT' : 'SERVER_PORT'),
      ) ||
      !required.every((key) =>
        variables?.some((v) => v.env_variable === key && !v.user_viewable && !v.user_editable),
      )
    )
      throw new DomainError('configuration_invalid');
  },
  async prepareCreation({ db, codec, context, env, mappingId, configuration, name }) {
    const input = configurationSchema.safeParse(configuration);
    if (!input.success) throw new DomainError('validation_failed');
    const [selected] = await openworldCreationChoices(db, context, env, mappingId);
    if (!selected) throw new DomainError('not_found');
    if (!openworldSupportsRuntime(input.data.version))
      throw new DomainError('game_request_unsupported');
    const delivery = openworldVersionDelivery(input.data.version, selected.delivery);
    if (!delivery) throw new DomainError('direct_connection_unavailable');
    if (!codec) throw new DomainError('integration_unavailable');
    const release = (await listOpenworldReleases(db, codec, env)).find(
      (item) => item.version === input.data.version,
    );
    if (!release) throw new DomainError('not_found');
    return {
      gateway: delivery === 'gateway',
      environment: {
        OW_VERSION: release.version,
        OW_SHA256: release.sha256,
        OW_ARCHIVE_SIZE: String(release.size),
        OW_SERVER_NAME: name,
      },
      async persist(connection, serverId) {
        await connection
          .insertInto('openworld_server_profiles')
          .values({
            server_id: serverId,
            dashboard_credential_prepared: true,
            version: release.version,
            sha256: release.sha256,
            size: release.size,
          })
          .execute();
      },
    };
  },
  async gatewayPolicyBinding(db, server) {
    const profile = await db
      .selectFrom('openworld_server_profiles')
      .select('version')
      .where('server_id', '=', server.id)
      .executeTakeFirst();
    return profile && openworldSupportsGateway(profile.version)
      ? { protocolId: id, gameVersion: profile.version }
      : null;
  },
  async assertProfileBinding(_db, _server, mapping) {
    if (mapping.game_id === id && mapping.runtime_id !== 'dedicated')
      throw new DomainError('configuration_invalid');
  },
  async authorizeOperation({ mapping, db, server }) {
    if (
      mapping.runtime_id !== 'dedicated' ||
      !(await db
        .selectFrom('openworld_server_profiles')
        .select('server_id')
        .where('server_id', '=', server.id)
        .executeTakeFirst())
    )
      throw new DomainError('configuration_invalid');
  },
  async filterCatalog(db, _context, entry, env) {
    if (
      !entry.access.canCreate ||
      (await configuredMappings(db, env)).some((row) => row.delivery.direct || row.delivery.gateway)
    )
      return entry;
    return { ...entry, access: { ...entry.access, canCreate: false } };
  },
};

export function createOpenworldModuleRuntime(
  codec: SecretCodec,
  env: Environment,
): GameRuntimeHooks {
  async function verifyFiles(context: GameLifecycleContext) {
    const identifier = context.server.pterodactyl_identifier;
    if (!identifier) throw new DomainError('integration_unavailable');
    const entries = await context.adapter.listFiles(identifier, '');
    const file = entries.find((entry) => entry.name === 'openworld-server');
    const assets = entries.find((entry) => entry.name === 'assets');
    if (
      !file?.is_file ||
      file.is_symlink ||
      !file.size ||
      (context.operation().plan.managedVersionUpdate === true &&
        file.size !==
          (context.operation().plan.openworldBinary as { size?: number } | undefined)?.size) ||
      !assets ||
      assets.is_file ||
      assets.is_symlink
    )
      throw new DomainError('configuration_invalid', 503, {
        reason: 'installation_outputs_missing',
      });
    return true;
  }
  return {
    versionUpdate: createOpenworldUpdateHooks(codec, env),
    async installerEnvironment(context, current) {
      const operation = context.operation();
      const update =
        operation.action === 'reinstall' && operation.plan.openworldUpdate
          ? openworldUpdatePlanSchema.parse(operation.plan.openworldUpdate)
          : undefined;
      const release =
        update?.target ??
        (await context.db
          .selectFrom('openworld_server_profiles')
          .select(['version', 'sha256', 'size'])
          .where('server_id', '=', context.server.id)
          .executeTakeFirstOrThrow());
      const dashboard = await context.db
        .selectFrom('server_allocations')
        .select(['port', 'private_only'])
        .where('server_id', '=', context.server.id)
        .where('role', '=', 'dashboard')
        .executeTakeFirstOrThrow();
      if (!dashboard.private_only) throw new DomainError('configuration_invalid');
      const { values } = await getSettings(context.db, env);
      if (!values.publicUrl) throw new DomainError('configuration_invalid');
      return {
        OW_VERSION: release.version,
        OW_ARCHIVE_SIZE: String(release.size),
        OW_SHA256: release.sha256,
        OW_WEB_PORT: String(dashboard.port),
        OW_WEB_PASSWORD:
          update && typeof current?.container.environment?.OW_WEB_PASSWORD === 'string'
            ? current.container.environment.OW_WEB_PASSWORD
            : randomBytes(32).toString('base64url'),
        OW_DOWNLOAD_URL: issueOpenworldArtifactUrl(
          codec,
          values.publicUrl,
          release,
          update ? operation.job_id : undefined,
        ),
      };
    },
    prepareStart: prepareOpenworldDashboardOnStart,
    configureProvision: verifyFiles,
    verifyRestore: verifyFiles,
    async processContent() {
      throw new DomainError('integration_unavailable');
    },
    async assertRuntimeImage(serverId, db, _requireObserved, snapshot) {
      if (!snapshot?.providerServer) return;
      const row = await db
        .selectFrom('managed_servers as s')
        .innerJoin('runtime_egg_mappings as m', 'm.id', 's.mapping_id')
        .select(['m.image_mode', 'm.docker_image', 'm.egg_id'])
        .where('s.id', '=', serverId)
        .executeTakeFirstOrThrow();
      const runtime = openworldManifest.runtimes[0]?.imagePolicy;
      const image =
        row.image_mode === 'integration' && runtime?.mode === 'fixed'
          ? runtime.image
          : row.docker_image;
      const remote = await snapshot.providerServer;
      if (
        remote.egg !== row.egg_id ||
        remote.container.image !== image ||
        remote.container.startup_command !== openworldStartup
      )
        throw new DomainError('configuration_invalid');
    },
    async assertFileMutation(_serverId, paths) {
      if (
        paths.some((path) =>
          [openworldLauncherFile, openworldTransientConfig].includes(
            path.replace(/^\/+|\/+$/g, ''),
          ),
        )
      )
        throw new DomainError('forbidden');
    },
    async verifyProcessEpoch(_serverId, _connection, before, readAgain) {
      const after = await readAgain();
      if (before !== after) throw new DomainError('operation_uncertain');
      return after;
    },
  };
}
