import { randomBytes } from 'node:crypto';
import { type AuthContext, SecretCodec } from '@nickhosting/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createDatabase,
  gameCatalog,
  getSecret,
  getSettings,
  migrate,
  registerGame,
  saveBootstrapConfiguration,
  secretStatus,
  storeSecret,
  updateSettings,
} from './index.js';
import { createTestDatabase } from './testing.js';

describe('PostgreSQL platform authority', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  const owner: AuthContext = {
    actorUserId: 'owner',
    subjectUserId: 'owner',
    role: 'owner',
    sessionType: 'regular',
    ownerElevation: false,
  };
  const member: AuthContext = {
    ...owner,
    actorUserId: 'member',
    subjectUserId: 'member',
    role: 'user',
  };
  const codec = new SecretCodec({ activeKeyId: 'fixture', keys: { fixture: randomBytes(32) } });
  beforeAll(async () => {
    database = await createTestDatabase();
  });
  afterAll(async () => {
    if (database) await database.destroy();
  });

  it('migrates empty DB without accounts/settings and serializes repeated migrations', async () => {
    expect((await database.pool.query('SELECT id FROM "user"')).rowCount).toBe(0);
    expect((await database.pool.query('SELECT key FROM platform_settings')).rowCount).toBe(0);
    expect(await Promise.all([migrate(database.pool), migrate(database.pool)])).toEqual([[], []]);
    await database.pool.query(
      `INSERT INTO "user"(id,name,email,role) VALUES ('owner','Owner','owner@example.com','owner'),('member','Member','member@example.com','user')`,
    );
  });
  it('resolves precedence, protects env fields and prevents concurrent lost updates', async () => {
    expect((await getSettings(database.db)).values.defaultLocale).toBe('en');
    await Promise.all([
      updateSettings(database.db, owner, { defaultLocale: 'it' }),
      updateSettings(database.db, owner, { instanceName: 'Fixture' }),
    ]);
    const value = await getSettings(database.db, { NH_INSTANCE_NAME: 'Environment' });
    expect(value.values).toMatchObject({ defaultLocale: 'it', instanceName: 'Environment' });
    expect(value.lockedKeys).toContain('instanceName');
    await expect(
      updateSettings(
        database.db,
        owner,
        { instanceName: 'Wrong' },
        { NH_INSTANCE_NAME: 'Environment' },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      updateSettings(database.db, member, { instanceName: 'Wrong' }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('stores encrypted authenticated secrets, exposes presence only and audits field names', async () => {
    const value = randomBytes(32).toString('base64url');
    await storeSecret(database.db, owner, codec, 'pterodactylApplicationKey', value);
    expect(await getSecret(database.db, codec, 'pterodactylApplicationKey')).toBe(value);
    expect(
      await getSecret(database.db, codec, 'pterodactylApplicationKey', {
        NH_PTERODACTYL_APPLICATION_KEY: 'explicit-override',
      }),
    ).toBe('explicit-override');
    expect(JSON.stringify(await secretStatus(database.db))).not.toContain(value);
    expect(
      JSON.stringify((await database.pool.query('SELECT * FROM encrypted_secrets')).rows),
    ).not.toContain(value);
    expect(
      JSON.stringify((await database.pool.query('SELECT * FROM audit_events')).rows),
    ).not.toContain(value);
    const stored = await database.db
      .selectFrom('encrypted_secrets')
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(() => codec.decrypt(stored.envelope, 'another-record')).toThrow('secret_invalid');
  });
  it('completes bootstrap after legitimate early settings/secret writes without discarding other settings', async () => {
    const client = await database.pool.connect();
    const value = randomBytes(32).toString('base64url');
    try {
      await client.query('BEGIN');
      await saveBootstrapConfiguration(
        client,
        codec,
        {
          instanceName: 'Finished',
          pterodactylBaseURL: 'https://panel.example.com',
          pterodactylApplicationKey: value,
        },
        'owner',
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect((await getSettings(database.db)).values).toMatchObject({
      instanceName: 'Finished',
      defaultLocale: 'it',
    });
    expect(await getSecret(database.db, codec, 'pterodactylApplicationKey')).toBe(value);
    const testUrl = process.env.NH_TEST_DATABASE_URL;
    if (!testUrl) throw new Error('Missing isolated test URL');
    const reopened = createDatabase(testUrl, {
      options: `-c search_path=${database.schema}`,
    });
    try {
      expect(await migrate(reopened.pool)).toEqual([]);
      expect(await getSecret(reopened.db, codec, 'pterodactylApplicationKey')).toBe(value);
    } finally {
      await reopened.db.destroy();
    }
  });
  it('persists canonical rollout and filters catalog by actual user authority', async () => {
    const manifest = {
      id: 'fixture-game',
      version: '1.0.0',
      nameKey: 'games.fixture-game.name',
      capabilities: {
        console: false,
        files: false,
        backups: false,
        players: false,
        mods: false,
        worlds: false,
        idleDetection: false,
        gracefulStop: false,
        readiness: false,
        wake: 'unsupported',
      },
      connection: { mode: 'static-host-port', hostnameSettingKey: 'fixtureHost', showPort: true },
      ports: [{ role: 'game', transport: 'tcp', required: true }],
      runtimes: [
        {
          id: 'fixture',
          nameKey: 'games.fixture-game.runtime',
          supportedGameVersions: ['1'],
          supports: {},
        },
      ],
      wizard: { steps: [] },
      management: [],
      localizations: { namespace: 'games.fixture-game', locales: ['en', 'it'] },
    };
    await registerGame(database.db, owner, manifest, {
      gameId: 'fixture-game',
      state: 'private-testing',
      allowedUserIds: [],
    });
    expect(await gameCatalog(database.db, member)).toHaveLength(0);
    await registerGame(database.db, owner, manifest, {
      gameId: 'fixture-game',
      state: 'private-testing',
      allowedUserIds: ['member'],
    });
    expect((await gameCatalog(database.db, member))[0]?.access.canCreate).toBe(true);
    await registerGame(database.db, owner, manifest, {
      gameId: 'fixture-game',
      state: 'disabled-for-new-servers',
    });
    expect((await gameCatalog(database.db, owner))[0]?.access).toMatchObject({
      canCreate: false,
      canManageExisting: true,
    });
  });
});
