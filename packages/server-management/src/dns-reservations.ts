import { randomUUID } from 'node:crypto';
import {
  type AuthContext,
  DomainError,
  resolveDnsDomains,
  resolveDnsOptions,
  validateDnsLabel,
} from '@nickhosting/core';
import { type Database, getSettings } from '@nickhosting/database';
import { gameManifestSchema } from '@nickhosting/game-sdk';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Environment } from './admission.js';

export const dnsWizardHoldMs = 15 * 60 * 1000;
export async function reserveDnsWizardHostname(
  db: Kysely<Database>,
  context: AuthContext,
  gameId: string,
  selection: {
    domainId: string;
    subdomain: string;
    hostname: string;
    previousReservationId?: string;
  },
) {
  return db.transaction().execute(async (tx) => {
    // Serialize only short local hold bookkeeping; no provider call under this lock.
    await sql`select pg_advisory_xact_lock(hashtextextended(current_schema() || ':dns:wizard',0))`.execute(
      tx,
    );
    const now = new Date(),
      expiresAt = new Date(now.getTime() + dnsWizardHoldMs);
    await tx
      .deleteFrom('dns_hostname_reservations')
      .where('wizard_user_id', '=', context.subjectUserId)
      .where('release_after', '<=', now)
      .execute();
    await tx
      .deleteFrom('dns_hostname_reservations')
      .where('hostname', '=', selection.hostname)
      .where('release_after', '<=', now)
      .execute();
    const existing = await tx
      .selectFrom('dns_hostname_reservations')
      .selectAll()
      .where('hostname', '=', selection.hostname)
      .forUpdate()
      .executeTakeFirst();
    if (
      existing &&
      (existing.wizard_user_id !== context.subjectUserId ||
        existing.wizard_game_id !== gameId ||
        existing.wizard_domain_id !== selection.domainId ||
        existing.wizard_subdomain !== selection.subdomain)
    )
      throw new DomainError('conflict');
    // Releasing the previous choice is part of this transaction; failed replacements
    // retain it. Never remove a consumed/server-owned claim or another account's hold.
    if (selection.previousReservationId) {
      const previous = await tx
        .selectFrom('dns_hostname_reservations')
        .selectAll()
        .where('owner_id', '=', selection.previousReservationId)
        .where('wizard_user_id', '=', context.subjectUserId)
        .where('wizard_game_id', '=', gameId)
        .executeTakeFirst();
      if (previous && previous.hostname !== selection.hostname)
        await tx
          .deleteFrom('dns_hostname_reservations')
          .where('hostname', '=', previous.hostname)
          .where('owner_id', '=', previous.owner_id)
          .execute();
    }
    if (!existing) {
      const count = await tx
        .selectFrom('dns_hostname_reservations')
        .select(tx.fn.countAll<string>().as('count'))
        .where('wizard_user_id', '=', context.subjectUserId)
        .where('release_after', '>', now)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= 5)
        throw new DomainError('rate_limited', 429, { retryAfterMs: 60_000 });
    }
    const reservationId = existing?.owner_id ?? randomUUID();
    if (existing)
      await tx
        .updateTable('dns_hostname_reservations')
        .set({ release_after: expiresAt })
        .where('hostname', '=', selection.hostname)
        .execute();
    else {
      await tx
        .insertInto('dns_hostname_reservations')
        .values({
          hostname: selection.hostname,
          owner_id: reservationId,
          release_after: expiresAt,
          wizard_user_id: context.subjectUserId,
          wizard_game_id: gameId,
          wizard_domain_id: selection.domainId,
          wizard_subdomain: selection.subdomain,
        })
        .onConflict((oc) => oc.column('hostname').doNothing())
        .execute();
      const claimed = await tx
        .selectFrom('dns_hostname_reservations')
        .select('owner_id')
        .where('hostname', '=', selection.hostname)
        .executeTakeFirstOrThrow();
      if (claimed.owner_id !== reservationId) throw new DomainError('conflict');
    }
    return {
      reservationId,
      hostname: selection.hostname,
      expiresAt,
      domainId: selection.domainId,
      subdomain: selection.subdomain,
    };
  });
}
/** The caller's server-creation transaction owns the entire transfer/rollback. */
export async function consumeDnsWizardReservation(
  tx: Transaction<Database>,
  context: AuthContext,
  gameId: string,
  serverId: string,
  connection: { reservationId?: string; domainId?: string; subdomain?: string },
  env: Environment = {},
) {
  if (!connection.subdomain) {
    if (connection.reservationId) throw new DomainError('validation_failed');
    return;
  }
  const [{ values: config }, game] = await Promise.all([
    getSettings(tx, env),
    tx
      .selectFrom('game_integrations')
      .select('manifest')
      .where('id', '=', gameId)
      .executeTakeFirstOrThrow(),
  ]);
  const manifest = gameManifestSchema.parse(game.manifest);
  const choices = resolveDnsOptions(config, manifest.connection, gameId);
  if (!choices.customizable || !choices.configured) throw new DomainError('validation_failed');
  const domain = resolveDnsDomains(config, manifest.connection, gameId).find(
    (d) => d.id === (connection.domainId ?? choices.defaultDomainId),
  );
  if (!domain) throw new DomainError('validation_failed');
  const subdomain = validateDnsLabel(connection.subdomain, config),
    hostname = `${subdomain}.${domain.hostname}`;
  if (hostname.length > 253) throw new DomainError('validation_failed');
  const existing = await tx
    .selectFrom('dns_hostname_reservations')
    .selectAll()
    .where('hostname', '=', hostname)
    .forUpdate()
    .executeTakeFirst();
  const now = new Date();
  if (connection.reservationId) {
    if (
      !existing ||
      existing.owner_id !== connection.reservationId ||
      existing.wizard_user_id !== context.subjectUserId ||
      existing.wizard_game_id !== gameId ||
      existing.wizard_domain_id !== domain.id ||
      existing.wizard_subdomain !== subdomain ||
      !existing.release_after ||
      existing.release_after <= now
    )
      throw new DomainError('conflict');
  } else if (existing && (existing.release_after === null || existing.release_after > now))
    throw new DomainError('conflict');
  const fields = {
    owner_id: serverId,
    release_after: null,
    wizard_user_id: null,
    wizard_game_id: null,
    wizard_domain_id: null,
    wizard_subdomain: null,
  };
  if (existing)
    await tx
      .updateTable('dns_hostname_reservations')
      .set(fields)
      .where('hostname', '=', hostname)
      .execute();
  else {
    await tx
      .insertInto('dns_hostname_reservations')
      .values({ hostname, ...fields })
      .onConflict((oc) => oc.column('hostname').doNothing())
      .execute();
    const claimed = await tx
      .selectFrom('dns_hostname_reservations')
      .select('owner_id')
      .where('hostname', '=', hostname)
      .executeTakeFirstOrThrow();
    if (claimed.owner_id !== serverId) throw new DomainError('conflict');
  }
  return { domainId: domain.id, subdomain };
}
