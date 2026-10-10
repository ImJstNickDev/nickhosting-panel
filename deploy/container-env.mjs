/** Shared by entrypoint/health checks. Never loads a host .env implicitly. */
export function containerEnvironment(input) {
  const development = input.NH_DEPLOYMENT_ENV === 'development';
  if (!development && input.NH_DEPLOYMENT_ENV !== 'production')
    throw new Error('Explicit deployment environment required');
  const prefix = development ? 'NH_DEV_' : 'NH_PROD_';
  const notDevKey = (key) => !key.startsWith('NH_DEV_');
  const required = (name, secret = false) => {
    const value = input[prefix + name];
    if (
      !value ||
      /change_me|replace_|generate_/i.test(value) ||
      (secret && (value.length < 32 || /\s/.test(value)))
    )
      throw new Error(`Invalid deployment field: ${prefix}${name}`);
    return value;
  };
  for (const field of [
    'DATABASE_URL',
    'REDIS_URL',
    'BETTER_AUTH_SECRET',
    'NH_SECRETS_MASTER_KEY',
    'NH_SETUP_TOKEN',
    'NH_JOB_PREFIX',
  ]) {
    if (input[field] !== undefined)
      throw new Error(`Use environment-scoped field instead of ${field}`);
  }
  if (input.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error('TLS verification must remain enabled');
  const url = new URL(required('PUBLIC_URL'));
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*$/.test(url.hostname)
  )
    throw new Error('Public URL must be an exact HTTPS origin on port 443');
  if (!development) {
    for (const field of ['APP_IMAGE', 'WEB_IMAGE']) {
      const image = required(field);
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(image) ||
        image.endsWith('0'.repeat(64))
      )
        throw new Error(`Immutable reviewed image required: ${prefix}${field}`);
    }
  }
  const scope = development ? 'dev' : 'prod';
  const databasePassword = required('DB_PASSWORD', true);
  const redisPassword = required('REDIS_PASSWORD', true);
  const master = required('MASTER_KEY', true);
  if (
    Buffer.from(master, 'base64').length !== 32 ||
    Buffer.from(master, 'base64').toString('base64') !== master
  )
    throw new Error('Master key must be canonical base64 for 32 random bytes');
  const auth = required('AUTH_SECRET', true);
  const setup = required('SETUP_TOKEN', true);
  if (new Set([databasePassword, redisPassword, master, auth, setup]).size !== 5)
    throw new Error('Use independent credentials per purpose');
  if (development) {
    for (const key of Object.keys(input))
      if (
        (key.startsWith('NH_') && key !== 'NH_DEPLOYMENT_ENV' && notDevKey(key)) ||
        /^(DISCORD_|SMTP_)/.test(key)
      )
        throw new Error(`External configuration prohibited in development: ${key}`);
  } else {
    for (const key of Object.keys(input))
      if (key.startsWith('NH_DEV_'))
        throw new Error('Development configuration prohibited in production');
  }
  const env = {
    ...input,
    NODE_ENV: development ? 'development' : 'production',
    DATABASE_URL: `postgresql://nickhosting_${scope}:${encodeURIComponent(databasePassword)}@postgres:5432/nickhosting_${scope}`,
    REDIS_URL: `redis://:${encodeURIComponent(redisPassword)}@redis:6379/0`,
    BETTER_AUTH_SECRET: auth,
    NH_SECRETS_MASTER_KEY: master,
    NH_SECRETS_KEY_ID: `${scope}-primary`,
    NH_SETUP_TOKEN: setup,
    NH_JOB_PREFIX: `nickhosting-${scope}`,
    NH_PUBLIC_URL: url.origin,
    NH_API_URL: url.origin,
    NH_API_BIND_HOST: '0.0.0.0',
    NH_API_PORT: '3001',
    NH_MINECRAFT_CONTENT_ROOT: './mountdata/content',
    NH_MINECRAFT_SOURCE_ROOT: './mountdata/sources',
    NH_GATEWAY_ENABLED: 'false',
  };
  if (development) {
    if (
      new Set([
        databasePassword,
        redisPassword,
        master,
        auth,
        setup,
        required('SANDBOX_TOKEN', true),
        required('MAIL_PASSWORD', true),
      ]).size !== 7
    )
      throw new Error('Use independent credentials per purpose');
    Object.assign(env, {
      NH_PTERODACTYL_BASE_URL: 'http://provider:9090',
      NH_PTERODACTYL_APPLICATION_KEY: required('SANDBOX_TOKEN', true),
      NH_PTERODACTYL_CLIENT_KEY: required('SANDBOX_TOKEN', true),
      NH_PTERODACTYL_WEBSOCKET_ORIGINS: '[]',
      NH_PTERODACTYL_DOWNLOAD_ORIGINS: '[]',
      NH_PTERODACTYL_UPLOAD_ORIGINS: '[]',
      NH_SFTPGO_BASE_URL: 'http://provider:9090',
      NH_SFTPGO_API_KEY: 'development-disabled',
      NH_CLOUDFLARE_API_TOKEN: 'development-disabled',
      NH_CURSEFORGE_API_KEY: 'development-disabled',
      SMTP_HOST: 'mailpit',
      SMTP_PORT: '1025',
      SMTP_SECURE: 'false',
      SMTP_FROM: 'NickHosting Dev <noreply@dev.example.test>',
      SMTP_USER: 'nickhosting-dev',
      SMTP_PASSWORD: required('MAIL_PASSWORD', true),
      NODE_EXTRA_CA_CERTS: '/run/dev-mail/cert.pem',
      NH_MINECRAFT_DOWNLOAD_ORIGINS: '[]',
    });
  }
  return env;
}
