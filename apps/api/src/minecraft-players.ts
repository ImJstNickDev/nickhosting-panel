import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { type AuthContext, DomainError } from '@nickhosting/core';
import { type createDatabase, getSettings, recordAudit } from '@nickhosting/database';
import { createMinecraftIdentityProvider, verifyMinecraftPlayer } from '@nickhosting/minecraft';
import { type ConsoleRelay, PterodactylError } from '@nickhosting/pterodactyl-adapter';
import {
  inspectMinecraftCombination,
  type ManagementRuntime,
  parse,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import {
  minecraftPlayerActionSchema,
  minecraftPlayerCommand,
  parseMinecraftOnlinePlayers,
  parseMinecraftPlayerFiles,
} from '../../../games/minecraft/src/player-management.js';
import { minecraftStoredConfigurationSchema } from '../../../packages/server-management/src/minecraft-content-contracts.js';
import type { Variables } from './app.js';

type C = Context<{ Variables: Variables }>;
type Options = {
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
async function readFile(service: ManagementRuntime, identifier: string, path: string) {
  try {
    return Buffer.from(await service.adapter.readFile(identifier, path, 1048576)).toString('utf8');
  } catch (error) {
    // Only an explicit missing list is empty. Transport, permission and parse failures
    // must never erase an existing list; server.properties must always exist.
    if (
      path !== 'server.properties' &&
      error instanceof PterodactylError &&
      error.reason === 'not_found' &&
      error.upstreamStatus === 404
    )
      return '[]';
    throw error;
  }
}
async function readPlayerFiles(service: ManagementRuntime, identifier: string) {
  const paths = ['ops.json', 'whitelist.json', 'banned-players.json', 'server.properties'];
  const values = await Promise.all(paths.map(async (path) => readFile(service, identifier, path)));
  return parseMinecraftPlayerFiles({
    operators: values[0] ?? '',
    whitelist: values[1] ?? '',
    banned: values[2] ?? '',
    properties: values[3] ?? '',
  });
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
  options: Options,
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
      service = await management();
    const result = await service.access(
      context,
      c.req.param('id'),
      false,
      async (id, connection) => {
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
        return { supported: true, installed: true, ...(await readPlayerFiles(service, id)) };
      },
    );
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
  app.get('/v1/servers/:id/minecraft/players/online', async (c) => {
    const context = await principal(c),
      service = await management(),
      serverId = c.req.param('id');
    // Release the access connection before resolving provider credentials or opening
    // a relay. Those operations borrow their own pool connections.
    const { id, server, state } = await service.access(
      context,
      serverId,
      false,
      async (id, connection, _current, server) => ({
        id,
        server,
        state: await profile(connection, serverId),
      }),
    );
    let result: Online = unavailable();
    if (state.supported && state.value.installed) {
      const resources = await service.adapter.getResources(id);
      if (resources.current_state !== 'running') {
        result = { state: 'offline', players: [], observedAt: null };
      } else {
        const binding = await service.consoleBindingForServer(serverId);
        const key = JSON.stringify([
          serverId,
          id,
          server.pterodactyl_id,
          server.pterodactyl_uuid,
          server.external_id,
          server.updated_at,
          binding,
        ]);
        const cached = online.get(key);
        let pending = cached && cached.expires > Date.now() ? cached.result : undefined;
        if (!pending) {
          for (const [key, entry] of online) if (entry.expires <= Date.now()) online.delete(key);
          if (online.size >= 1000) throw new DomainError('resources_unavailable');
          pending = observeMinecraftPlayers(service, id, async () => {
            try {
              await service.authorizeTransfer(context, serverId, false, db, undefined, server);
              return (await service.consoleBindingForServer(serverId)) === binding;
            } catch {
              return false;
            }
          });
          online.set(key, { expires: Date.now() + 5000, result: pending });
        }
        result = await pending;
        if ((await service.consoleBindingForServer(serverId)) !== binding)
          throw new DomainError('conflict');
      }
    }
    await service.authorizeTransfer(context, serverId, false, db, undefined, server);
    c.header('Cache-Control', 'no-store');
    return c.json(result);
  });
  app.post('/v1/servers/:id/minecraft/players/actions', async (c) => {
    const context = await principal(c),
      service = await management(),
      serverId = c.req.param('id');
    const input = parse(minecraftPlayerActionSchema, await body(c));
    const identityProvider =
      'expectedUuid' in input && input.expectedUuid
        ? createMinecraftIdentityProvider({
            userAgent: (await getSettings(db, env)).values.contentMetadataUserAgent ?? '',
          })
        : undefined;
    await service.access(context, serverId, true, async (id, connection, current) => {
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
          const snapshot = await readPlayerFiles(service, id);
          const entries =
            input.action === 'deop'
              ? snapshot.operators
              : input.action === 'whitelist-remove'
                ? snapshot.whitelist
                : snapshot.banned;
          if (!entries.some((entry) => entry.uuid === input.expectedUuid))
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
            const snapshot = await readPlayerFiles(service, id);
            const contains = (list: { name: string; uuid: string }[]) =>
              'name' in input &&
              list.some((player) =>
                input.expectedUuid
                  ? player.uuid === input.expectedUuid
                  : player.name.toLowerCase() === input.name.toLowerCase(),
              );
            const matches =
              input.action === 'op'
                ? contains(snapshot.operators)
                : input.action === 'deop'
                  ? !contains(snapshot.operators)
                  : input.action === 'whitelist-add'
                    ? contains(snapshot.whitelist)
                    : input.action === 'whitelist-remove'
                      ? !contains(snapshot.whitelist)
                      : input.action === 'whitelist-on'
                        ? snapshot.whitelistEnabled
                        : input.action === 'whitelist-off'
                          ? !snapshot.whitelistEnabled
                          : input.action === 'ban'
                            ? contains(snapshot.banned)
                            : !contains(snapshot.banned);
            if (!matches) continue;
            const configuration = parse(
              minecraftStoredConfigurationSchema,
              state.value.configuration,
            );
            const observedAt = new Date().toISOString();
            // Preserve authoritative UUIDs, including externally configured accounts.
            // No per-player provider calls or invented Mojang identity attestations.
            const observed = <T extends { uuid: string; name: string }>(players: T[]) =>
              players.map((player) => ({
                ...player,
                source: 'server-file' as const,
                verifiedAt: observedAt,
              }));
            configuration.operators = snapshot.operators.map((player) => player.name);
            configuration.whitelist = snapshot.whitelist.map((player) => player.name);
            configuration.playerIdentities = {
              operators: observed(snapshot.operators),
              whitelist: observed(snapshot.whitelist),
            };
            configuration.properties['white-list'] = snapshot.whitelistEnabled;
            // Older versions do not have enforce-whitelist; do not invent that property.
            if ('enforce-whitelist' in configuration.properties)
              configuration.properties['enforce-whitelist'] = snapshot.enforceWhitelist;
            await connection
              .updateTable('minecraft_server_profiles')
              .set({ configuration: JSON.stringify(configuration), updated_at: new Date() })
              .where('server_id', '=', serverId)
              .execute();
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
}
