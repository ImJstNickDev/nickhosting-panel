import { type AuthContext, DomainError } from '@nickhosting/core';
import { recordAudit } from '@nickhosting/database';
import { z } from 'zod';
import type { OpenworldRelease } from '../../../games/openworld/src/catalog-source.js';
import { readOpenworldStatus } from '../../../games/openworld/src/gateway-module.js';
import type { DB } from './admission.js';
import { ownerOnly } from './registry.js';

// A controlled release test supplies its pinned artifact and the answer to its
// four-byte query. Silence, an icon reply, or another query's packet proves nothing.
const releaseCheck = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  checkedAt: z.iso.datetime(),
});
export const openworldGatewayEvidence = z.union([
  releaseCheck.extend({
    nonce: z.string().regex(/^[0-9a-f]{8}$/),
    statusPacketHex: z
      .string()
      .min(50)
      .max(16384)
      .regex(/^(?:[0-9a-f]{2})+$/),
  }),
  releaseCheck.extend({
    kind: z.literal('controlled-incompatibility'),
    observedVersion: z.string().min(1).max(64),
    serverReady: z.literal(true),
    probes: z.int().min(1).max(100),
    result: z.enum(['unrecognized-reply', 'no-status-reply']),
  }),
]);

function checkReason(input: z.infer<typeof openworldGatewayEvidence>, version: string) {
  if ('kind' in input) {
    // This is an explicit Owner conclusion from an isolated, identified build.
    // Ordinary health observations never write a release verdict.
    if (input.observedVersion !== version) throw new DomainError('conflict');
    return 'protocol_mismatch';
  }
  const packet = Buffer.from(input.statusPacketHex, 'hex');
  const nonce = Buffer.from(input.nonce, 'hex');
  if (
    packet[16] !== 8 ||
    !packet.subarray(17, 21).equals(Buffer.from('OWMU')) ||
    !nonce.equals(packet.subarray(21, 25))
  )
    throw new DomainError('validation_failed');
  const status = readOpenworldStatus(packet, nonce);
  if (!status) return 'protocol_mismatch';
  return status.version === version ? 'verified' : 'version_mismatch';
}

export async function recordOpenworldReleaseCheck(
  db: DB,
  who: AuthContext,
  release: OpenworldRelease,
  input: z.infer<typeof openworldGatewayEvidence>,
) {
  ownerOnly(who);
  const checkedAt = new Date(input.checkedAt);
  if (checkedAt.getTime() > Date.now()) throw new DomainError('validation_failed');
  if (input.sha256 !== release.sha256) throw new DomainError('conflict');
  const reason = checkReason(input, release.version);
  const outcome = reason === 'verified' ? 'passed' : 'failed';
  await db.transaction().execute(async (tx) => {
    const row = await tx
      .insertInto('openworld_gateway_release_checks')
      .values({
        version: release.version,
        sha256: release.sha256,
        checked_at: checkedAt,
        outcome,
        reason,
      })
      .onConflict((c) =>
        c
          .columns(['version', 'sha256'])
          .doUpdateSet({ checked_at: checkedAt, outcome, reason })
          .where('openworld_gateway_release_checks.checked_at', '<', checkedAt),
      )
      .returning('version')
      .executeTakeFirst();
    if (!row) throw new DomainError('conflict');
    await recordAudit(tx, who, 'openworld.gateway.release_checked', {
      version: release.version,
      sha256: release.sha256,
      outcome,
      reason,
      ...('kind' in input ? { kind: input.kind, probes: input.probes, result: input.result } : {}),
    });
  });
  return { checkedAt, outcome, reason };
}

export async function openworldReleasesWithFailures(db: DB, releases: OpenworldRelease[]) {
  if (!releases.length) return [];
  const rows = await db
    .selectFrom('openworld_gateway_release_checks')
    .select(['version', 'sha256', 'checked_at', 'reason'])
    .where('outcome', '=', 'failed')
    .where(
      'version',
      'in',
      releases.map((r) => r.version),
    )
    .execute();
  const failures = new Map(rows.map((row) => [`${row.version}/${row.sha256}`, row]));
  return releases.map((release) => {
    const failure = failures.get(`${release.version}/${release.sha256}`);
    return failure
      ? { ...release, gatewayFailure: { reason: failure.reason, checkedAt: failure.checked_at } }
      : release;
  });
}
