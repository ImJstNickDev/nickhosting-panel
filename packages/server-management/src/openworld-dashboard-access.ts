import type { AuthContext } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Kysely } from 'kysely';

export async function canAccessOpenworldDashboard(
  db: Kysely<Database>,
  who: AuthContext,
  server: { id: string; owner_id: string },
) {
  if (who.sessionType !== 'regular' || who.actorUserId !== who.subjectUserId) return false;
  if (server.owner_id === who.subjectUserId) return true;
  const direct = await db
    .selectFrom('server_subusers')
    .select('permission_keys')
    .where('server_id', '=', server.id)
    .where('user_id', '=', who.subjectUserId)
    .executeTakeFirst();
  return direct?.permission_keys.includes('game.openworld.dashboard.admin') ?? false;
}
