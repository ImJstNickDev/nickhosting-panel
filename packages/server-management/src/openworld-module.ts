import { type AuthContext, DomainError, type SecretCodec } from '@nickhosting/core';
import { gameCatalog, getSettings } from '@nickhosting/database';
import { z } from 'zod';
import {
  openworldLauncherFile,
  openworldStartup,
  openworldTransientConfig,
} from '../../../games/openworld/src/dashboard-launch.js';
import { openworldManifest } from '../../../games/openworld/src/manifest.js';
import type { DB, Environment } from './admission.js';
import type { GameRuntimeHooks, TrustedGameModule } from './game-modules.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { issueOpenworldArtifactUrl, listOpenworldReleases } from './openworld-catalog.js';

const id = 'openworld';

function eligibleMappings(db: DB) {
  return db
    .selectFrom('runtime_egg_mappings as m')
    .innerJoin('managed_nodes as n', 'n.id', 'm.node_id')
    .select(['m.id as mappingId', 'n.pterodactyl_node_id as node'])
    .where('m.game_id', '=', id)
    .where('m.runtime_id', '=', 'dedicated')
    .where('m.enabled', '=', true)
    .where('n.enabled', '=', true)
    .orderBy('n.pterodactyl_node_id');
}

export async function openworldCreationChoices(db: DB, context: AuthContext) {
  const game = (await gameCatalog(db, context)).find((entry) => entry.id === id);
  if (!game?.access.canCreate) throw new DomainError('forbidden');
  return eligibleMappings(db).execute();
}

const supportsGateway = (version: string) => version === 'a1.2.9';
const configurationSchema = z.strictObject({ version: z.string().min(1).max(128) });

export const openworldModule: TrustedGameModule = {
  id,
  manifest: openworldManifest,
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
    const mappings = await openworldCreationChoices(db, context);
    if (!mappings.some((row) => row.mappingId === mappingId)) throw new DomainError('not_found');
    if (!codec) throw new DomainError('integration_unavailable');
    const release = (await listOpenworldReleases(db, codec, env)).find(
      (item) => item.version === input.data.version,
    );
    if (!release) throw new DomainError('not_found');
    return {
      gateway: supportsGateway(release.version),
      environment: {
        OW_VERSION: release.version,
        OW_SHA256: release.sha256,
        OW_ARCHIVE_SIZE: String(release.size),
        OW_SERVER_NAME: name,
        OW_WEB_PASSWORD: '',
      },
      async persist(connection, serverId) {
        await connection
          .insertInto('openworld_server_profiles')
          .values({
            server_id: serverId,
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
    return profile && supportsGateway(profile.version)
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
  async filterCatalog(db, _context, entry) {
    if (!entry.access.canCreate || (await eligibleMappings(db).limit(1).executeTakeFirst()))
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
    async installerEnvironment(context) {
      const release = await context.db
        .selectFrom('openworld_server_profiles')
        .select(['version', 'sha256', 'size'])
        .where('server_id', '=', context.server.id)
        .executeTakeFirstOrThrow();
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
        OW_DOWNLOAD_URL: issueOpenworldArtifactUrl(codec, values.publicUrl, release),
      };
    },
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
