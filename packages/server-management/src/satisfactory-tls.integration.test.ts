import { randomBytes, randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureSatisfactoryTlsIdentity, readSatisfactoryTlsIdentity } from './satisfactory-tls.js';

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
describe('durable Satisfactory TLS identity', () => {
  it('concurrent creation converges on one encrypted identity and retries preserve it', async () => {
    const serverId = randomUUID();
    const identities = await Promise.all([
      ensureSatisfactoryTlsIdentity(database.db, codec, serverId),
      ensureSatisfactoryTlsIdentity(database.db, codec, serverId),
    ]);
    expect(identities[0]).toEqual(identities[1]);
    const row = await database.db
      .selectFrom('encrypted_secrets')
      .selectAll()
      .where('name', '=', `gateway.satisfactory.tls.${serverId}`)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(row)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(row)).not.toContain('CERTIFICATE');
    expect(await readSatisfactoryTlsIdentity(database.db, codec, serverId)).toEqual(identities[0]);
    expect(await ensureSatisfactoryTlsIdentity(database.db, codec, serverId)).toEqual(
      identities[0],
    );
    expect(await readSatisfactoryTlsIdentity(database.db, codec, randomUUID())).toBeNull();
  });
  it('rejects encrypted-record substitution between server identities', async () => {
    const firstId = randomUUID(),
      secondId = randomUUID();
    await ensureSatisfactoryTlsIdentity(database.db, codec, firstId);
    const row = await database.db
      .selectFrom('encrypted_secrets')
      .select('envelope')
      .where('name', '=', `gateway.satisfactory.tls.${firstId}`)
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('encrypted_secrets')
      .values({ name: `gateway.satisfactory.tls.${secondId}`, envelope: row.envelope })
      .execute();
    await expect(readSatisfactoryTlsIdentity(database.db, codec, secondId)).rejects.toThrow(
      'secret_invalid',
    );
  });
});
