import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AuthContext,
  assertConfigWritable,
  assertPermission,
  assertPublicUrls,
  createLogger,
  DomainError,
  encryptionKeyFromBase64,
  hasPermission,
  type LogRecord,
  parseSecretEnvironment,
  redact,
  resolveConfig,
  SecretCodec,
  safeError,
} from './index.js';

describe('typed configuration', () => {
  it('resolves inherited idle defaults with environment precedence and rejects invalid timeouts', () => {
    expect(resolveConfig().values.gameIdleTimeouts).toEqual({});
    expect(resolveConfig().values.defaultIdleTimeoutSeconds).toBe(-1);
    expect(resolveConfig().values.idleTimeoutUserAccess).toBe('hidden');
    expect(
      resolveConfig(
        {},
        { NH_DEFAULT_IDLE_TIMEOUT_SECONDS: '600', NH_IDLE_TIMEOUT_USER_ACCESS: 'shorten-only' },
      ).values,
    ).toMatchObject({ defaultIdleTimeoutSeconds: 600, idleTimeoutUserAccess: 'shorten-only' });
    const stored = {
      'minecraft-java': { gameTimeoutSeconds: 600, runtimeTimeouts: { vanilla: 120 } },
    };
    const environment = { 'minecraft-java': { gameTimeoutSeconds: -1, runtimeTimeouts: {} } };
    expect(resolveConfig({ gameIdleTimeouts: stored }).values.gameIdleTimeouts).toMatchObject(
      stored,
    );
    const resolved = resolveConfig(
      { gameIdleTimeouts: stored },
      { NH_GAME_IDLE_TIMEOUTS: JSON.stringify(environment) },
    );
    expect(resolved.values.gameIdleTimeouts).toMatchObject(environment);
    expect(() => assertConfigWritable({ gameIdleTimeouts: stored }, resolved)).toThrow('conflict');
    for (const invalid of [0, -2, 604801, 1.5])
      expect(() =>
        resolveConfig({
          gameIdleTimeouts: { test: { gameTimeoutSeconds: invalid, runtimeTimeouts: {} } },
        }),
      ).toThrow('configuration_invalid');
  });
  it('supplies a public metadata client identity while preserving Owner and environment overrides', () => {
    expect(resolveConfig().values.minecraftMetadataUserAgent).toContain(
      'https://github.com/ImJstNickDev/nickhosting-panel',
    );
    const owner = 'OwnerClient/1.0 (+https://example.test)';
    const env = 'EnvironmentClient/1.0 (+https://example.test)';
    expect(
      resolveConfig({ minecraftMetadataUserAgent: owner }).values.minecraftMetadataUserAgent,
    ).toBe(owner);
    expect(
      resolveConfig(
        { minecraftMetadataUserAgent: owner },
        { NH_MINECRAFT_METADATA_USER_AGENT: env },
      ).values.minecraftMetadataUserAgent,
    ).toBe(env);
  });
  it('disables total count limits by default while preserving independent pending-work safeguards', () => {
    expect(resolveConfig().values.maxServersPerUser).toBeNull();
    expect(resolveConfig().values.maxConcurrentProvisionsPerUser).toBe(4);
    expect(resolveConfig({ maxServersPerUser: 7 }).values.maxServersPerUser).toBe(7);
    const unlimited = resolveConfig({ maxServersPerUser: 7 }, { NH_MAX_SERVERS_PER_USER: 'null' });
    expect(unlimited.values.maxServersPerUser).toBeNull();
    expect(unlimited.lockedKeys).toContain('maxServersPerUser');
    expect(() => assertConfigWritable({ maxServersPerUser: 9 }, unlimited)).toThrow('conflict');
    expect(
      resolveConfig(
        { maxServersPerUser: null },
        { NH_MAX_SERVERS_PER_USER: '31', NH_MAX_CONCURRENT_PROVISIONS_PER_USER: '2' },
      ).values,
    ).toMatchObject({ maxServersPerUser: 31, maxConcurrentProvisionsPerUser: 2 });
    for (const value of ['0', '-1', '', 'off', 'false', '1.5', '10001'])
      expect(() => resolveConfig({}, { NH_MAX_SERVERS_PER_USER: value })).toThrow(
        'configuration_invalid',
      );
  });
  it('isolates upload origins from download origins and honors database/environment precedence', () => {
    const config = resolveConfig(
      { pterodactylUploadOrigins: ['https://upload.example.test'] },
      { NH_PTERODACTYL_UPLOAD_ORIGINS: '["https://override.example.test"]' },
    );
    expect(config.values.pterodactylUploadOrigins).toEqual(['https://override.example.test']);
    expect(config.values.pterodactylDownloadOrigins).toEqual([]);
    expect(config.lockedKeys).toContain('pterodactylUploadOrigins');
    for (const value of [
      'file:///private',
      'https://user:secret@example.test',
      'https://example.test/path',
      'https://example.test?token=secret',
    ])
      expect(() =>
        resolveConfig({}, { NH_PTERODACTYL_UPLOAD_ORIGINS: JSON.stringify([value]) }),
      ).toThrow('configuration_invalid');
  });

  it('accepts an explicit canonical Unix socket with normal settings precedence and locking', () => {
    expect(resolveConfig().values.dockerObserverSocket).toBeUndefined();
    const config = resolveConfig(
      { dockerObserverSocket: '/fixture/database-observer.sock' },
      { NH_DOCKER_OBSERVER_SOCKET: '/fixture/environment-observer.sock' },
    );
    expect(config.values.dockerObserverSocket).toBe('/fixture/environment-observer.sock');
    expect(config.sources.dockerObserverSocket).toBe('environment');
    expect(config.lockedKeys).toContain('dockerObserverSocket');
    expect(() =>
      assertConfigWritable({ dockerObserverSocket: '/fixture/other.sock' }, config),
    ).toThrow('conflict');
  });
  it.each([
    '',
    'docker.sock',
    'unix:///fixture/docker.sock',
    'tcp://example.test:2375',
    '/',
    '/fixture/../docker.sock',
    '/fixture/./docker.sock',
    '//fixture/docker.sock',
    '/fixture/docker.sock/',
    '/fixture/docker.sock\0',
    '/fixture/docker.sock\n',
    '/fixture/docker.sock\t',
    '/fixture/docker.sock\x7f',
    '/fixture/docker.sock?target=other',
    '/fixture/docker.sock#fragment',
  ])('rejects observer socket %j before saving or resolving it', (value) => {
    expect(() => resolveConfig({ dockerObserverSocket: value })).toThrow('configuration_invalid');
    expect(() => resolveConfig({}, { NH_DOCKER_OBSERVER_SOCKET: value })).toThrow(
      'configuration_invalid',
    );
    expect(() => assertConfigWritable({ dockerObserverSocket: value }, resolveConfig())).toThrow(
      'configuration_invalid',
    );
  });
  it('accepts only exact protocol-scoped origins for privileged provider streams', () => {
    expect(
      resolveConfig({}, { NH_PTERODACTYL_WEBSOCKET_ORIGINS: '["wss://wings.example.test"]' }).values
        .pterodactylWebSocketOrigins,
    ).toEqual(['wss://wings.example.test']);
    for (const origin of [
      'https://wings.example.test',
      'wss://user:secret@wings.example.test',
      'wss://wings.example.test/path',
      'wss://wings.example.test?token=value',
    ]) {
      expect(() =>
        resolveConfig({}, { NH_PTERODACTYL_WEBSOCKET_ORIGINS: JSON.stringify([origin]) }),
      ).toThrow('configuration_invalid');
    }
    expect(() =>
      resolveConfig({}, { NH_PTERODACTYL_DOWNLOAD_ORIGINS: '["file:///tmp/file"]' }),
    ).toThrow('configuration_invalid');
  });
  it('resolves defaults then DB then only explicit environment values with provenance', () => {
    const config = resolveConfig(
      { instanceName: 'Owner instance', smtpSecure: true, smtpPort: 2525 },
      {
        NH_INSTANCE_NAME: 'Environment instance',
        SMTP_SECURE: 'false',
        SMTP_PORT: undefined,
      },
    );
    expect(config.values.instanceName).toBe('Environment instance');
    expect(config.values.smtpSecure).toBe(false);
    expect(config.values.smtpPort).toBe(2525);
    expect(config.values.defaultLocale).toBe('en');
    expect(config.sources).toMatchObject({
      instanceName: 'environment',
      smtpSecure: 'environment',
      smtpPort: 'database',
      defaultLocale: 'default',
    });
    expect(config.lockedKeys).toEqual(['instanceName', 'smtpSecure']);
    expect(() => assertConfigWritable({ smtpSecure: true }, config)).toThrow('conflict');
    expect(() => assertConfigWritable({ smtpPort: 587 }, config)).not.toThrow();
  });

  it('does not synthesize instance URLs and requires them when starting a public API', () => {
    expect(resolveConfig().values.publicUrl).toBeUndefined();
    expect(() => assertPublicUrls(resolveConfig().values)).toThrow('configuration_invalid');
    expect(() =>
      assertPublicUrls(
        resolveConfig(
          {},
          { NH_PUBLIC_URL: 'http://localhost:3000', NH_API_URL: 'http://localhost:3001' },
        ).values,
      ),
    ).not.toThrow();
  });

  it.each(['', ' ', '0', '587.5', '587garbage', '1e2', '-1', '65536'])(
    'rejects invalid numeric override %j',
    (value) => {
      expect(() => resolveConfig({}, { SMTP_PORT: value })).toThrow('configuration_invalid');
    },
  );
  it.each(['', 'falsey', 'False', 'yes'])('rejects invalid bool override %j', (value) => {
    expect(() => resolveConfig({}, { SMTP_SECURE: value })).toThrow('configuration_invalid');
  });
  it.each(['false', '0'])('honors explicit false %s', (value) => {
    expect(resolveConfig({ smtpSecure: true }, { SMTP_SECURE: value }).values.smtpSecure).toBe(
      false,
    );
  });
  it('rejects secret/unknown DB keys, invalid URLs and incoherent TTLs without echoing values', () => {
    for (const input of [
      { password: 'private-value' },
      { publicUrl: 'javascript:alert(1)' },
      { publicUrl: 'https://user:pass@example.com' },
      { supportIdleTtlSeconds: 900, supportAbsoluteTtlSeconds: 60 },
    ]) {
      expect(() => resolveConfig(input)).toThrow('configuration_invalid');
    }
    try {
      resolveConfig({ instanceName: '' });
    } catch (error) {
      expect(safeError(error)).toEqual({
        code: 'configuration_invalid',
        messageKey: 'errors.configuration_invalid',
        status: 400,
      });
    }
  });
});

describe('authenticated secret storage', () => {
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const codec = new SecretCodec({ activeKeyId: 'v1', keys: { v1: oldKey } });
  it('encrypts nondeterministically and decrypts with a stable context', () => {
    const first = codec.encrypt('synthetic-secret', 'pterodactyl.application-key');
    const second = codec.encrypt('synthetic-secret', 'pterodactyl.application-key');
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(JSON.stringify(first)).not.toContain('synthetic-secret');
    expect(codec.decrypt(first, 'pterodactyl.application-key')).toBe('synthetic-secret');
    expect(() => codec.decrypt(first, 'pterodactyl.client-key')).toThrow('secret_invalid');
  });
  it('rejects every tampered envelope component and wrong keys', () => {
    const envelope = codec.encrypt('value', 'record-id');
    for (const field of ['iv', 'ciphertext', 'tag'] as const) {
      const bytes = Buffer.from(envelope[field], 'base64');
      bytes[0] = (bytes[0] ?? 0) ^ 1;
      expect(() =>
        codec.decrypt({ ...envelope, [field]: bytes.toString('base64') }, 'record-id'),
      ).toThrow('secret_invalid');
    }
    expect(() => codec.decrypt({ ...envelope, version: 2 }, 'record-id')).toThrow('secret_invalid');
    expect(() => codec.decrypt({ ...envelope, keyId: 'unknown' }, 'record-id')).toThrow(
      'secret_invalid',
    );
    expect(() => codec.decrypt({ ...envelope, tag: 'not base64' }, 'record-id')).toThrow(
      'secret_invalid',
    );
    expect(() =>
      new SecretCodec({ activeKeyId: 'v1', keys: { v1: newKey } }).decrypt(envelope, 'record-id'),
    ).toThrow('secret_invalid');
  });
  it('supports key rotation and authenticates the key identifier', () => {
    const envelope = codec.encrypt('old-value', 'record-id');
    const rotated = new SecretCodec({ activeKeyId: 'v2', keys: { v1: oldKey, v2: newKey } });
    expect(rotated.decrypt(envelope, 'record-id')).toBe('old-value');
    expect(rotated.encrypt('new-value', 'record-id').keyId).toBe('v2');
    const alias = new SecretCodec({ activeKeyId: 'alias', keys: { v1: oldKey, alias: oldKey } });
    expect(() => alias.decrypt({ ...envelope, keyId: 'alias' }, 'record-id')).toThrow(
      'secret_invalid',
    );
  });
  it('validates key sizes/canonical base64 and startup secret requirements', () => {
    expect(() => encryptionKeyFromBase64('not-base64')).toThrow();
    expect(() => encryptionKeyFromBase64(randomBytes(31).toString('base64'))).toThrow();
    expect(() => new SecretCodec({ activeKeyId: 'missing', keys: { good: oldKey } })).toThrow();
    const env = {
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      NH_SECRETS_MASTER_KEY: oldKey.toString('base64'),
    };
    expect(parseSecretEnvironment(env).masterKey.equals(oldKey)).toBe(true);
    expect(() => parseSecretEnvironment(env, { requireSetupToken: true })).toThrow(
      'configuration_invalid',
    );
    expect(() => parseSecretEnvironment({ ...env, NH_SETUP_TOKEN: 'short' })).toThrow(
      'configuration_invalid',
    );
    expect(() => parseSecretEnvironment({ ...env, NH_SECRETS_MASTER_KEY: 'invalid' })).toThrow(
      'configuration_invalid',
    );
  });
});

describe('structured error and logging safety', () => {
  it('redacts nested secrets, cookies, URLs, provider tokens, buffers and raw errors', () => {
    const result = JSON.stringify(
      redact({
        password: 'private-password',
        nested: { Authorization: 'private-header', smtpPassword: 'private-smtp' },
        url: 'postgres://user:private-db@example.com/db',
        callback: 'https://example.com/callback?code=private-code&state=private-state',
        link: 'https://example.com/invite/private-invite',
        error: new Error('private-error'),
        text: 'Bearer private-bearer',
        data: Buffer.from('private-buffer'),
        email: 'private-email@example.com',
        recoveryCodes: ['private-recovery'],
      }),
    );
    expect(result).not.toContain('private-');
    expect(result).toContain('[REDACTED]');
    expect(safeError(new Error('private-error'))).toMatchObject({ code: 'internal_error' });
    expect(
      safeError(new DomainError('forbidden', 403, { password: 'private' })),
    ).not.toHaveProperty('details');
  });
  it('handles cycles and filters logs with fixed event names', () => {
    const data: Record<string, unknown> = {};
    data.self = data;
    expect(redact(data)).toEqual({ self: '[Circular]' });
    const records: LogRecord[] = [];
    const logger = createLogger((record) => records.push(record), { now: () => new Date(0) });
    logger.log('debug', 'event.debug');
    logger.log('warn', 'auth.failure', { token: 'private' });
    expect(records).toEqual([
      {
        time: '1970-01-01T00:00:00.000Z',
        level: 'warn',
        event: 'auth.failure',
        data: { token: '[REDACTED]' },
      },
    ]);
    expect(() => logger.log('info', 'user-supplied token value')).toThrow();
  });
});

describe('actor/subject permissions', () => {
  const user: AuthContext = {
    actorUserId: 'user',
    subjectUserId: 'user',
    role: 'user',
    sessionType: 'regular',
    ownerElevation: false,
  };
  const owner: AuthContext = {
    ...user,
    actorUserId: 'owner',
    subjectUserId: 'owner',
    role: 'owner',
  };
  const now = new Date('2026-01-01T00:05:00Z');
  const support: AuthContext = {
    ...owner,
    subjectUserId: 'user',
    sessionType: 'support',
    ownerElevation: true,
    support: {
      id: 'support-id',
      reason: 'Account assistance',
      startedAt: new Date('2026-01-01T00:00:00Z'),
      lastActivityAt: new Date('2026-01-01T00:04:00Z'),
      expiresAt: new Date('2026-01-01T00:15:00Z'),
      revokedAt: null,
    },
  };
  it('denies IDOR and enforces server membership actions', () => {
    expect(hasPermission(user, 'server:read', { ownerUserId: 'other' })).toBe(false);
    expect(hasPermission(user, 'server:read', { ownerUserId: 'other', memberRole: 'viewer' })).toBe(
      true,
    );
    expect(
      hasPermission(user, 'server:operate', { ownerUserId: 'other', memberRole: 'viewer' }),
    ).toBe(false);
    expect(
      hasPermission(user, 'server:operate', { ownerUserId: 'other', memberRole: 'operator' }),
    ).toBe(true);
    expect(
      hasPermission(user, 'server:manage', { ownerUserId: 'other', memberRole: 'operator' }),
    ).toBe(false);
    expect(hasPermission(user, 'server:manage', { ownerUserId: 'user' })).toBe(true);
    expect(hasPermission(user, 'platform:manage')).toBe(false);
    expect(hasPermission(owner, 'platform:manage')).toBe(true);
  });
  it('grants support elevation only to its validated Owner session', () => {
    expect(hasPermission(support, 'platform:manage', undefined, { now })).toBe(true);
    expect(hasPermission(user, 'platform:manage', undefined, { now })).toBe(false);
    expect(hasPermission({ ...user, ownerElevation: true }, 'platform:manage')).toBe(false);
    expect(hasPermission({ ...owner, subjectUserId: 'user' }, 'platform:manage')).toBe(false);
    expect(hasPermission({ ...support, role: 'user' }, 'platform:manage', undefined, { now })).toBe(
      false,
    );
  });
  it('expires support by idle/absolute TTL, revocation and invalid timestamps', () => {
    if (!support.support) throw new Error('missing fixture');
    for (const patch of [
      { revokedAt: now },
      { lastActivityAt: new Date('2026-01-01T00:00:00Z') },
      { expiresAt: now },
      { startedAt: new Date('2026-01-01T00:06:00Z') },
      { lastActivityAt: new Date('2026-01-01T00:06:00Z') },
    ])
      expect(
        hasPermission(
          { ...support, support: { ...support.support, ...patch } },
          'platform:manage',
          undefined,
          { now },
        ),
      ).toBe(false);
    expect(() =>
      assertPermission(support, 'platform:manage', undefined, {
        now,
        supportAbsoluteTtlSeconds: 300,
      }),
    ).toThrow('support_expired');
  });
});
