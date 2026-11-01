import { createHash, randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import { DomainError } from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import {
  getServerPermissionKeys,
  inspectMinecraftCombination,
  parse,
} from '@nickhosting/server-management';
import type { Hono } from 'hono';
import { minecraftUuid } from '../../../games/minecraft/src/management.js';
import {
  type MinecraftPlayerDetail,
  type MinecraftPlayerDetailAction,
  minecraftPlayerDetailActionNames,
  minecraftPlayerDetailActionSchema,
} from '../../../games/minecraft/src/player-details-contracts.js';
import { readMinecraftPlayerDetail } from '../../../packages/server-management/src/minecraft-player-details.js';
import { permissionRuntime } from '../../../packages/server-management/src/permission-runtime.js';
import type { Variables } from './app.js';
import { type MinecraftPlayerRouteOptions, observeMinecraftPlayers } from './minecraft-players.js';

/** UUID literals are validated entity arguments; no selector or command fragment is accepted. */
function coordinate(value: number): string {
  const source = String(value);
  if (!/[eE]/.test(source)) return source;
  const sign = value < 0 ? '-' : '';
  const [mantissa = '', exponent = '0'] = source.replace(/^-/, '').split(/[eE]/);
  const digits = mantissa.replace('.', '');
  const point = (mantissa.split('.')[0]?.length ?? 0) + Number(exponent);
  return point <= 0
    ? `${sign}0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length
      ? `${sign}${digits}${'0'.repeat(point - digits.length)}`
      : `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}
export function minecraftDetailCommand(
  uuid: string,
  input: Exclude<MinecraftPlayerDetailAction, { action: 'reset' }>,
) {
  const target = minecraftUuid(uuid);
  const value = minecraftPlayerDetailActionSchema.parse(input);
  switch (value.action) {
    case 'heal':
      return `effect give ${target} minecraft:instant_health 1 10 true`;
    case 'feed':
      return `effect give ${target} minecraft:saturation 1 10 true`;
    case 'starve':
      return `effect give ${target} minecraft:hunger 30 255 true`;
    case 'kill':
      return `kill ${target}`;
    case 'gamemode':
      return `gamemode ${value.mode} ${target}`;
    case 'teleport':
      return `execute as ${target} at @s run teleport @s ${coordinate(value.x)} ${coordinate(value.y)} ${coordinate(value.z)}`;
    default:
      throw new DomainError('validation_failed');
  }
}
export function minecraftDetailCommandsSupported(release: string) {
  const parts = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(release);
  return (
    !!parts &&
    ((Number(parts[1]) === 26 && Number(parts[2]) >= 1 && Number(parts[2]) <= 3) ||
      (Number(parts[1]) === 1 && Number(parts[2]) >= 16 && Number(parts[2]) <= 21))
  );
}

export function registerMinecraftPlayerDetailRoutes(
  app: Hono<{ Variables: Variables }>,
  options: MinecraftPlayerRouteOptions,
) {
  const { db, env, principal, management, body } = options;
  const profile = async (connection: typeof db, serverId: string) => {
    const row = await connection
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirst();
    if (!row?.installed) throw new DomainError('conflict');
    const choice = await inspectMinecraftCombination(connection, row.combination_id, env);
    if (!choice.capabilities.playerManagement) throw new DomainError('integration_unavailable');
    return choice;
  };
  app.get('/v1/servers/:id/minecraft/players/:uuid', async (c) => {
    const context = await principal(c),
      serverId = c.req.param('id'),
      uuid = minecraftUuid(c.req.param('uuid'));
    const service = permissionRuntime(await management(), 'game.minecraft.players');
    const result = await service.fileReadScope(
      context,
      serverId,
      async (files, identifier, connection, current, server) => ({
        ...(await readMinecraftPlayerDetail(files, uuid)),
        identifier,
        server,
        choice: await profile(connection, serverId),
        permissions: await getServerPermissionKeys(connection, current, server),
      }),
      c.req.raw.signal,
    );
    const state = (await service.adapter.getResources(result.identifier)).current_state;
    const authorize = async () => {
      try {
        await service.authorizeTransfer(context, serverId, false, db, undefined, result.server);
        return true;
      } catch {
        return false;
      }
    };
    const presence =
      state === 'running'
        ? await observeMinecraftPlayers(service, result.identifier, authorize)
        : null;
    const currentName = result.discovered.usercache.get(uuid);
    result.detail.online =
      state === 'offline'
        ? 'offline'
        : presence?.state === 'available' && currentName
          ? presence.players.some(
              (player) => player.name.toLowerCase() === currentName.toLowerCase(),
            )
            ? 'online'
            : 'offline'
          : 'unknown';
    result.detail.capabilities = minecraftPlayerDetailActionNames.map((action) => {
      let reason: MinecraftPlayerDetail['capabilities'][number]['reason'] = null;
      if (!result.permissions.includes(`game.minecraft.players.${action}`)) reason = 'permission';
      else if (action === 'reset') {
        if (state !== 'offline') reason = state === 'running' ? 'online' : 'presence_unknown';
        else if (result.detail.layout === 'mixed') reason = 'ambiguous_layout';
        else if (!result.refs.length) reason = 'missing';
      } else if (!minecraftDetailCommandsSupported(result.choice.combination.release))
        reason = 'unsupported_version';
      else if (!currentName) reason = 'identity_unknown';
      else if (result.detail.online !== 'online')
        reason = result.detail.online === 'offline' ? 'offline' : 'presence_unknown';
      return { action, available: reason === null, reason };
    });
    await service.authorizeTransfer(context, serverId, false, db, undefined, result.server);
    c.header('Cache-Control', 'no-store');
    return c.json(result.detail);
  });
  app.post('/v1/servers/:id/minecraft/players/:uuid/actions', async (c) => {
    const context = await principal(c),
      serverId = c.req.param('id'),
      uuid = minecraftUuid(c.req.param('uuid'));
    const input = parse(minecraftPlayerDetailActionSchema, await body(c));
    const service = permissionRuntime(await management(), 'game.minecraft.players', input.action);
    const operationId = randomUUID();
    const result = await service.fileMutationAccess(
      context,
      serverId,
      async (identifier, connection, current, server) => {
        const choice = await profile(connection, serverId);
        const authorize = () =>
          service.authorizeTransfer(current, serverId, true, connection, undefined, server);
        const files = service.fileReadPhase(identifier, server, c.req.raw.signal);
        const snapshot = await readMinecraftPlayerDetail(files, uuid);
        if (input.action === 'reset') {
          if (
            snapshot.detail.snapshot.revision !== input.revision ||
            snapshot.detail.layout === 'mixed'
          )
            throw new DomainError('conflict');
          const refs = snapshot.refs.filter((ref) => input.scopes.includes(ref.scope));
          if (!refs.length) throw new DomainError('conflict');
          const moves = refs.map((ref) => {
            const content = snapshot.bytes.get(ref.path);
            if (!content) throw new DomainError('conflict');
            return {
              from: ref.path,
              to: `${ref.path}.nickhosting-reset-${operationId}`,
              sha256: createHash('sha256').update(content).digest('hex'),
            };
          });
          const metadata = {
            serverId,
            playerUuid: uuid,
            operationId,
            scopes: input.scopes,
            revision: input.revision,
            moves,
            entries: moves.map((move) => ({ path: move.from, target: move.to })),
          };
          if ((await service.adapter.getResources(identifier)).current_state !== 'offline')
            throw new DomainError('conflict');
          await authorize();
          await recordAudit(connection, current, 'server.minecraft.player.reset', {
            ...metadata,
            outcome: 'requested',
          });
          let dispatched = false;
          try {
            for (const move of moves) {
              const fresh = service.fileReadPhase(identifier, server, c.req.raw.signal);
              const bytes = await fresh.read({ path: move.from, maxBytes: 4 * 1024 ** 2 });
              if (!bytes || createHash('sha256').update(bytes).digest('hex') !== move.sha256)
                throw new DomainError('conflict');
              const entries = await fresh.list(posix.dirname(move.from));
              if (
                entries.find((entry) => entry.name === posix.basename(move.from))?.kind !==
                  'file' ||
                entries.some((entry) => entry.name === posix.basename(move.to))
              )
                throw new DomainError('conflict');
              // Keep revision, offline state and effective grant fences immediately adjacent to each effect.
              if ((await service.adapter.getResources(identifier)).current_state !== 'offline')
                throw new DomainError('conflict');
              await authorize();
              dispatched = true;
              await service.adapter.renameFiles(identifier, '', [{ from: move.from, to: move.to }]);
              const after = service.fileReadPhase(identifier, server);
              const listing = await after.list(posix.dirname(move.from));
              if (
                listing.some((entry) => entry.name === posix.basename(move.from)) ||
                listing.find((entry) => entry.name === posix.basename(move.to))?.kind !== 'file'
              )
                throw new DomainError('operation_uncertain');
              const recovered = await after.read({ path: move.to, maxBytes: 4 * 1024 ** 2 });
              if (
                !recovered ||
                createHash('sha256').update(recovered).digest('hex') !== move.sha256
              )
                throw new DomainError('operation_uncertain');
            }
            await recordAudit(connection, current, 'server.minecraft.player.reset', {
              ...metadata,
              outcome: 'confirmed',
            });
            return {
              outcome: 'confirmed' as const,
              operationId,
              recoveryPaths: moves.map((move) => move.to),
            };
          } catch (error) {
            await recordAudit(connection, current, 'server.minecraft.player.reset', {
              ...metadata,
              outcome: dispatched ? 'uncertain' : 'failed',
            }).catch(() => {});
            if (dispatched) throw new DomainError('operation_uncertain');
            throw error;
          }
        }
        if (!minecraftDetailCommandsSupported(choice.combination.release))
          throw new DomainError('integration_unavailable');
        if ((await service.adapter.getResources(identifier)).current_state !== 'running')
          throw new DomainError('conflict');
        const name = snapshot.discovered.usercache.get(uuid);
        if (!name) throw new DomainError('conflict');
        const presence = await observeMinecraftPlayers(service, identifier, async () => {
          try {
            await authorize();
            return true;
          } catch {
            return false;
          }
        });
        if (
          presence.state !== 'available' ||
          !presence.players.some((entry) => entry.name.toLowerCase() === name.toLowerCase())
        )
          throw new DomainError('conflict');
        // Target the observed server UUID itself, never a Mojang substitution or a name-only selector.
        const command = minecraftDetailCommand(uuid, input);
        const metadata = {
          serverId,
          playerUuid: uuid,
          operationId,
          command,
          playerAction: input.action,
        };
        await recordAudit(connection, current, 'server.console.command', {
          ...metadata,
          outcome: 'requested',
        });
        await authorize();
        try {
          await service.adapter.sendCommand(identifier, command);
          await recordAudit(connection, current, 'server.console.dispatched', {
            ...metadata,
            outcome: 'dispatched',
          });
        } catch {
          await recordAudit(connection, current, 'server.console.failed', {
            ...metadata,
            outcome: 'uncertain',
          }).catch(() => {});
          throw new DomainError('operation_uncertain');
        }
        return { outcome: 'dispatched' as const, operationId };
      },
    );
    return c.json(result, result.outcome === 'dispatched' ? 202 : 200);
  });
}
