import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { ProviderHttp } from './http.js';
import { sftpServerDirectory } from './sftpgo.js';

const requestSchema = z
  .object({
    serverId: z.uuid(),
    externalServerUuid: z.uuid(),
    credentialId: z.uuid(),
    password: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
    expiresAt: z.number().int().positive(),
  })
  .strict();

export type ViewerSftpCredentialRequest = z.infer<typeof requestSchema>;
export interface ViewerSftpCredentialRef extends Omit<ViewerSftpCredentialRequest, 'password'> {
  instanceId: string;
  username: string;
  externalUserId: number;
}

const userSchema = z.object({
  id: z.number().int().positive(),
  username: z.string(),
  status: z.number(),
  home_dir: z.string(),
  additional_info: z.string(),
  expiration_date: z.number(),
  filesystem: z.object({ provider: z.number() }),
  public_keys: z.array(z.string()).nullish(),
  virtual_folders: z.array(z.unknown()).nullish(),
  groups: z.array(z.unknown()).nullish(),
  permissions: z.record(z.string(), z.array(z.string())),
  filters: z.object({
    denied_protocols: z.array(z.string()),
    allow_api_key_auth: z.boolean().optional(),
    disable_fs_checks: z.boolean(),
  }),
});
type RemoteViewer = z.infer<typeof userSchema>;
const deniedProtocols = ['FTP', 'DAV', 'HTTP'];

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new DomainError('validation_failed');
  return result.data;
}

/**
 * A separate account contract from external SFTP credentials. Read-only at the SFTP layer;
 * deployment must also mount Wings data read-only. disable_fs_checks prevents SFTPGo's login
 * initialization from creating/chowning a home directory. This never manages game files.
 */
export class SftpGoViewerAdapter {
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
    this.#instanceId = validate(z.uuid(), input.instanceId);
    this.#dataRoot = input.dataRoot;
    sftpServerDirectory(this.#dataRoot, this.#instanceId);
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

  #name(id: string): string {
    return `nhv_${id.replaceAll('-', '').toLowerCase()}`;
  }

  #marker(input: Omit<ViewerSftpCredentialRequest, 'password' | 'expiresAt'>): string {
    return JSON.stringify({
      application: 'nickhosting-viewer',
      instanceId: this.#instanceId,
      serverId: input.serverId,
      externalServerUuid: input.externalServerUuid,
      credentialId: input.credentialId,
    });
  }

  #payload(
    input: Omit<ViewerSftpCredentialRequest, 'password'> & { password?: string },
    status: 0 | 1,
  ): Record<string, unknown> {
    return {
      username: this.#name(input.credentialId),
      password: input.password,
      status,
      home_dir: sftpServerDirectory(this.#dataRoot, input.externalServerUuid),
      additional_info: this.#marker(input),
      expiration_date: input.expiresAt,
      permissions: { '/': ['list', 'download'] },
      public_keys: [],
      virtual_folders: [],
      groups: [],
      filesystem: { provider: 0 },
      max_sessions: 2,
      filters: {
        denied_protocols: deniedProtocols,
        allow_api_key_auth: false,
        disable_fs_checks: true,
      },
    };
  }

  async #read(username: string): Promise<RemoteViewer | null> {
    const response = await this.#http.request(`api/v2/users/${encodeURIComponent(username)}`);
    if (response.status === 404) return null;
    const result = userSchema.safeParse(response.data);
    if (!result.success) throw new DomainError('integration_unavailable');
    return result.data;
  }

  #assertOwned(
    user: RemoteViewer,
    input: Omit<ViewerSftpCredentialRequest, 'password' | 'expiresAt'> & {
      externalUserId?: number;
    },
  ): void {
    if (
      user.username !== this.#name(input.credentialId) ||
      user.additional_info !== this.#marker(input) ||
      user.home_dir !== sftpServerDirectory(this.#dataRoot, input.externalServerUuid) ||
      (input.externalUserId !== undefined && input.externalUserId !== user.id)
    )
      throw new DomainError('conflict');
  }

  #assertReadOnly(user: RemoteViewer): void {
    if (
      user.filesystem.provider !== 0 ||
      user.virtual_folders?.length ||
      user.groups?.length ||
      user.public_keys?.length ||
      user.filters.allow_api_key_auth ||
      user.filters.disable_fs_checks !== true ||
      Object.keys(user.permissions).length !== 1 ||
      JSON.stringify([...(user.permissions['/'] ?? [])].sort()) !==
        JSON.stringify(['download', 'list']) ||
      !deniedProtocols.every((protocol) => user.filters.denied_protocols.includes(protocol))
    )
      throw new DomainError('conflict');
  }

  /** Persist IDs and encrypted password before the request. Retry reconciles identity; never resets a password. */
  async ensureCredential(value: ViewerSftpCredentialRequest): Promise<ViewerSftpCredentialRef> {
    const input = validate(requestSchema, value);
    if (input.expiresAt <= this.#now() || input.expiresAt - this.#now() > 30 * 86_400_000)
      throw new DomainError('validation_failed');
    const username = this.#name(input.credentialId);
    let user = await this.#read(username);
    if (!user) {
      try {
        const response = await this.#http.request('api/v2/users', 'POST', this.#payload(input, 1));
        if (response.status === 404) throw new DomainError('integration_unavailable');
      } catch (error) {
        user = await this.#read(username);
        if (!user) throw error;
      }
      user ??= await this.#read(username);
    }
    if (!user) throw new DomainError('integration_unavailable');
    this.#assertOwned(user, input);
    this.#assertReadOnly(user);
    if (user.status !== 1 || user.expiration_date !== input.expiresAt)
      throw new DomainError('conflict');
    return {
      serverId: input.serverId,
      externalServerUuid: input.externalServerUuid,
      credentialId: input.credentialId,
      expiresAt: input.expiresAt,
      instanceId: this.#instanceId,
      username,
      externalUserId: user.id,
    };
  }

  /** Caller must first close its pooled transports; upstream retained-SSH revocation limitation remains #18. */
  async revokeCredential(ref: ViewerSftpCredentialRef): Promise<void> {
    for (const id of [ref.serverId, ref.externalServerUuid, ref.credentialId])
      validate(z.uuid(), id);
    if (
      ref.instanceId !== this.#instanceId ||
      ref.username !== this.#name(ref.credentialId) ||
      !Number.isSafeInteger(ref.externalUserId) ||
      ref.externalUserId < 1
    )
      throw new DomainError('validation_failed');
    const user = await this.#read(ref.username);
    if (!user) return;
    this.#assertOwned(user, ref);
    const response = await this.#http.request(
      `api/v2/users/${ref.username}?disconnect=1`,
      'PUT',
      this.#payload(ref, 0),
    );
    if (response.status === 404) return;
    if (response.status === 409) throw new DomainError('conflict');
    const deleted = await this.#http.request(`api/v2/users/${ref.username}`, 'DELETE');
    if (deleted.status === 409) throw new DomainError('conflict');
  }
}
