import { createHash } from 'node:crypto';
import { createIdentity, type Identity, type IdentityMail } from '@nickhosting/auth';
import {
  assertPublicUrls,
  createLogger,
  DomainError,
  parseSecretEnvironment,
  SecretCodec,
} from '@nickhosting/core';
import {
  createDatabase,
  getSecret,
  getSettings,
  saveBootstrapConfiguration,
} from '@nickhosting/database';
import { renderMail } from '@nickhosting/i18n';
import { validateConnection } from '@nickhosting/pterodactyl-adapter';
import { createTransport } from 'nodemailer';
import { createApp } from './app.js';

/** Explicit factory: importing API modules never opens sockets or changes the DB. */
export async function createRuntime(env: Readonly<Record<string, string | undefined>>) {
  if (!env.DATABASE_URL) throw new DomainError('configuration_invalid');
  const database = createDatabase(env.DATABASE_URL);
  try {
    const setup = await database.pool.query('SELECT id FROM instance_setup WHERE id=1');
    const secrets = parseSecretEnvironment(env, { requireSetupToken: setup.rowCount === 0 });
    const codec = new SecretCodec({
      activeKeyId: secrets.masterKeyId,
      keys: { [secrets.masterKeyId]: secrets.masterKey },
    });
    const initial = await getSettings(database.db, env);
    assertPublicUrls(initial.values);
    const logger = createLogger((record) => process.stdout.write(`${JSON.stringify(record)}\n`), {
      level: initial.values.logLevel,
    });
    let cached: { signature: string; identity: Identity } | undefined;
    const sendMail = async (message: IdentityMail) => {
      if (message.to.endsWith('.invalid')) return;
      const { values } = await getSettings(database.db, env);
      if (!values.smtpHost || !values.smtpFrom) throw new DomainError('integration_unavailable');
      const smtpPassword = await getSecret(database.db, codec, 'smtpPassword', env);
      if (Boolean(values.smtpUser) !== Boolean(smtpPassword))
        throw new DomainError('configuration_invalid');
      const transport = createTransport({
        host: values.smtpHost,
        port: values.smtpPort,
        secure: values.smtpSecure,
        requireTLS: !values.smtpSecure,
        connectionTimeout: 5000,
        socketTimeout: 10000,
        ...(values.smtpUser && smtpPassword
          ? { auth: { user: values.smtpUser, pass: smtpPassword } }
          : {}),
      });
      const content = renderMail({
        kind:
          message.template === 'reset-password'
            ? 'reset'
            : message.template === 'link-email'
              ? 'link'
              : 'verify',
        locale: message.locale,
        url: message.url,
        instanceName: values.instanceName,
      });
      try {
        await transport.sendMail({ from: values.smtpFrom, to: message.to, ...content });
      } catch {
        throw new DomainError('integration_unavailable');
      } finally {
        transport.close();
      }
    };
    const identity = async () => {
      const { values } = await getSettings(database.db, env);
      assertPublicUrls(values);
      // Server-only digest invalidates the instance when DB-backed provider settings change.
      const discordSecret = await getSecret(database.db, codec, 'discordClientSecret', env);
      // Optional provider stays disabled until both independently saved fields exist.
      const signature = createHash('sha256')
        .update(JSON.stringify({ values, discordSecret }))
        .digest('hex');
      if (cached?.signature === signature) return cached.identity;
      const value = createIdentity({
        pool: database.pool,
        baseURL: values.apiUrl,
        publicURL: values.publicUrl,
        authSecret: secrets.authSecret,
        bootstrapToken: secrets.setupToken,
        mail: sendMail,
        sessionTtlSeconds: values.sessionTtlSeconds,
        registrationInviteTtlSeconds: values.registrationInviteTtlSeconds,
        defaultLocale: values.defaultLocale,
        supportIdleTtlSeconds: values.supportIdleTtlSeconds,
        supportAbsoluteTtlSeconds: values.supportAbsoluteTtlSeconds,
        ...(values.discordClientId && discordSecret
          ? { discord: { clientId: values.discordClientId, clientSecret: discordSecret } }
          : {}),
        completeSetup: async (tx, input, actorUserId) => {
          await validateConnection({
            baseURL: env.NH_PTERODACTYL_BASE_URL ?? input.pterodactylBaseURL,
            applicationKey: env.NH_PTERODACTYL_APPLICATION_KEY ?? input.pterodactylApplicationKey,
            clientKey: env.NH_PTERODACTYL_CLIENT_KEY ?? input.pterodactylClientKey,
          });
          await saveBootstrapConfiguration(tx, codec, input, actorUserId, env);
        },
      });
      cached = { signature, identity: value };
      return value;
    };
    const app = createApp({
      database,
      codec,
      defaultLocale: async () => (await getSettings(database.db, env)).values.defaultLocale,
      identity,
      env,
      origins: async () => {
        const { values } = await getSettings(database.db, env);
        assertPublicUrls(values);
        return [new URL(values.apiUrl).origin, new URL(values.publicUrl).origin];
      },
      log: (data) => logger.log('warn', 'api.request_failed', data),
    });
    return { app, database, logger, config: initial.values, close: () => database.db.destroy() };
  } catch (error) {
    await database.db.destroy();
    throw error;
  }
}
