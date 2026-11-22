import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type Database, recordAudit } from '@nickhosting/database';
import type { ApplicationServer, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely, Selectable } from 'kysely';
import { readOpenworldDashboardStatusWithToken } from '../../../games/openworld/src/dashboard-api.js';
import { openworldStartup } from '../../../games/openworld/src/dashboard-launch.js';
import { privateBackendAddress } from './allocation-pool.js';
import { type GameLifecycleContext, verifyManagedIdentity } from './lifecycle.js';
import { canAccessOpenworldDashboard } from './openworld-dashboard-access.js';
import { getOpenworldPublication, setOpenworldPublication } from './openworld-publication.js';
import {
  assertCurrentOpenworldScope,
  type OpenworldNativeConnection,
  readOpenworldScope,
} from './openworld-telemetry.js';
import { authorizeServer } from './registry.js';

type DB = Kysely<Database>;
type Server = Selectable<Database['managed_servers']>;
type Adapter = Pick<PterodactylAdapter, 'getApplicationServer'>;

async function privateTarget(
  db: DB,
  adapter: Adapter,
  server: Server,
  updatedRemote?: ApplicationServer,
) {
  if (!server.pterodactyl_id) throw new DomainError('game_not_ready');
  const [mapping, allocation, remote] = await Promise.all([
    db
      .selectFrom('runtime_egg_mappings')
      .select(['game_id', 'runtime_id', 'nest_id', 'egg_id'])
      .where('id', '=', server.mapping_id)
      .executeTakeFirst(),
    db
      .selectFrom('server_allocations')
      .select(['backend_address', 'port', 'direct_endpoint', 'private_only', 'protocols'])
      .where('server_id', '=', server.id)
      .where('role', '=', 'dashboard')
      .executeTakeFirst(),
    updatedRemote ?? adapter.getApplicationServer(server.pterodactyl_id),
  ]);
  if (mapping?.game_id !== 'openworld' || mapping.runtime_id !== 'dedicated')
    throw new DomainError('not_found');
  await verifyManagedIdentity(db, server, remote);
  const environment = remote.container.environment;
  if (
    !allocation?.private_only ||
    allocation.direct_endpoint ||
    !isIP(allocation.backend_address) ||
    !privateBackendAddress(allocation.backend_address) ||
    !allocation.protocols.includes('tcp') ||
    remote.nest !== mapping.nest_id ||
    remote.egg !== mapping.egg_id ||
    remote.container.startup_command !== openworldStartup ||
    !environment ||
    Number(environment.OW_WEB_PORT) !== allocation.port
  )
    throw new DomainError('provenance_mismatch');
  const password = environment.OW_WEB_PASSWORD ?? '';
  if (typeof password !== 'string' || (password && !/^[A-Za-z0-9_-]{43}$/.test(password)))
    throw new DomainError('configuration_invalid');
  const host =
    isIP(allocation.backend_address) === 6
      ? `[${allocation.backend_address}]`
      : allocation.backend_address;
  return { password, remote, environment, address: `http://${host}:${allocation.port}` };
}

/** Called from the locked lifecycle before the power handoff. Rotate every legacy
 * native credential once, including ones a former administrator may have revealed. */
export async function prepareOpenworldDashboardOnStart(context: GameLifecycleContext) {
  const { db, server, adapter } = context;
  const profile = await db
    .selectFrom('openworld_server_profiles')
    .select('dashboard_credential_prepared')
    .where('server_id', '=', server.id)
    .executeTakeFirstOrThrow();
  if (profile.dashboard_credential_prepared) return;
  const target = await privateTarget(db, adapter, server);
  const remote = target.remote;
  const egg = await adapter.getEgg(remote.nest, remote.egg);
  const variables = egg.relationships?.variables?.data.map((row) => row.attributes) ?? [];
  const secret = variables.find((item) => item.env_variable === 'OW_WEB_PASSWORD');
  if (
    egg.id !== remote.egg ||
    egg.nest !== remote.nest ||
    egg.startup !== openworldStartup ||
    !secret ||
    secret.user_viewable ||
    secret.user_editable ||
    remote.container.skip_scripts === undefined
  )
    throw new DomainError('provenance_mismatch');
  const environment: Record<string, string | number | boolean> = {};
  for (const variable of variables) {
    const key = variable.env_variable;
    const value = target.environment[key] ?? variable.default_value;
    if (value !== null && value !== undefined) environment[key] = value;
  }
  const password = randomBytes(32).toString('base64url');
  environment.OW_WEB_PASSWORD = password;
  await context.authorize();
  const updated = await adapter.updateStartup(
    remote.id,
    {
      startup: openworldStartup,
      egg: remote.egg,
      image: remote.container.image,
      environment,
      skip_scripts: remote.container.skip_scripts,
    },
    true,
  );
  const observed = await privateTarget(db, adapter, server, updated);
  if (
    observed.password !== password ||
    updated.container.skip_scripts !== remote.container.skip_scripts
  )
    throw new DomainError('operation_uncertain');
  await db
    .updateTable('openworld_server_profiles')
    .set({ dashboard_credential_prepared: true })
    .where('server_id', '=', server.id)
    .execute();
}

/** Private provider destination for trusted server-side calls. Callers authorize their viewer separately. */
export async function resolveOpenworldDashboardTarget(db: DB, adapter: Adapter, id: string) {
  const server = await db
    .selectFrom('managed_servers as server')
    .innerJoin('openworld_server_profiles as profile', 'profile.server_id', 'server.id')
    .selectAll('server')
    .select('profile.dashboard_credential_prepared')
    .where('server.id', '=', id)
    .where('server.deleted_at', 'is', null)
    .executeTakeFirst();
  if (
    server?.installation_state !== 'installed' ||
    server.runtime_state !== 'running' ||
    !server.dashboard_credential_prepared
  )
    throw new DomainError('game_not_ready');
  const { address, password } = await privateTarget(db, adapter, server);
  if (!password) throw new DomainError('game_not_ready');
  return { address, password };
}

async function dashboardViewer(db: DB, who: AuthContext, id: string) {
  const server = await authorizeServer(db, who, id, 'server:read');
  const profile = await db
    .selectFrom('openworld_server_profiles as profile')
    .innerJoin('runtime_egg_mappings as mapping', (join) =>
      join.on('mapping.id', '=', server.mapping_id),
    )
    .select('profile.dashboard_credential_prepared')
    .where('profile.server_id', '=', server.id)
    .where('mapping.game_id', '=', 'openworld')
    .where('mapping.runtime_id', '=', 'dedicated')
    .executeTakeFirst();
  if (!profile) throw new DomainError('not_found');
  const canOpen = await canAccessOpenworldDashboard(db, who, server);
  if (!canOpen) await authorizeServer(db, who, id, 'settings.read');
  const canConfigure =
    who.sessionType === 'regular' &&
    who.actorUserId === server.owner_id &&
    who.subjectUserId === server.owner_id;
  return { canOpen, canConfigure, nativePrepared: profile.dashboard_credential_prepared };
}

export async function readOpenworldDashboard(db: DB, who: AuthContext, id: string) {
  const viewer = await dashboardViewer(db, who, id);
  const publication = await getOpenworldPublication(db, id);
  return { ...publication, ...viewer };
}

export async function updateOpenworldDashboard(
  db: DB,
  who: AuthContext,
  id: string,
  enabled: boolean,
) {
  return db.transaction().execute(async (tx) => {
    const viewer = await dashboardViewer(tx, who, id);
    if (!viewer.canConfigure) throw new DomainError('forbidden');
    const publication = await setOpenworldPublication(tx, id, enabled);
    await recordAudit(tx, who, 'openworld.dashboard.publication', { serverId: id, enabled });
    return { ...publication, ...viewer };
  });
}

export async function readOpenworldDashboardStatus(
  db: DB,
  native: OpenworldNativeConnection,
  who: AuthContext,
  id: string,
  signal: AbortSignal,
) {
  await dashboardViewer(db, who, id);
  const scope = await readOpenworldScope(db, id);
  if (scope.reason) throw new DomainError('game_not_ready');
  const status = await native(scope, (origin, token, deadline) =>
    readOpenworldDashboardStatusWithToken(origin, token, AbortSignal.any([signal, deadline])),
  );
  await dashboardViewer(db, who, id);
  assertCurrentOpenworldScope(scope, await readOpenworldScope(db, id));
  return status;
}
