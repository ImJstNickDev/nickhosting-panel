// Execute from the project root with node --import tsx; never prints credentials.
import { randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const load = (path) => import(pathToFileURL(`${process.cwd()}/${path}`).href);
if (!process.argv.includes('--owner-approved'))
  throw new Error('Explicit bridge activation approval required');
const { containerEnvironment } = await load('deploy/container-env.mjs');
const { createDatabase, getSettings, getSecret } = await load('packages/database/src/index.ts');
const { SecretCodec, encryptionKeyFromBase64 } = await load('packages/core/src/index.ts');
const { registerProviderFeed } = await load(
  'packages/server-management/src/provider-change-feed.ts',
);
const { createNickHostingBridge, discoverNickHostingExtension } = await load(
  'packages/pterodactyl-adapter/src/blueprint.ts',
);
const env = containerEnvironment(process.env);
const { db, pool } = createDatabase(env.DATABASE_URL);
try {
  const keyId = env.NH_SECRETS_KEY_ID ?? 'primary';
  const codec = new SecretCodec({
    activeKeyId: keyId,
    keys: { [keyId]: encryptionKeyFromBase64(env.NH_SECRETS_MASTER_KEY) },
  });
  const [{ values }, applicationKey] = await Promise.all([
    getSettings(db, env),
    getSecret(db, codec, 'pterodactylApplicationKey', env),
  ]);
  if (!applicationKey || !values.pterodactylBaseUrl)
    throw new Error('Provider configuration required');
  const options = { baseURL: values.pterodactylBaseUrl, applicationKey };
  const capabilities = await discoverNickHostingExtension(options);
  if (!capabilities?.capabilities.serverChangeEvents)
    throw new Error('Server change feed unavailable');
  const providerUrl = values.pterodactylBaseUrl.replace(/\/$/, '');
  const callbackUrl = new URL('/v1/provider-events/pterodactyl', values.publicUrl).href;
  const existing = await db
    .selectFrom('provider_change_feeds')
    .selectAll()
    .where('provider_url', '=', providerUrl)
    .executeTakeFirst();
  const instanceId = existing?.instance_id ?? randomUUID();
  const name = `blueprintWebhook:${instanceId}`;
  const previous = await db
    .selectFrom('encrypted_secrets')
    .select('envelope')
    .where('name', '=', name)
    .executeTakeFirst();
  const webhookSecret = previous
    ? codec.decrypt(previous.envelope, name)
    : randomBytes(32).toString('hex');
  // Persist the secret before a potentially ambiguous remote response; reruns reuse it.
  await db
    .insertInto('encrypted_secrets')
    .values({ name, envelope: codec.encrypt(webhookSecret, name) })
    .onConflict((c) => c.column('name').doNothing())
    .execute();
  await registerProviderFeed(db, { instanceId, providerUrl, callbackUrl });
  const registered = await createNickHostingBridge(options).registerInstance(instanceId, {
    callbackUrl,
    webhookSecret,
  });
  if (registered.instanceId !== instanceId) throw new Error('Provider identity mismatch');
  console.log(
    JSON.stringify({
      registered: true,
      instanceId,
      extensionVersion: capabilities.extensionVersion,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      registered: false,
      error: error instanceof Error ? error.name : 'Error',
      reason: error?.reason,
      status: error?.upstreamStatus,
    }),
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
