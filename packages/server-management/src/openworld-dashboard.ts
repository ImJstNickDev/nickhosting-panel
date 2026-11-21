import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import type { ApplicationServer, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { openworldDashboardStatus } from '../../../games/openworld/src/dashboard-api.js';
import { openworldStartup } from '../../../games/openworld/src/dashboard-launch.js';
import { privateBackendAddress } from './allocation-pool.js';
import { verifyManagedIdentity, withServerLock } from './lifecycle.js';
import { authorizeServer } from './registry.js';

type DB = Kysely<Database>;
type Adapter = Pick<PterodactylAdapter, 'getEgg' | 'getApplicationServer' | 'updateStartup'>;

async function dashboardTarget(
  db: DB,
  adapter: Adapter,
  who: AuthContext,
  id: string,
  manage = false,
  updatedRemote?: ApplicationServer,
) {
  const server = await authorizeServer(db, who, id, manage ? 'settings.write' : 'settings.read');
  const owner =
    who.sessionType === 'regular' &&
    (who.role === 'owner' || server.owner_id === who.subjectUserId);
  // The native dashboard has a single administrator role and retains its own sessions.
  // Its reusable credential can only be managed by the personal or platform owner.
  if (manage && !owner) throw new DomainError('forbidden');
  const mapping = await db
    .selectFrom('runtime_egg_mappings')
    .select(['game_id', 'runtime_id', 'nest_id', 'egg_id'])
    .where('id', '=', server.mapping_id)
    .executeTakeFirst();
  if (mapping?.game_id !== 'openworld' || mapping.runtime_id !== 'dedicated')
    throw new DomainError('not_found');
  if (!server.pterodactyl_id || server.installation_state !== 'installed')
    throw new DomainError('game_not_ready');
  if (manage && server.active_operation_id) throw new DomainError('operation_busy');
  const [allocation, remote] = await Promise.all([
    db
      .selectFrom('server_allocations')
      .select(['backend_address', 'port', 'direct_endpoint', 'private_only', 'protocols'])
      .where('server_id', '=', id)
      .where('role', '=', 'dashboard')
      .executeTakeFirst(),
    updatedRemote ?? adapter.getApplicationServer(server.pterodactyl_id),
  ]);
  await verifyManagedIdentity(db, server, remote);
  const environment = remote.container.environment;
  if (
    !allocation?.private_only ||
    allocation.direct_endpoint ||
    !privateBackendAddress(allocation.backend_address) ||
    !allocation.protocols.includes('tcp') ||
    remote.nest !== mapping.nest_id ||
    remote.egg !== mapping.egg_id ||
    remote.container.startup_command !== openworldStartup ||
    !environment ||
    Number(environment.OW_WEB_PORT) !== allocation.port
  )
    throw new DomainError('provenance_mismatch');
  const configured = environment.OW_WEB_PASSWORD ?? '';
  if (
    typeof configured !== 'string' ||
    (configured.length && !/^[A-Za-z0-9_-]{43}$/.test(configured))
  )
    throw new DomainError('configuration_invalid');
  const host =
    isIP(allocation.backend_address) === 6
      ? `[${allocation.backend_address}]`
      : allocation.backend_address;
  return {
    server,
    mapping,
    remote,
    environment,
    owner,
    password: configured,
    address: `http://${host}:${allocation.port}`,
  };
}

function publicState({ owner, password, address }: Awaited<ReturnType<typeof dashboardTarget>>) {
  return {
    enabled: Boolean(password),
    canConfigure: owner,
    privateAddress: owner && password ? address : null,
  };
}

export async function readOpenworldDashboard(
  db: DB,
  adapter: Adapter,
  who: AuthContext,
  id: string,
) {
  return publicState(await dashboardTarget(db, adapter, who, id));
}

export async function updateOpenworldDashboard(
  db: DB,
  adapter: Adapter,
  who: AuthContext,
  id: string,
  enabled: boolean,
) {
  // Reject malformed ids and unauthorized writers before taking the operation lock.
  await authorizeServer(db, who, id, 'settings.write');
  const result = await withServerLock(db, id, async (connection) => {
    const target = await dashboardTarget(connection, adapter, who, id, true);
    if (enabled === Boolean(target.password)) return publicState(target);
    const skipScripts = target.remote.container.skip_scripts;
    if (skipScripts === undefined) throw new DomainError('configuration_invalid');
    const egg = await adapter.getEgg(target.mapping.nest_id, target.mapping.egg_id);
    const variables = egg.relationships?.variables?.data.map((row) => row.attributes) ?? [];
    const secret = variables.find((item) => item.env_variable === 'OW_WEB_PASSWORD');
    if (
      egg.id !== target.mapping.egg_id ||
      egg.nest !== target.mapping.nest_id ||
      egg.startup !== openworldStartup ||
      !secret ||
      secret.user_viewable ||
      secret.user_editable
    )
      throw new DomainError('provenance_mismatch');
    const environment: Record<string, string | number | boolean> = {};
    for (const variable of variables) {
      const key = variable.env_variable;
      const value = target.environment[key] ?? variable.default_value;
      if (value !== null && value !== undefined) environment[key] = value;
    }
    const password = enabled ? randomBytes(32).toString('base64url') : '';
    environment.OW_WEB_PASSWORD = password;
    await recordAudit(connection, who, 'openworld.dashboard.requested', { serverId: id, enabled });
    const updated = await adapter.updateStartup(
      target.remote.id,
      {
        startup: openworldStartup,
        egg: target.remote.egg,
        image: target.remote.container.image,
        environment,
        skip_scripts: skipScripts,
      },
      true,
    );
    const observed = await dashboardTarget(connection, adapter, who, id, true, updated);
    if (observed.password !== password || observed.remote.container.skip_scripts !== skipScripts)
      throw new DomainError('operation_uncertain');
    return publicState(observed);
  });
  if (result === 'deferred') throw new DomainError('operation_busy');
  return result;
}

export async function revealOpenworldDashboardPassword(
  db: DB,
  adapter: Adapter,
  who: AuthContext,
  id: string,
) {
  const { password } = await dashboardTarget(db, adapter, who, id, true);
  if (!password) throw new DomainError('game_not_ready');
  await recordAudit(db, who, 'openworld.dashboard.password-accessed', { serverId: id });
  return { password };
}

export async function readOpenworldDashboardStatus(
  db: DB,
  adapter: Adapter,
  who: AuthContext,
  id: string,
  signal: AbortSignal,
) {
  const { password, address, server } = await dashboardTarget(db, adapter, who, id);
  if (!password || server.runtime_state !== 'running') throw new DomainError('game_not_ready');
  return openworldDashboardStatus(address, password, signal);
}
