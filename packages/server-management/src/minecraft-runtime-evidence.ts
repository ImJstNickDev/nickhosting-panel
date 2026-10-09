import { DomainError } from '@nickhosting/core';
import { type MinecraftEvidence, minecraftDigest } from '@nickhosting/minecraft';
import type { DB, Environment } from './admission.js';
import { inspectMinecraftCombination } from './minecraft-registry.js';

/** Docker configuration content identity (.Image), NOT a registry manifest digest.
 * An absent server container is explicitly unobserved: verified artifact/config
 * installation may precede an admitted first start, but playable readiness cannot.
 * The hash alone proves neither the Java version nor protocol support; the signed
 * exact-combination real-server report provides that separate test evidence. */
export async function requireMinecraftRuntimeImageEvidence(
  db: DB,
  serverId: string,
  observed: string | null,
  env: Environment = {},
): Promise<{
  expected: string;
  observed: string | null;
  verified: boolean;
  report: MinecraftEvidence;
}> {
  const server = await db
    .selectFrom('managed_servers')
    .selectAll()
    .where('id', '=', serverId)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  const profile = await db
    .selectFrom('minecraft_server_profiles')
    .selectAll()
    .where('server_id', '=', serverId)
    .executeTakeFirst();
  if (!server || !profile) throw new DomainError('not_found');
  const choice = await inspectMinecraftCombination(db, profile.combination_id, env);
  if (
    choice.row.mapping_id !== server.mapping_id ||
    choice.mapping.game_id !== 'minecraft-java' ||
    choice.mapping.runtime_id !== choice.combination.profile ||
    choice.row.mapping_digest !== choice.mappingDigest
  )
    throw new DomainError('provenance_mismatch');
  if (choice.support !== 'verified') {
    const rollout = await db
      .selectFrom('game_rollouts')
      .selectAll()
      .where('integration_id', '=', 'minecraft-java')
      .executeTakeFirst();
    const owner = await db
      .selectFrom('user')
      .select(['id', 'role'])
      .where('id', '=', server.owner_id)
      .executeTakeFirst();
    if (
      choice.support !== 'experimental' ||
      rollout?.state !== 'private-testing' ||
      !owner ||
      (owner.role !== 'owner' && !rollout.allowlist.includes(owner.id))
    )
      throw new DomainError('integration_unavailable');
  }
  const now = Date.now();
  const reports = choice.evidence
    .filter(
      (report) =>
        (report.kind === 'real-server' || report.kind === 'installation-bootstrap') &&
        report.combinationDigest === minecraftDigest(choice.combination) &&
        report.mappingDigest === choice.mappingDigest &&
        report.choiceDigest === choice.row.identity_digest &&
        Date.parse(report.recordedAt) <= now &&
        now - Date.parse(report.recordedAt) < 180 * 86400000,
    )
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  const report = reports[0];
  if (
    !report?.server ||
    !report.checks.installation ||
    report.server.javaMajor !== choice.combination.javaMajor ||
    (reports[1] && Date.parse(reports[1].recordedAt) === Date.parse(report.recordedAt))
  )
    throw new DomainError('integration_unavailable');
  if (
    observed !== null &&
    (!/^sha256:[a-f0-9]{64}$/.test(observed) || observed !== report.server.imageDigest)
  )
    throw new DomainError('provenance_mismatch');
  return { expected: report.server.imageDigest, observed, verified: observed !== null, report };
}
