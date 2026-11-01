import { readFile } from 'node:fs/promises';
import { createTestDatabase } from '@nickhosting/database/testing';
import { expect, it } from 'vitest';

it('backfills pre-existing accounts deterministically without deriving usernames from display names', async () => {
  const database = await createTestDatabase();
  const tx = await database.pool.connect();
  try {
    await tx.query('BEGIN');
    // The temporary relation shadows only this connection's user table. No runtime
    // identities or infrastructure are accessed by this migration fixture.
    await tx.query(
      'CREATE TEMP TABLE "user" (id text PRIMARY KEY, name text NOT NULL) ON COMMIT DROP',
    );
    await tx.query('INSERT INTO "user"(id,name) VALUES ($1,$2),($3,$2),($4,$5)', [
      'third',
      'Same Display Name',
      'first',
      'second',
      '名',
    ]);
    await tx.query(
      await readFile(
        new URL('../../database/migrations/029_usernames.sql', import.meta.url),
        'utf8',
      ),
    );
    expect((await tx.query('SELECT id,username FROM "user" ORDER BY id')).rows).toEqual([
      { id: 'first', username: 'user_1' },
      { id: 'second', username: 'user_2' },
      { id: 'third', username: 'user_3' },
    ]);
    const generated = await tx.query(
      'INSERT INTO "user"(id,name) VALUES ($1,$2) RETURNING username',
      ['default', 'Default'],
    );
    expect(generated.rows[0]?.username).toMatch(/^user_[a-f0-9]{32}$/);
    await expect(
      tx.query('INSERT INTO "user"(id,name,username) VALUES ($1,$2,$3)', [
        'duplicate',
        'Other name',
        'user_1',
      ]),
    ).rejects.toMatchObject({ code: '23505', constraint: 'identity_username_unique' });
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
    await database.destroy();
  }
});
