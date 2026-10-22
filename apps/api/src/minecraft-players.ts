import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type createDatabase, getSettings, recordAudit } from '@nickhosting/database';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import {
  createMinecraftIdentityProvider,
  minecraftPlayerPermission,
  verifyMinecraftPlayer,
} from '@nickhosting/minecraft';
import type { ConsoleRelay } from '@nickhosting/pterodactyl-adapter';
import {
  createFilemanReadService,
  inspectMinecraftCombination,
  type ManagementRuntime,
  parse,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { sql } from 'kysely';
import {
  type MinecraftPlayerAction,
  minecraftPlayerActionSchema,
  minecraftPlayerCommand,
  parseMinecraftBannedPlayers,
  parseMinecraftOnlinePlayers,
  parseMinecraftOperators,
  parseMinecraftPlayerFiles,
  parseMinecraftWhitelist,
  parseMinecraftWhitelistProperties,
} from '../../../games/minecraft/src/player-management.js';
import { minecraftStoredConfigurationSchema } from '../../../packages/server-management/src/minecraft-content-contracts.js';
import { discoverMinecraftPlayers } from '../../../packages/server-management/src/minecraft-player-details.js';
import { permissionRuntime } from '../../../packages/server-management/src/permission-runtime.js';
import type { Variables } from './app.js';
import { registerMinecraftPlayerDetailRoutes } from './minecraft-player-details.js';

type C = Context<{ Variables: Variables }>;
export type MinecraftPlayerRouteOptions = {
  db: ReturnType<typeof createDatabase>['db'];
  env: Readonly<Record<string, string | undefined>>;
  principal: (c: C, regularOnly?: boolean) => Promise<AuthContext>;
  body: (c: Context) => Promise<unknown>;
  management: () => Promise<ManagementRuntime>;
};
type Online = {
  state: 'available' | 'unavailable' | 'offline';
  players: { name: string }[];
  observedAt: string | null;
};
const unavailable = (): Online => ({ state: 'unavailable', players: [], observedAt: null });
async function readPlayerFiles(files: FilemanReadService) {
  const paths = ['ops.json', 'whitelist.json', 'banned-players.json', 'server.properties'];
  const values = await files.readMany(
    paths.map((path) => ({
      path,
      maxBytes: 1048576,
      ...(path !== 'server.properties' ? { missing: 'allow' as const } : {}),
    })),
  );
  const text = (path: string) => {
    const bytes = values.get(path);
    return bytes === undefined ? '[]' : Buffer.from(bytes).toString('utf8');
  };
  return parseMinecraftPlayerFiles({
    operators: text('ops.json'),
    whitelist: text('whitelist.json'),
    banned: text('banned-players.json'),
    properties: text('server.properties'),
  });
}
/** Each confirmation opens a fresh read scope: a previous observation never
 * confirms a later command, and unrelated lists are not fetched or reconciled. */
async function readActionFile(
  service: ManagementRuntime,
  identifier: string,
  action: MinecraftPlayerAction['action'],
) {
  const files = createFilemanReadService({
    adapter: service.adapter,
    identifier,
    authorize: async () => {},
  });
  const path =
    action === 'op' || action === 'deop'
      ? 'ops.json'
      : action === 'whitelist-add' || action === 'whitelist-remove'
        ? 'whitelist.json'
        : action === 'ban' || action === 'pardon'
          ? 'banned-players.json'
          : 'server.properties';
  const bytes = await files.read({
    path,
    maxBytes: 1048576,
    ...(path !== 'server.properties' ? { missing: 'allow' as const } : {}),
  });
  const source = bytes === undefined ? '[]' : Buffer.from(bytes).toString('utf8');
  if (path === 'ops.json')
    return { kind: 'operators' as const, players: parseMinecraftOperators(source) };
  if (path === 'whitelist.json')
    return { kind: 'whitelist' as const, players: parseMinecraftWhitelist(source) };
  if (path === 'banned-players.json')
    return { kind: 'banned' as const, players: parseMinecraftBannedPlayers(source) };
  return { kind: 'properties' as const, ...parseMinecraftWhitelistProperties(source) };
}
/** A fresh relay receives only new output: requestLogs is deliberately never called. */
export async function observeMinecraftPlayers(
  service: Pick<ManagementRuntime, 'adapter'>,
  identifier: string,
  authorize: () => Promise<boolean>,
): Promise<Online> {
  let relay: ConsoleRelay | undefined;
  let accepting = false;
  let done = false;
  let bytes = 0;
  let complete!: (value: Online) => void;
  const result = new Promise<Online>((resolve) => {
    complete = (value) => {
      if (!done) {
        done = true;
        resolve(value);
      }
    };
  });
  const abort = new AbortController();
  const timer = setTimeout(() => {
    complete(unavailable());
    abort.abort();
  }, 4500);
  try {
    relay = await service.adapter.relayConsole(identifier, {
      authorize,
      authorizeCommand: authorize,
      canSendCommands: true,
      signal: abort.signal,
      maxDurationMs: 5000,
      onEvent(event) {
        if (event.type === 'error' || event.type === 'closed') complete(unavailable());
        if (event.type === 'status' && event.data !== 'running') complete(unavailable());
        if (!accepting || done || event.type !== 'console') return;
        bytes += Buffer.byteLength(event.data);
        if (bytes > 65536) {
          complete(unavailable());
          return;
        }
        const players = parseMinecraftOnlinePlayers(event.data);
        if (players)
          complete({ state: 'available', players, observedAt: new Date().toISOString() });
      },
    });
    if (!done) {
      accepting = true;
      await relay.sendCommand('list');
    }
    return await result;
  } catch {
    return unavailable();
  } finally {
    clearTimeout(timer);
    abort.abort();
    relay?.close();
  }
}
export function registerMinecraftPlayerRoutes(
  app: Hono<{ Variables: Variables }>,
  options: MinecraftPlayerRouteOptions,
) {
  const { db, env, principal, body, management } = options;
  const online = new Map<string, { expires: number; result: Promise<Online> }>();
  async function profile(connection: typeof db, serverId: string) {
    const value = await connection
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!value) throw new DomainError('not_found');
    const choice = await inspectMinecraftCombination(connection, value.combination_id, env);
    return { value, supported: choice.capabilities.playerManagement };
  }
  app.get('/v1/servers/:id/minecraft/players', async (c) => {
    const context = await principal(c),
      service = permissionRuntime(await management(), 'game.minecraft.players');
    const result = await service.fileReadScope(
      context,
      c.req.param('id'),
      async (files, _id, connection, current) => {
        const state = await profile(connection, c.req.param('id'));
        if (!state.supported || !state.value.installed)
          return {
            supported: state.supported,
            installed: state.value.installed,
            operators: [],
            whitelist: [],
            banned: [],
            whitelistEnabled: false,
            enforceWhitelist: false,
          };
        void service
          .prepareFileWrites(current, c.req.param('id'), [
            'ops.json',
            'whitelist.json',
            'server.properties',
          ])
          .catch(() => {});
        const known = await discoverMinecraftPlayers(files)
          .then((result) => ({
            knownPlayers: result.knownPlayers,
            knownPlayersState: 'available' as const,
          }))
          .catch(() => ({ knownPlayers: [], knownPlayersState: 'unavailable' as const }));
        return {
          supported: true,
          installed: true,
          ...known,
          ...(await readPlayerFiles(files)),
        };
      },
      c.req.raw.signal,
    );
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
  app.get('/v1/servers/:id/minecraft/players/online', async (c) => {
    const context = await principal(c),
      service = permissionRuntime(await management(), 'game.minecraft.players'),
      serverId = c.req.param('id');
    // Release the access connection before resolving provider credentials or opening
    // a relay. Those operations borrow their own pool connections.
    const { id, server, state } = await service.fileReadAccess(
      context,
      serverId,
      async (id, connection, _current, server) => ({
        id,
        server,
        state: await profile(connection, serverId),
      }),
    );
    let result: Online = unavailable();
    if (state.supported && state.value.installed) {
      const binding = await service.consoleBindingForServer(serverId);
      const key = JSON.stringify([
        serverId,
        id,
        server.pterodactyl_id,
        server.pterodactyl_uuid,
        server.external_id,
        server.runtime_state,
        server.active_operation_id,
        binding,
      ]);
      const cached = online.get(key);
      let pending = cached && cached.expires > Date.now() ? cached.result : undefined;
      if (!pending) {
        for (const [key, entry] of online) if (entry.expires <= Date.now()) online.delete(key);
        if (online.size >= 1000) throw new DomainError('resources_unavailable');
        pending = (async () => {
          const resources = await service.adapter.getResources(id);
          if (resources.current_state !== 'running')
            return { state: 'offline' as const, players: [], observedAt: null };
          return observeMinecraftPlayers(service, id, async () => {
            try {
              await service.authorizeTransfer(context, serverId, false, db, undefined, server);
              return (await service.consoleBindingForServer(serverId)) === binding;
            } catch {
              return false;
            }
          });
        })();
        online.set(key, { expires: Date.now() + 5000, result: pending });
      }
      result = await pending;
      if ((await service.consoleBindingForServer(serverId)) !== binding)
        throw new DomainError('conflict');
    }
    await service.authorizeTransfer(context, serverId, false, db, undefined, server);
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
  app.post('/v1/servers/:id/minecraft/players/actions', async (c) => {
    const context = await principal(c),
      serverId = c.req.param('id');
    const input = parse(minecraftPlayerActionSchema, await body(c));
    const service = permissionRuntime(
      await management(),
      'game.minecraft.players',
      minecraftPlayerPermission(input.action).split('.').at(-1),
    );
    const identityProvider =
      'expectedUuid' in input && input.expectedUuid
        ? createMinecraftIdentityProvider({
            userAgent: (await getSettings(db, env)).values.contentMetadataUserAgent ?? '',
          })
        : undefined;
    await service.fileMutationAccess(context, serverId, async (id, connection, current) => {
      const state = await profile(connection, serverId);
      if (!state.supported || !state.value.installed) throw new DomainError('conflict');
      if ((await service.adapter.getResources(id)).current_state !== 'running')
        throw new DomainError('conflict');
      if ('expectedUuid' in input && input.expectedUuid && identityProvider) {
        if (
          input.action === 'deop' ||
          input.action === 'whitelist-remove' ||
          input.action === 'pardon'
        ) {
          const snapshot = await readActionFile(service, id, input.action);
          if (
            snapshot.kind === 'properties' ||
            !snapshot.players.some((entry) => entry.uuid === input.expectedUuid)
          )
            throw new DomainError('conflict');
        }
        // Vanilla live commands accept a name, so independently prove that it still
        // resolves to the selected UUID before allowing a privilege-changing command.
        const identity = await verifyMinecraftPlayer(input.name, identityProvider);
        if (identity.uuid !== input.expectedUuid) throw new DomainError('conflict');
      }
      const metadata = {
        serverId,
        operationId: randomUUID(),
        source: 'panel',
        command: minecraftPlayerCommand(input),
        playerAction: input.action,
      };
      await recordAudit(connection, current, 'server.console.command', {
        ...metadata,
        outcome: 'requested',
      });
      let dispatched = false;
      try {
        await service.authorizeTransfer(context, serverId, true, connection);
        dispatched = true;
        await service.adapter.sendCommand(id, minecraftPlayerCommand(input));
        await recordAudit(connection, current, 'server.console.dispatched', {
          ...metadata,
          outcome: 'dispatched',
        });
        if (input.action !== 'kick') {
          let confirmed = false;
          for (let attempt = 0; attempt < 4; attempt++) {
            if (attempt) await delay(250 * attempt);
            const snapshot = await readActionFile(service, id, input.action);
            const contains =
              snapshot.kind !== 'properties' &&
              'name' in input &&
              snapshot.players.some((player) =>
                input.expectedUuid
                  ? player.uuid === input.expectedUuid
                  : player.name.toLowerCase() === input.name.toLowerCase(),
              );
            const matches =
              snapshot.kind === 'properties'
                ? snapshot.whitelistEnabled === (input.action === 'whitelist-on')
                : ['deop', 'whitelist-remove', 'pardon'].includes(input.action)
                  ? !contains
                  : contains;
            if (!matches) continue;
            // Merge only the confirmed list/property into the latest stored object.
            // A command touching one list must not overwrite unrelated settings.
            if (snapshot.kind === 'operators' || snapshot.kind === 'whitelist') {
              const configuration = parse(
                minecraftStoredConfigurationSchema,
                state.value.configuration,
              );
              const observedAt = new Date().toISOString();
              const observe = <T extends { name: string; uuid: string }>(players: T[]) =>
                players.map((player) => ({
                  ...player,
                  source: 'server-file' as const,
                  verifiedAt: observedAt,
                }));
              const namePatch: Record<string, string[]> = {
                [snapshot.kind]: snapshot.players.map((player) => player.name),
              };
              const identityPatch: Record<string, unknown> = {
                [snapshot.kind]: observe(snapshot.players),
              };
              if (!configuration.playerIdentities) {
                const sibling = snapshot.kind === 'operators' ? 'whitelist' : 'operators';
                // Legacy profiles have no UUID authority at all. The actual sibling
                // file can contain externally added accounts even when stored names
                // are empty. Initialize it once without inventing or losing UUIDs.
                const other = await readActionFile(
                  service,
                  id,
                  sibling === 'operators' ? 'op' : 'whitelist-add',
                );
                if (other.kind !== sibling) throw new DomainError('integration_unavailable');
                namePatch[sibling] = other.players.map((player) => player.name);
                identityPatch[sibling] = observe(other.players);
              }
              await service.authorizeTransfer(current, serverId, true, connection);
              const names = JSON.stringify(namePatch);
              const observed = JSON.stringify(identityPatch);
              await connection
                .updateTable('minecraft_server_profiles')
                .set({
                  configuration: sql`configuration || ${names}::jsonb || jsonb_build_object('playerIdentities', coalesce(configuration->'playerIdentities', '{}'::jsonb) || ${observed}::jsonb)`,
                  updated_at: new Date(),
                })
                .where('server_id', '=', serverId)
                .execute();
            } else if (snapshot.kind === 'properties') {
              await service.authorizeTransfer(current, serverId, true, connection);
              const properties = JSON.stringify({ 'white-list': snapshot.whitelistEnabled });
              await connection
                .updateTable('minecraft_server_profiles')
                .set({
                  configuration: sql`jsonb_set(configuration, '{properties}', coalesce(configuration->'properties', '{}'::jsonb) || ${properties}::jsonb)`,
                  updated_at: new Date(),
                })
                .where('server_id', '=', serverId)
                .execute();
            }
            if (snapshot.kind === 'banned')
              await service.authorizeTransfer(current, serverId, true, connection);
            await recordAudit(connection, current, 'server.minecraft.players.reconciled', {
              ...metadata,
              outcome: 'confirmed',
            });
            confirmed = true;
            break;
          }
          if (!confirmed) throw new DomainError('operation_uncertain');
        }
      } catch (error) {
        try {
          await recordAudit(connection, current, 'server.console.failed', {
            ...metadata,
            outcome: dispatched ? 'uncertain' : 'failed',
          });
        } catch {
          // Keep the primary operation outcome when the audit store is unavailable.
        }
        // A possible send remains uncertain even when both audit writes fail.
        if (dispatched) throw new DomainError('operation_uncertain');
        throw error;
      } finally {
        for (const key of online.keys()) if (JSON.parse(key)[0] === serverId) online.delete(key);
      }
    });
    return c.json({ outcome: 'dispatched' as const }, 202);
  });
  registerMinecraftPlayerDetailRoutes(app, options);
}
