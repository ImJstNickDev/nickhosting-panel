import type { Database } from '@nickhosting/database';
import { type Expression, type Selectable, sql } from 'kysely';
import { openworldUpdatePlanSchema } from './openworld-update-plan.js';

export function openworldUpdateMatchesGateway(
  operation: Pick<Selectable<Database['server_operations']>, 'action' | 'plan'>,
  gameId: string,
  state: Pick<Selectable<Database['gateway_server_states']>, 'protocol_id' | 'game_version'>,
) {
  if (
    operation.action !== 'reinstall' ||
    gameId !== 'openworld' ||
    state.protocol_id !== 'openworld'
  )
    return false;
  const update = openworldUpdatePlanSchema.safeParse(operation.plan.openworldUpdate);
  if (!update.success) return false;
  return (
    state.game_version ===
    (operation.plan.openworldVersionVerified === true
      ? update.data.target.version
      : update.data.source.version)
  );
}

// Exception to the general reinstall route withdrawal: the old process remains
// authoritative until the notice expires. The new process needs verified files
// and must still pass the Gateway's normal nonce-correlated readiness probe.
export function openworldUpdateAllowsRoute(
  game: Expression<string>,
  runtime: Expression<string>,
  server: Expression<string>,
  job: Expression<string | null>,
) {
  return sql<boolean>`(${game} = 'openworld' and ${runtime} = 'dedicated' and exists (
    select 1 from openworld_server_updates u
    join server_operations op on op.job_id = u.job_id and op.server_id = u.server_id
    join openworld_server_profiles p on p.server_id = u.server_id
    join gateway_server_states g on g.server_id = p.server_id
    where u.job_id = ${job} and u.server_id = ${server} and op.action = 'reinstall'
      and g.protocol_id = 'openworld' and g.game_version = p.version
      and (((u.phase in ('preparing','waiting-empty','notice','cancelled') or
        (u.phase = 'stopping' and not (op.plan @> '{"backupOfflineConfirmed":true}')))
        and p.version = op.plan #>> '{openworldUpdate,source,version}'
        and p.sha256 = op.plan #>> '{openworldUpdate,source,sha256}')
      or (u.phase = 'starting' and op.plan @> '{"openworldVersionVerified":true}'
        and p.version = op.plan #>> '{openworldUpdate,target,version}'
        and p.sha256 = op.plan #>> '{openworldUpdate,target,sha256}')))
  )`;
}

export function openworldUpdateDrainsUdp(
  job: Expression<string | null>,
  server: Expression<string>,
) {
  return sql<boolean>`(${job} is not null and exists (
    select 1 from openworld_server_updates u
    join server_operations op on op.job_id = u.job_id and op.server_id = u.server_id
    where u.job_id = ${job} and u.server_id = ${server} and u.phase = 'stopping'
      and op.action = 'reinstall' and op.plan @> '{"openworldUpdate":{"waitForEmpty":true}}'
  ))`;
}
