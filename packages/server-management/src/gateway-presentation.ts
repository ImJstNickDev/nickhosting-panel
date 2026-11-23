import type { GatewayPresentation } from '@nickhosting/core';
import { connectionModeSchema } from '@nickhosting/game-sdk';
import { sql } from 'kysely';
import type { DB } from './admission.js';
import {
  canUseConfirmedEndpoint,
  confirmedDnsConnection,
  playerAddress,
} from './connection-address.js';

/** Local, batched presentation metadata. Listener/backend addresses are not public
 * connection addresses. Only confirmed DNS assignments can supply the latter. */
export async function getGatewayPresentationVariables(
  db: DB,
  servers: Array<{ id: string; runtimeId: string; gameVersion: string }>,
): Promise<Map<string, NonNullable<GatewayPresentation['variables']>>> {
  const ids = [...new Set(servers.map((server) => server.id))];
  if (!ids.length) return new Map();
  const [assignments, preferences, routes] = await Promise.all([
    db
      .selectFrom('dns_assignments as dns')
      .innerJoin('managed_servers as server', 'server.id', 'dns.server_id')
      .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
      .innerJoin('game_integrations as game', 'game.id', 'mapping.game_id')
      .select([
        'dns.id',
        'dns.server_id',
        'dns.state',
        'dns.plan',
        sql<unknown>`game.manifest->'connection'`.as('mode'),
      ])
      .where('dns.server_id', 'in', ids)
      .where('dns.state', '!=', 'deleted')
      .orderBy('dns.updated_at', 'desc')
      .execute(),
    db
      .selectFrom('server_dns_preferences')
      .select(['server_id', 'assignment_id'])
      .where('server_id', 'in', ids)
      .execute(),
    db
      .selectFrom('gateway_routes as route')
      .innerJoin('server_allocations as allocation', (join) =>
        join
          .onRef('allocation.id', '=', 'route.allocation_id')
          .onRef('allocation.server_id', '=', 'route.server_id'),
      )
      .select([
        'route.server_id',
        'route.public_port',
        'route.public_address',
        'route.transport',
        'allocation.protocols',
      ])
      .where('route.server_id', 'in', ids)
      .where('route.enabled', '=', true)
      .where('allocation.private_only', '=', false)
      .where('allocation.is_primary', '=', true)
      .where('allocation.role', '=', 'game')
      .execute(),
  ]);
  const assignmentsByServer = new Map<string, typeof assignments>();
  for (const assignment of assignments) {
    const group = assignmentsByServer.get(assignment.server_id) ?? [];
    group.push(assignment);
    assignmentsByServer.set(assignment.server_id, group);
  }
  const preferencesByServer = new Map(
    preferences.map((preference) => [preference.server_id, preference]),
  );
  const routesByServer = new Map<string, typeof routes>();
  for (const route of routes) {
    const group = routesByServer.get(route.server_id) ?? [];
    group.push(route);
    routesByServer.set(route.server_id, group);
  }
  return new Map(
    servers.map((server) => {
      const candidates = assignmentsByServer.get(server.id) ?? [];
      const preferred = preferencesByServer.get(server.id);
      const assignment =
        candidates.find((candidate) => candidate.id === preferred?.assignment_id) ??
        candidates.find((candidate) => candidate.state === 'active') ??
        candidates[0];
      const confirmed = confirmedDnsConnection(assignment);
      const mode = connectionModeSchema.safeParse(assignment?.mode).data ?? null;
      const srv = mode?.mode === 'custom-subdomain' ? mode.srv : undefined;
      const route = routesByServer
        .get(server.id)
        ?.find(
          (route) =>
            canUseConfirmedEndpoint(confirmed, route.public_address, route.public_port) &&
            route.transport === (srv?.proto ?? route.protocols[0]),
        );
      const address =
        confirmed && route
          ? (playerAddress(
              confirmed.hostname,
              route.public_port,
              route.transport,
              true,
              mode,
              confirmed,
            ) ?? '')
          : '';
      return [
        server.id,
        {
          version: server.gameVersion,
          runtime: server.runtimeId,
          address,
        },
      ];
    }),
  );
}
