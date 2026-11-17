import { createHash, timingSafeEqual } from 'node:crypto';
import { DomainError, type SecretCodec } from '@nickhosting/core';
import type { Database } from '@nickhosting/database';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { GameLifecycleContext } from './lifecycle.js';

export const satisfactorySetupSchema = z
  .strictObject({
    adminPassword: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => !value.includes('\0')),
    clientPassword: z
      .string()
      .max(128)
      .refine((value) => !value.includes('\0'))
      .optional(),
  })
  .refine((value) => !value.clientPassword || value.clientPassword !== value.adminPassword, {
    path: ['clientPassword'],
    message: 'Passwords must differ',
  });
export type SatisfactorySetup = z.infer<typeof satisfactorySetupSchema>;
const pendingSchema = z.strictObject({
  setup: satisfactorySetupSchema,
  serverName: z.string().min(1).max(100),
  phase: z.enum(['pending', 'claiming', 'claimed', 'password-set', 'token-generated']),
  startedAt: z.number().finite().optional(),
  applicationToken: z.string().max(8192).optional(),
});
const setupName = (id: string) => `satisfactory.initial-setup.${z.uuid().parse(id)}`;
const receiptName = (id: string) => `satisfactory.creation-request.${z.uuid().parse(id)}`;
function fingerprint(setup: SatisfactorySetup): string {
  return createHash('sha256')
    .update(JSON.stringify(satisfactorySetupSchema.parse(setup)))
    .digest('hex');
}
/** Public job request hashes contain only setup presence, never a password-derived value. */
export function satisfactoryCreationHashInput(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const value = input as Record<string, unknown>;
  const satisfactory = value.satisfactory;
  if (!satisfactory || typeof satisfactory !== 'object' || Array.isArray(satisfactory))
    return input;
  const { setup, ...configuration } = satisfactory as Record<string, unknown>;
  return {
    ...value,
    satisfactory: { ...configuration, ...(setup === undefined ? {} : { setup: true }) },
  };
}
/** Caller owns the creation transaction. Receipt survives consumption for safe idempotency. */
export async function persistSatisfactorySetup(
  db: Kysely<Database>,
  codec: SecretCodec,
  serverId: string,
  serverName: string,
  input: SatisfactorySetup,
): Promise<void> {
  const setup = satisfactorySetupSchema.parse(input);
  const name = setupName(serverId),
    receipt = receiptName(serverId);
  await db
    .insertInto('encrypted_secrets')
    .values([
      {
        name,
        envelope: codec.encrypt(JSON.stringify({ setup, serverName, phase: 'pending' }), name),
      },
      { name: receipt, envelope: codec.encrypt(fingerprint(setup), receipt) },
    ])
    .execute();
}
export async function assertSatisfactorySetupRetry(
  db: Kysely<Database>,
  codec: SecretCodec | undefined,
  serverId: string,
  setup: SatisfactorySetup | undefined,
): Promise<void> {
  if (!setup) return;
  if (!codec) throw new DomainError('configuration_invalid');
  const name = receiptName(serverId);
  const row = await db
    .selectFrom('encrypted_secrets')
    .select('envelope')
    .where('name', '=', name)
    .executeTakeFirst();
  if (!row) throw new DomainError('conflict');
  const expected = Buffer.from(codec.decrypt(row.envelope, name));
  const supplied = Buffer.from(fingerprint(setup));
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
    throw new DomainError('conflict');
}

/** Runs under the existing server lifecycle lock after power confirmation. */
export async function finalizeSatisfactorySetup(
  context: GameLifecycleContext,
  codec: SecretCodec,
): Promise<boolean> {
  const name = setupName(context.server.id);
  const row = await context.db
    .selectFrom('encrypted_secrets')
    .select('envelope')
    .where('name', '=', name)
    .executeTakeFirst();
  if (!row) return true;
  const { resolveSatisfactoryBootstrapApi, storeSatisfactoryApiToken } = await import(
    './satisfactory-api.js'
  );
  let pending = pendingSchema.parse(JSON.parse(codec.decrypt(row.envelope, name)));
  const persist = async (patch: Partial<z.infer<typeof pendingSchema>>) => {
    pending = { ...pending, ...patch };
    await context.db
      .updateTable('encrypted_secrets')
      .set({ envelope: codec.encrypt(JSON.stringify(pending), name) })
      .where('name', '=', name)
      .execute();
  };
  await context.authorize();
  if (pending.startedAt === undefined) await persist({ startedAt: Date.now() });
  if (Date.now() - (pending.startedAt ?? 0) > 10 * 60_000) {
    await context.db.deleteFrom('encrypted_secrets').where('name', '=', name).execute();
    throw new DomainError('game_not_ready');
  }
  try {
    const anonymous = await resolveSatisfactoryBootstrapApi(context.db, codec, context.server.id);
    let token: string;
    if (pending.phase === 'pending') {
      // InitialAdmin is available only on a genuinely unclaimed native server.
      token = await anonymous.passwordlessLogin('InitialAdmin');
      await context.authorize();
      await persist({ phase: 'claiming' });
      const initial = await resolveSatisfactoryBootstrapApi(
        context.db,
        codec,
        context.server.id,
        token,
      );
      token = await initial.claim(pending.serverName, pending.setup.adminPassword);
      await persist({ phase: 'claimed' });
    } else {
      // Only a durable prior claim attempt permits recovering using this password.
      try {
        token = await anonymous.passwordLogin(pending.setup.adminPassword);
      } catch (error) {
        if (
          pending.phase !== 'claiming' ||
          !(error instanceof DomainError) ||
          error.code !== 'game_authentication_failed'
        )
          throw error;
        // The worker may have stopped after recording intent but before dispatch.
        const initialToken = await anonymous.passwordlessLogin('InitialAdmin');
        await context.authorize();
        const initial = await resolveSatisfactoryBootstrapApi(
          context.db,
          codec,
          context.server.id,
          initialToken,
        );
        token = await initial.claim(pending.serverName, pending.setup.adminPassword);
      }
      if (pending.phase === 'claiming') await persist({ phase: 'claimed' });
    }
    const administrator = await resolveSatisfactoryBootstrapApi(
      context.db,
      codec,
      context.server.id,
      token,
    );
    if (pending.phase === 'claimed') {
      if (pending.setup.clientPassword !== undefined) {
        await context.authorize();
        await administrator.setClientPassword(pending.setup.clientPassword);
      }
      await persist({ phase: 'password-set' });
    }
    if (pending.phase === 'password-set') {
      await context.authorize();
      const applicationToken = await administrator.generateApplicationToken();
      await persist({ phase: 'token-generated', applicationToken });
    }
    if (!pending.applicationToken) throw new DomainError('configuration_invalid');
    const application = await resolveSatisfactoryBootstrapApi(
      context.db,
      codec,
      context.server.id,
      pending.applicationToken,
    );
    await application.state();
    await context.authorize();
    await context.db.transaction().execute(async (tx) => {
      await storeSatisfactoryApiToken(tx, codec, context.server.id, pending.applicationToken ?? '');
      await tx.deleteFrom('encrypted_secrets').where('name', '=', name).execute();
    });
    return true;
  } catch (error) {
    if (error instanceof DomainError) {
      if (error.code === 'integration_unavailable' || error.code === 'game_not_ready') return false;
      // A definitive native refusal must not retain passwords or replay setup on later starts.
      await context.db.deleteFrom('encrypted_secrets').where('name', '=', name).execute();
      if (error.code === 'game_authentication_failed' || error.code === 'game_setup_conflict')
        throw new DomainError('game_setup_conflict');
    }
    throw error;
  }
}

/** Confirmed deletion cleanup, inside the existing lifecycle transaction. */
export async function deleteSatisfactorySetup(
  db: Kysely<Database>,
  serverId: string,
): Promise<void> {
  await db
    .deleteFrom('encrypted_secrets')
    .where('name', 'in', [setupName(serverId), receiptName(serverId)])
    .execute();
}
