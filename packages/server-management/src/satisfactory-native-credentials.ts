import { createHash, timingSafeEqual } from 'node:crypto';
import type { Database } from '@nickhosting/database';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { type Kysely, sql } from 'kysely';
import {
  decodeSatisfactoryNativeCredentials,
  type NativeSatisfactoryCredentials,
} from '../../../games/satisfactory/src/native-credentials.js';
import { verifyManagedIdentity } from './lifecycle.js';

type Adapter = Pick<PterodactylAdapter, 'getApplicationServer' | 'listFiles' | 'readFile'> &
  Partial<Pick<PterodactylAdapter, 'listDirectoriesBatch'>>;
export interface StoppedSatisfactoryCredentials {
  credentials: NativeSatisfactoryCredentials;
  /** Integrity metadata for this read, never an authentication attestation. */
  digest: string;
  generation: string;
  providerUuid: string;
  port: number;
}
export interface StoppedSatisfactoryCredentialOptions {
  adapter: Adapter;
  /** Must independently prove provider and host process/container are stopped. */
  confirmStopped: (serverId: string, db: Kysely<Database>) => Promise<boolean>;
}
const MAX_SETTINGS = 256 * 1024;
const BUILD_PATH = 'Engine/Binaries/Linux/FactoryServer-Linux-Shipping.version';

async function state(db: Kysely<Database>, id: string) {
  const server = await db
    .selectFrom('managed_servers as server')
    .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
    .innerJoin('gateway_server_states as gateway', 'gateway.server_id', 'server.id')
    .selectAll('server')
    .select([
      'mapping.game_id',
      'gateway.generation',
      'gateway.state as gatewayState',
      'gateway.enabled as gatewayEnabled',
    ])
    .where('server.id', '=', id)
    .executeTakeFirst();
  if (
    server?.game_id !== 'satisfactory' ||
    server.deleted_at ||
    server.installation_state !== 'installed' ||
    server.active_operation_id ||
    server.runtime_state !== 'offline' ||
    server.connection_mode !== 'gateway' ||
    !server.gatewayEnabled ||
    server.gatewayState !== 'sleeping' ||
    !['sleeping', 'auto_wake_enabled'].includes(server.intent) ||
    server.automatic_starts_paused ||
    !server.pterodactyl_id ||
    !server.pterodactyl_identifier ||
    !server.pterodactyl_uuid
  )
    return undefined;
  const job = await db
    .selectFrom('operation_jobs')
    .select('id')
    .where('subject_id', '=', id)
    .where('state', 'in', ['queued', 'running'])
    .executeTakeFirst();
  if (job) return undefined;
  const allocations = await db
    .selectFrom('server_allocations')
    .selectAll()
    .where('server_id', '=', id)
    .where('role', '=', 'game')
    .execute();
  const allocation = allocations[0];
  if (
    allocations.length !== 1 ||
    !allocation ||
    allocation.node_id !== server.node_id ||
    !Number.isInteger(allocation.port) ||
    allocation.port < 1 ||
    allocation.port > 65535 ||
    !allocation.protocols.includes('udp') ||
    !allocation.protocols.includes('tcp')
  )
    return undefined;
  return { server, allocation };
}

async function fileMetadata(adapter: Adapter, identifier: string, path: string, max: number) {
  const parts = path.split('/');
  const directories = parts.map((_, index) => parts.slice(0, index).join('/'));
  const batch = adapter.listDirectoriesBatch
    ? await adapter.listDirectoriesBatch(identifier, directories)
    : undefined;
  if (
    batch &&
    (batch.length !== directories.length ||
      batch.some((result, index) => result.directory !== directories[index] || 'error' in result))
  )
    throw new Error('Unavailable');
  const evidence: Array<{ name: string; size: number; modified_at: string; created_at: string }> =
    [];
  for (let index = 0; index < parts.length; index++) {
    const result = batch?.[index];
    const entries = batch
      ? result && 'files' in result
        ? result.files
        : undefined
      : await adapter.listFiles(identifier, directories[index]);
    if (!entries) throw new Error('Unavailable');
    if (entries.length > 10000) throw new Error('Unavailable');
    const matches = entries.filter((entry) => entry.name === parts[index]);
    const entry = matches[0];
    const isFile = index === parts.length - 1;
    if (
      matches.length !== 1 ||
      !entry ||
      entry.is_symlink ||
      entry.is_file !== isFile ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      (isFile && (entry.size === 0 || entry.size > max))
    ) {
      throw new Error('Unavailable');
    }
    evidence.push({
      name: entry.name,
      size: entry.size,
      modified_at: entry.modified_at,
      created_at: entry.created_at,
    });
  }
  return { proof: JSON.stringify(evidence), size: evidence.at(-1)?.size };
}

async function readStableFile(adapter: Adapter, identifier: string, path: string, max: number) {
  const before = await fileMetadata(adapter, identifier, path, max);
  const first = Buffer.from(await adapter.readFile(identifier, path, max));
  const middle = await fileMetadata(adapter, identifier, path, max);
  const second = Buffer.from(await adapter.readFile(identifier, path, max));
  const after = await fileMetadata(adapter, identifier, path, max);
  if (
    before.proof !== middle.proof ||
    middle.proof !== after.proof ||
    first.length !== before.size ||
    first.length === 0 ||
    first.length > max ||
    first.length !== second.length ||
    !timingSafeEqual(first, second)
  )
    throw new Error('Unavailable');
  return second;
}

const pendingFiles = new WeakMap<Adapter, Map<string, Promise<Buffer>>>();
async function stableFile(adapter: Adapter, identifier: string, path: string, max: number) {
  let pending = pendingFiles.get(adapter);
  if (!pending) {
    pending = new Map();
    pendingFiles.set(adapter, pending);
  }
  const key = JSON.stringify([identifier, path, max]);
  let read = pending.get(key);
  if (!read) {
    if (pending.size >= 1024) throw new Error('Unavailable');
    read = readStableFile(adapter, identifier, path, max);
    pending.set(key, read);
  }
  try {
    // Each caller retains its independent DB/identity/stopped checks and lock.
    return Buffer.from(await read);
  } finally {
    if (pending.get(key) === read) pending.delete(key);
  }
}

function authority(value: NonNullable<Awaited<ReturnType<typeof state>>>): string {
  const server = value.server;
  return JSON.stringify({
    id: server.id,
    ownerId: server.owner_id,
    projectId: server.project_id,
    providerUserId: server.provider_user_id,
    mappingId: server.mapping_id,
    nodeId: server.node_id,
    externalId: server.external_id,
    providerId: server.pterodactyl_id,
    providerUuid: server.pterodactyl_uuid,
    providerIdentifier: server.pterodactyl_identifier,
    generation: server.generation,
    allocation: value.allocation,
  });
}

interface PendingRead {
  db: Kysely<Database>;
  serverId: string;
  adapter: Adapter;
  confirmStopped: StoppedSatisfactoryCredentialOptions['confirmStopped'];
  result: Promise<StoppedSatisfactoryCredentials | undefined>;
}
const pendingReads = new Set<PendingRead>();

/** Bound anonymous authentication work before acquiring a database connection.
 * Only identical, overlapping authority reads share work. Each response receives
 * a separate object and the API still performs its own final route fence.
 */
export async function readStoppedSatisfactoryCredentials(
  db: Kysely<Database>,
  serverId: string,
  options: StoppedSatisfactoryCredentialOptions,
): Promise<StoppedSatisfactoryCredentials | undefined> {
  const existing = [...pendingReads].find(
    (entry) =>
      entry.db === db &&
      entry.serverId === serverId &&
      entry.adapter === options.adapter &&
      entry.confirmStopped === options.confirmStopped,
  );
  if (existing) {
    const result = await existing.result;
    return result ? structuredClone(result) : undefined;
  }
  if (pendingReads.size >= 2) return undefined;
  const pending: PendingRead = {
    db,
    serverId,
    adapter: options.adapter,
    confirmStopped: options.confirmStopped,
    result: Promise.resolve(undefined),
  };
  pendingReads.add(pending);
  try {
    pending.result = readCredentials(db, serverId, options);
    const result = await pending.result;
    return result ? structuredClone(result) : undefined;
  } finally {
    pendingReads.delete(pending);
  }
}

/** Internal-only credential read. No settled cache, plaintext error details, or writes.
 * The shared session lock excludes lifecycle mutations for the entire bounded read.
 */
async function readCredentials(
  db: Kysely<Database>,
  serverId: string,
  options: StoppedSatisfactoryCredentialOptions,
): Promise<StoppedSatisfactoryCredentials | undefined> {
  try {
    return await db.connection().execute(async (connection) => {
      const key = `:nickhosting:server:${serverId}`;
      const locked = await sql<{
        acquired: boolean;
      }>`select pg_try_advisory_lock_shared(hashtextextended(current_schema() || ${key},0)) as acquired`.execute(
        connection,
      );
      if (!locked.rows[0]?.acquired) return undefined;
      try {
        const initial = await state(connection, serverId);
        if (!initial) return undefined;
        const server = initial.server;
        const providerId = server.pterodactyl_id as number;
        const identifier = server.pterodactyl_identifier as string;
        await verifyManagedIdentity(
          connection,
          server,
          await options.adapter.getApplicationServer(providerId),
        );
        if (!(await options.confirmStopped(serverId, connection))) return undefined;
        const buildBytes = await stableFile(options.adapter, identifier, BUILD_PATH, 16384);
        const version: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(buildBytes),
        );
        if (
          !version ||
          typeof version !== 'object' ||
          !('Changelist' in version) ||
          version.Changelist !== 513885
        )
          return undefined;
        const path = `.config/Epic/FactoryGame/Saved/SaveGames/ServerSettings.${initial.allocation.port}.sav`;
        const bytes = await stableFile(options.adapter, identifier, path, MAX_SETTINGS);
        const credentials = decodeSatisfactoryNativeCredentials(bytes);
        if (!credentials || credentials.build !== version.Changelist) return undefined;
        const current = await state(connection, serverId);
        if (!current || authority(initial) !== authority(current)) return undefined;
        await verifyManagedIdentity(
          connection,
          current.server,
          await options.adapter.getApplicationServer(providerId),
        );
        if (!(await options.confirmStopped(serverId, connection))) return undefined;
        return {
          credentials,
          digest: createHash('sha256').update(bytes).digest('hex'),
          generation: server.generation,
          providerUuid: server.pterodactyl_uuid as string,
          port: initial.allocation.port,
        };
      } finally {
        await sql`select pg_advisory_unlock_shared(hashtextextended(current_schema() || ${key},0))`.execute(
          connection,
        );
      }
    });
  } catch {
    return undefined;
  }
}
