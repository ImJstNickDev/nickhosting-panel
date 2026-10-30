/** Validates explicitly scoped deployment inputs without reading environment files. */
export function containerEnvironment(input: Readonly<Record<string, string | undefined>>): Record<
  string,
  string | undefined
> & {
  NODE_ENV: 'development' | 'production';
  DATABASE_URL: string;
  REDIS_URL: string;
  BETTER_AUTH_SECRET: string;
  NH_SECRETS_MASTER_KEY: string;
  NH_SECRETS_KEY_ID: string;
  NH_SETUP_TOKEN: string;
  NH_JOB_PREFIX: string;
  NH_PUBLIC_URL: string;
  NH_API_URL: string;
  NH_API_BIND_HOST: string;
  NH_API_PORT: string;
  NH_MINECRAFT_CONTENT_ROOT: string;
  NH_MINECRAFT_SOURCE_ROOT: string;
  NH_GATEWAY_ENABLED: 'false';
};
