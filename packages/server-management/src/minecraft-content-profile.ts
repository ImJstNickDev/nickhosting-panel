import { DomainError } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import { minecraftCombinationSchema } from '@nickhosting/minecraft';
import type { Kysely } from 'kysely';

/** Installed content readers need the bound runtime tuple. Installation and transition
 * admission separately evaluate mappings, rollout and signed support evidence. */
export async function getMinecraftContentProfile(db: Kysely<Database>, serverId: string) {
  const profile = await db
    .selectFrom('minecraft_server_profiles as p')
    .innerJoin('minecraft_combinations as c', 'c.id', 'p.combination_id')
    .select(['p.installed', 'p.combination_id', 'c.combination'])
    .where('p.server_id', '=', serverId)
    .executeTakeFirst();
  if (!profile) throw new DomainError('not_found');
  return {
    installed: profile.installed,
    combinationId: profile.combination_id,
    combination: minecraftCombinationSchema.parse(profile.combination),
  };
}
