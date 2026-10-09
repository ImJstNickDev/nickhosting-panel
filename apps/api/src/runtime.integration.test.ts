import { randomBytes } from 'node:crypto';
import { createIdentity, type IdentityMail } from '@nickhosting/auth';
import { createTestDatabase } from '@nickhosting/database/testing';
import { translate } from '@nickhosting/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthClient } from '../../../packages/auth/src/test-fixtures.js';
import { createRuntime } from './runtime.js';

describe('runtime uses live Owner configuration', () => {
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let runtime: Awaited<ReturnType<typeof createRuntime>>;
  let owner: AuthClient;
  beforeAll(async () => {
    database = await createTestDatabase();
    const secret = randomBytes(32).toString('base64url');
    const bootstrap = randomBytes(32).toString('base64url');
    const mails: IdentityMail[] = [];
    const identity = createIdentity({
      pool: database.pool,
      baseURL: 'http://localhost:3999',
      authSecret: secret,
      bootstrapToken: bootstrap,
      mail: async (message) => {
        mails.push(message);
      },
      completeSetup: async () => {
        throw new Error('Not called by config test');
      },
    });
    await identity.claimOwner({
      token: bootstrap,
      name: 'Owner',
      email: 'runtime-owner@example.com',
      password: 'Fixture-strong-password-413!',
    });
    owner = new AuthClient(identity);
    const mail = mails[0];
    if (!mail) throw new Error('Missing fixture email');
    await owner.request(`/verify-email${new URL(mail.url).search}`);
    await owner.request('/sign-in/email', {
      email: 'runtime-owner@example.com',
      password: 'Fixture-strong-password-413!',
    });
    const url = new URL(process.env.NH_TEST_DATABASE_URL ?? '');
    url.searchParams.set('options', `-c search_path=${database.schema}`);
    runtime = await createRuntime({
      DATABASE_URL: url.href,
      BETTER_AUTH_SECRET: secret,
      NH_SECRETS_MASTER_KEY: randomBytes(32).toString('base64'),
      NH_API_URL: 'http://localhost:3999',
      NH_PUBLIC_URL: 'http://localhost:4000',
    });
  });
  afterAll(async () => {
    if (runtime) await runtime.close();
    if (database) await database.destroy();
  });
  async function write(path: string, value: unknown, method = 'PATCH') {
    const headers = owner.headers();
    headers.set('content-type', 'application/json');
    headers.set('origin', 'http://localhost:4000');
    return runtime.app.request(`http://localhost:3999${path}`, {
      method,
      headers,
      body: JSON.stringify(value),
    });
  }
  it('allows saving optional Discord ID then secret without locking out the Owner', async () => {
    expect((await write('/v1/owner/settings', { discordClientId: 'fixture-discord' })).status).toBe(
      200,
    );
    expect(
      (await runtime.app.request('http://localhost:3999/v1/me', { headers: owner.headers() }))
        .status,
    ).toBe(200);
    expect(
      (
        await write(
          '/v1/owner/secrets/discordClientSecret',
          { value: randomBytes(32).toString('base64url') },
          'PUT',
        )
      ).status,
    ).toBe(204);
    const response = await runtime.app.request('http://localhost:3999/v1/owner/settings', {
      headers: owner.headers(),
    });
    expect(response.status).toBe(200);
    const settings = await response.json();
    expect(settings.config.values.discordClientId).toBe('fixture-discord');
    expect(
      settings.secrets.find((entry: { name: string }) => entry.name === 'discordClientSecret')
        .configured,
    ).toBe(true);
  });
  it('uses Owner default locale for anonymous responses and stored preference before browser hints', async () => {
    expect((await write('/v1/owner/settings', { defaultLocale: 'it' })).status).toBe(200);
    const anonymous = await runtime.app.request(
      'http://localhost:3999/v1/invitations/invalid-fixture-token-long',
    );
    const anonymousError = await anonymous.json();
    expect(anonymousError.error.message).toBe(translate('it', 'errors.invitation_invalid'));
    const oauth = await runtime.app.request(
      'http://localhost:3999/api/auth/error?error=INVITATION_INVALID',
    );
    expect((await oauth.json()).error.message).toBe(translate('it', 'errors.invitation_invalid'));
    expect((await write('/api/auth/update-user', { locale: 'it' }, 'POST')).status).toBe(200);
    const headers = owner.headers();
    headers.set('accept-language', 'en');
    headers.set('origin', 'http://localhost:4000');
    headers.set('content-type', 'application/json');
    const rejected = await runtime.app.request('http://localhost:3999/v1/owner/settings', {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ unknown: true }),
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.message).toBe(
      translate('it', 'errors.configuration_invalid'),
    );
  });
});
