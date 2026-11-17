import { randomUUID } from 'node:crypto';
import { DomainError, SecretCodec } from '@nickhosting/core';
import { createTestDatabase } from '@nickhosting/database/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SatisfactoryApi } from '../../../games/satisfactory/src/api.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { resolveSatisfactoryBootstrapApi, storeSatisfactoryApiToken } from './satisfactory-api.js';
import {
  assertSatisfactorySetupRetry,
  deleteSatisfactorySetup,
  finalizeSatisfactorySetup,
  persistSatisfactorySetup,
  satisfactoryCreationHashInput,
} from './satisfactory-setup.js';

vi.mock('./satisfactory-api.js', () => ({
  resolveSatisfactoryBootstrapApi: vi.fn(),
  storeSatisfactoryApiToken: vi.fn(async () => {}),
}));
let database: Awaited<ReturnType<typeof createTestDatabase>>;
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 53) } });
const setup = { adminPassword: ' private admin ', clientPassword: 'private client' };
const applicationToken = `${Buffer.from(JSON.stringify({ pl: 'APIToken' })).toString('base64')}.${'a'.repeat(128)}`;
const native = {
  passwordlessLogin: vi.fn(async () => 'initial'),
  passwordLogin: vi.fn(async () => 'administrator'),
  claim: vi.fn(async () => 'administrator'),
  setClientPassword: vi.fn(async () => {}),
  generateApplicationToken: vi.fn(async () => applicationToken),
  state: vi.fn(async () => ({})),
};
beforeAll(async () => {
  database = await createTestDatabase();
});
afterAll(async () => {
  await database?.destroy();
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveSatisfactoryBootstrapApi).mockResolvedValue(
    native as unknown as SatisfactoryApi,
  );
});
async function fixture(persist = true) {
  const id = randomUUID();
  const name = `satisfactory.initial-setup.${id}`;
  if (persist) await persistSatisfactorySetup(database.db, codec, id, 'Test factory', setup);
  const context = {
    db: database.db,
    server: { id },
    authorize: vi.fn(async () => {}),
  } as unknown as GameLifecycleContext;
  return {
    id,
    name,
    context,
    read: () =>
      database.db
        .selectFrom('encrypted_secrets')
        .select('envelope')
        .where('name', '=', name)
        .executeTakeFirst(),
  };
}
describe('optional native first-run setup', () => {
  it('skip has no native authentication, claim or token effects', async () => {
    const f = await fixture(false);
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(true);
    expect(resolveSatisfactoryBootstrapApi).not.toHaveBeenCalled();
  });
  it('claims once, verifies and stores the application token, then erases setup passwords', async () => {
    const f = await fixture();
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(true);
    expect(native.passwordlessLogin).toHaveBeenCalledWith('InitialAdmin');
    expect(native.claim).toHaveBeenCalledWith('Test factory', setup.adminPassword);
    expect(native.setClientPassword).toHaveBeenCalledWith(setup.clientPassword);
    expect(native.state).toHaveBeenCalledOnce();
    expect(await f.read()).toBeUndefined();
    expect(storeSatisfactoryApiToken).toHaveBeenCalledWith(
      expect.anything(),
      codec,
      f.id,
      applicationToken,
    );
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(true);
    expect(native.claim).toHaveBeenCalledOnce();
    await assertSatisfactorySetupRetry(database.db, codec, f.id, setup);
    await expect(
      assertSatisfactorySetupRetry(database.db, codec, f.id, {
        ...setup,
        adminPassword: 'changed',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('keeps setup encrypted while native startup is pending', async () => {
    const f = await fixture();
    native.passwordlessLogin.mockRejectedValueOnce(new DomainError('game_not_ready'));
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(false);
    expect(JSON.stringify(await f.read())).not.toContain(setup.adminPassword);
    expect(native.claim).not.toHaveBeenCalled();
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(true);
  });
  it('recovers a lost claim response with the requested password without claiming twice', async () => {
    const f = await fixture();
    native.claim.mockRejectedValueOnce(new DomainError('integration_unavailable'));
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(false);
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(true);
    expect(native.passwordLogin).toHaveBeenCalledWith(setup.adminPassword);
    expect(native.claim).toHaveBeenCalledOnce();
  });
  it('resumes a recorded claim intent when dispatch had not yet occurred', async () => {
    const f = await fixture();
    await database.db
      .updateTable('encrypted_secrets')
      .set({
        envelope: codec.encrypt(
          JSON.stringify({
            setup,
            serverName: 'Test factory',
            phase: 'claiming',
            startedAt: Date.now(),
          }),
          f.name,
        ),
      })
      .where('name', '=', f.name)
      .execute();
    native.passwordLogin.mockRejectedValueOnce(new DomainError('game_authentication_failed'));
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(true);
    expect(native.passwordlessLogin).toHaveBeenCalledWith('InitialAdmin');
    expect(native.claim).toHaveBeenCalledOnce();
  });
  it('does not adopt or reset a server claimed outside this setup request', async () => {
    const f = await fixture();
    native.passwordlessLogin.mockRejectedValueOnce(new DomainError('game_authentication_failed'));
    await expect(finalizeSatisfactorySetup(f.context, codec)).rejects.toMatchObject({
      code: 'game_setup_conflict',
    });
    expect(native.passwordLogin).not.toHaveBeenCalled();
    expect(native.claim).not.toHaveBeenCalled();
    expect(await f.read()).toBeUndefined();
  });
  it('resumes token verification without generating another application token', async () => {
    const f = await fixture();
    native.state.mockRejectedValueOnce(new DomainError('integration_unavailable'));
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(false);
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(true);
    expect(native.generateApplicationToken).toHaveBeenCalledOnce();
    expect(native.setClientPassword).toHaveBeenCalledOnce();
  });
  it('bounds startup waiting and discards expired credentials without disabling server starts', async () => {
    const f = await fixture();
    await database.db
      .updateTable('encrypted_secrets')
      .set({
        envelope: codec.encrypt(
          JSON.stringify({
            setup,
            serverName: 'Test factory',
            phase: 'pending',
            startedAt: Date.now() - 600001,
          }),
          f.name,
        ),
      })
      .where('name', '=', f.name)
      .execute();
    await expect(finalizeSatisfactorySetup(f.context, codec)).rejects.toMatchObject({
      code: 'game_not_ready',
    });
    expect(await f.read()).toBeUndefined();
    expect(await finalizeSatisfactorySetup(f.context, codec)).toBe(true);
  });
  it('removes only setup-owned secrets on confirmed server deletion', async () => {
    const f = await fixture();
    const other = await fixture();
    await deleteSatisfactorySetup(database.db, f.id);
    expect(await f.read()).toBeUndefined();
    expect(await other.read()).toBeDefined();
    await expect(
      assertSatisfactorySetupRetry(database.db, codec, f.id, setup),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('excludes secrets and derived password hashes from public idempotency input', () => {
    const input = { name: 'Test', satisfactory: { branch: 'public', autoUpdate: true, setup } };
    expect(satisfactoryCreationHashInput(input)).toEqual({
      name: 'Test',
      satisfactory: { branch: 'public', autoUpdate: true, setup: true },
    });
    expect(
      satisfactoryCreationHashInput({
        ...input,
        satisfactory: { ...input.satisfactory, setup: { adminPassword: 'changed' } },
      }),
    ).toEqual(satisfactoryCreationHashInput(input));
  });
});
