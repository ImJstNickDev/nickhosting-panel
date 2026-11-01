import type { GatewayPresentation } from '@nickhosting/core';
import { z } from 'zod';
import type { DB } from './admission.js';

const connectionSchema = z.object({
  hostname: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  records: z.array(
    z
      .object({ type: z.string(), data: z.object({ port: z.number() }).passthrough().optional() })
      .passthrough(),
  ),
});

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
      .selectFrom('dns_assignments')
      .select(['id', 'server_id', 'state', 'plan'])
      .where('server_id', 'in', ids)
      .where('state', '!=', 'deleted')
      .orderBy('updated_at', 'desc')
      .execute(),
    db
      .selectFrom('server_dns_preferences')
      .select(['server_id', 'assignment_id'])
      .where('server_id', 'in', ids)
      .execute(),
    db
      .selectFrom('gateway_routes as route')
      .innerJoin('server_allocations as allocation', 'allocation.id', 'route.allocation_id')
      .select(['route.server_id', 'route.public_port'])
      .where('route.server_id', 'in', ids)
      .where('route.enabled', '=', true)
      .where('route.transport', '=', 'tcp')
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
  const portsByServer = new Map<string, Set<number>>();
  for (const route of routes) {
    const ports = portsByServer.get(route.server_id) ?? new Set<number>();
    ports.add(route.public_port);
    portsByServer.set(route.server_id, ports);
  }
  return new Map(
    servers.map((server) => {
      const candidates = assignmentsByServer.get(server.id) ?? [];
      const preferred = preferencesByServer.get(server.id);
      const assignment =
        candidates.find((candidate) => candidate.id === preferred?.assignment_id) ??
        candidates.find((candidate) => candidate.state === 'active') ??
        candidates[0];
      const intent = assignment?.plan as
        | { connection?: unknown; confirmedConnection?: unknown }
        | undefined;
      const connection = connectionSchema.safeParse(
        assignment?.state === 'active' ? intent?.connection : intent?.confirmedConnection,
      );
      let address = '';
      if (connection.success && portsByServer.get(server.id)?.has(connection.data.port)) {
        const { hostname, port, records } = connection.data;
        const srv = records.some((record) => record.type === 'SRV' && record.data?.port === port);
        address = srv ? hostname : `${hostname.includes(':') ? `[${hostname}]` : hostname}:${port}`;
      }
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
