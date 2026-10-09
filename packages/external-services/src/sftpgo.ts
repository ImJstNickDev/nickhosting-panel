import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { ProviderHttp } from './http.js';

const uuid = z.uuid();
const permissionList = [
  'list',
  'download',
  'upload',
  'overwrite',
  'delete',
  'rename',
  'create_dirs',
];
const deniedProtocols = ['FTP', 'DAV', 'HTTP'];
const requestSchema = z
  .object({
    serverId: uuid,
    externalServerUuid: uuid,
    credentialId: uuid,
    password: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/),
    expiresAt: z.number().int().positive(),
    quotaBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type SftpCredentialRequest = z.infer<typeof requestSchema>;
export interface SftpCredentialRef {
  instanceId: string;
  serverId: string;
  externalServerUuid: string;
  credentialId: string;
  username: string;
  externalUserId: number;
  expiresAt: number;
  quotaBytes: number;
}
const userSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  status: z.number(),
  home_dir: z.string(),
  additional_info: z.string(),
  expiration_date: z.number(),
  quota_size: z.number(),
  filesystem: z.object({ provider: z.number() }),
  virtual_folders: z.array(z.unknown()).nullish(),
  groups: z.array(z.unknown()).nullish(),
  permissions: z.record(z.string(), z.array(z.string())),
  filters: z.object({
    denied_protocols: z.array(z.string()).nullish(),
    allow_api_key_auth: z.boolean().optional(),
  }),
});
type RemoteUser = z.infer<typeof userSchema>;

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError('validation_failed');
  return result.data;
}

/** Return once to the authenticated caller; persist only encrypted if retries need it. */
export function generateSftpPassword(): string {
  return randomBytes(32).toString('base64url');
}

/** No arbitrary paths or virtual folders are accepted. The root is Owner-configured. */
export function sftpServerDirectory(dataRoot: string, externalServerUuid: string): string {
  validate(uuid, externalServerUuid);
  if (
    !posix.isAbsolute(dataRoot) ||
    dataRoot === '/' ||
    dataRoot.includes('\\') ||
    dataRoot.includes('\0') ||
    posix.normalize(dataRoot) !== dataRoot ||
    dataRoot.endsWith('/')
  )
    throw new DomainError('configuration_invalid');
  return posix.join(dataRoot, externalServerUuid.toLowerCase());
}

export class SftpGoAdapter {
  readonly #http: ProviderHttp;
  readonly #instanceId: string;
  readonly #dataRoot: string;
  readonly #now: () => number;

  constructor(input: {
    baseURL: string;
    auth: { apiKey: string } | { accessToken: string };
    instanceId: string;
    dataRoot: string;
    fetcher?: typeof fetch;
    timeoutMs?: number;
    now?: () => number;
  }) {
    this.#instanceId = validate(uuid, input.instanceId);
    this.#dataRoot = input.dataRoot;
    sftpServerDirectory(input.dataRoot, input.instanceId);
    this.#now = input.now ?? Date.now;
    const secret = 'apiKey' in input.auth ? input.auth.apiKey : input.auth.accessToken;
    if (!secret.trim() || secret.length > 8192 || /[\r\n]/.test(secret))
      throw new DomainError('configuration_invalid');
    this.#http = new ProviderHttp({
      ...input,
      headers:
        'apiKey' in input.auth
          ? { 'X-SFTPGO-API-KEY': secret }
          : { Authorization: `Bearer ${secret}` },
    });
  }

  #name(credentialId: string): string {
    return `nh_${credentialId.replaceAll('-', '').toLowerCase()}`;
  }
  #marker(
    input: Pick<SftpCredentialRequest, 'serverId' | 'externalServerUuid' | 'credentialId'>,
  ): string {
    return JSON.stringify({
      application: 'nickhosting',
      instanceId: this.#instanceId,
      serverId: input.serverId,
      externalServerUuid: input.externalServerUuid,
      credentialId: input.credentialId,
    });
  }
  #checkExpiry(expiresAt: number): void {
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= this.#now() ||
      expiresAt - this.#now() > 30 * 86_400_000
    )
      throw new DomainError('validation_failed');
  }
  #payload(
    input: Omit<SftpCredentialRequest, 'password'> & { password?: string },
    status: 0 | 1,
  ): Record<string, unknown> {
    return {
      username: this.#name(input.credentialId),
      status,
      password: input.password,
      home_dir: sftpServerDirectory(this.#dataRoot, input.externalServerUuid),
      expiration_date: input.expiresAt,
      additional_info: this.#marker(input),
      permissions: { '/': permissionList },
      public_keys: [],
      virtual_folders: [],
      groups: [],
      filesystem: { provider: 0 },
      quota_size: input.quotaBytes,
      max_sessions: 2,
      filters: {
        denied_protocols: deniedProtocols,
        allow_api_key_auth: false,
        disable_fs_checks: false,
      },
    };
  }
  async #read(username: string): Promise<RemoteUser | null> {
    const response = await this.#http.request(`api/v2/users/${encodeURIComponent(username)}`);
    if (response.status === 404) return null;
    const parsed = userSchema.safeParse(response.data);
    if (!parsed.success) throw new DomainError('integration_unavailable');
    return parsed.data;
  }
  #assertOwned(
    user: RemoteUser,
    ref: Pick<SftpCredentialRef, 'serverId' | 'externalServerUuid' | 'credentialId'> & {
      externalUserId?: number;
    },
  ): void {
    if (
      user.username !== this.#name(ref.credentialId) ||
      user.additional_info !== this.#marker(ref) ||
      user.home_dir !== sftpServerDirectory(this.#dataRoot, ref.externalServerUuid) ||
      (ref.externalUserId !== undefined && user.id !== ref.externalUserId)
    )
      throw new DomainError('conflict');
  }
  #assertIsolation(user: RemoteUser): void {
    if (
      user.filesystem.provider !== 0 ||
      user.virtual_folders?.length ||
      user.groups?.length ||
      user.filters.allow_api_key_auth ||
      Object.keys(user.permissions).length !== 1 ||
      JSON.stringify([...(user.permissions['/'] ?? [])].sort()) !==
        JSON.stringify([...permissionList].sort()) ||
      !deniedProtocols.every((protocol) => user.filters.denied_protocols?.includes(protocol))
    )
      throw new DomainError('conflict');
  }
  #checkRef(ref: SftpCredentialRef): void {
    validate(uuid, ref.serverId);
    validate(uuid, ref.externalServerUuid);
    validate(uuid, ref.credentialId);
    if (
      ref.instanceId !== this.#instanceId ||
      ref.username !== this.#name(ref.credentialId) ||
      !Number.isSafeInteger(ref.externalUserId) ||
      ref.externalUserId < 1 ||
      !Number.isSafeInteger(ref.quotaBytes) ||
      ref.quotaBytes < 1
    )
      throw new DomainError('validation_failed');
  }

  /** Persist the request's IDs and encrypted password before calling. Retries never reset an existing password. */
  async ensureCredential(value: SftpCredentialRequest): Promise<SftpCredentialRef> {
    const input = validate(requestSchema, value);
    this.#checkExpiry(input.expiresAt);
    const username = this.#name(input.credentialId);
    let user = await this.#read(username);
    if (!user) {
      try {
        const response = await this.#http.request('api/v2/users', 'POST', this.#payload(input, 1));
        if (response.status === 404) throw new DomainError('integration_unavailable');
      } catch (error) {
        // A timeout can follow successful creation. Reconcile the durable unique identity before retry.
        user = await this.#read(username);
        if (!user) throw error;
      }
      user ??= await this.#read(username);
    }
    if (!user) throw new DomainError('integration_unavailable');
    this.#assertOwned(user, input);
    this.#assertIsolation(user);
    if (
      user.status !== 1 ||
      user.expiration_date !== input.expiresAt ||
      user.quota_size !== input.quotaBytes
    )
      throw new DomainError('conflict');
    return {
      instanceId: this.#instanceId,
      serverId: input.serverId,
      externalServerUuid: input.externalServerUuid,
      credentialId: input.credentialId,
      username,
      externalUserId: user.id,
      expiresAt: input.expiresAt,
      quotaBytes: input.quotaBytes,
    };
  }

  /** Read-only recovery, including expired/disabled credentials. Never creates or re-enables an account. */
  async inspectCredential(
    input: Pick<SftpCredentialRequest, 'serverId' | 'externalServerUuid' | 'credentialId'>,
  ): Promise<SftpCredentialRef | null> {
    validate(uuid, input.serverId);
    validate(uuid, input.externalServerUuid);
    validate(uuid, input.credentialId);
    const user = await this.#read(this.#name(input.credentialId));
    if (!user) return null;
    this.#assertOwned(user, input);
    return {
      ...input,
      instanceId: this.#instanceId,
      username: user.username,
      externalUserId: user.id,
      expiresAt: user.expiration_date,
      quotaBytes: user.quota_size,
    };
  }

  async rotateCredential(
    ref: SftpCredentialRef,
    update: { password: string; expiresAt: number },
  ): Promise<SftpCredentialRef> {
    this.#checkRef(ref);
    const input = validate(requestSchema, {
      serverId: ref.serverId,
      externalServerUuid: ref.externalServerUuid,
      credentialId: ref.credentialId,
      quotaBytes: ref.quotaBytes,
      ...update,
    });
    this.#checkExpiry(input.expiresAt);
    const user = await this.#read(ref.username);
    if (!user) throw new DomainError('not_found');
    this.#assertOwned(user, ref);
    const response = await this.#http.request(
      `api/v2/users/${ref.username}?disconnect=1`,
      'PUT',
      this.#payload(input, 1),
    );
    if (response.status === 404) throw new DomainError('not_found');
    if (response.status === 409) throw new DomainError('conflict');
    return { ...ref, expiresAt: update.expiresAt };
  }

  /** Requests channel disconnection and prevents new logins. See the SSH revocation blocker in README. */
  async revokeCredential(ref: SftpCredentialRef): Promise<void> {
    this.#checkRef(ref);
    const user = await this.#read(ref.username);
    if (!user) return;
    this.#assertOwned(user, ref);
    const disabled = await this.#http.request(
      `api/v2/users/${ref.username}?disconnect=1`,
      'PUT',
      this.#payload(ref, 0),
    );
    if (disabled.status === 404) return;
    if (disabled.status === 409) throw new DomainError('conflict');
    // The data directory is deliberately retained; credential revocation never deletes game data.
    const deleted = await this.#http.request(`api/v2/users/${ref.username}`, 'DELETE');
    if (deleted.status === 409) throw new DomainError('conflict');
  }
}
