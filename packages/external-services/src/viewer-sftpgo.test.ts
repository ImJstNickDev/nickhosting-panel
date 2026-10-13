import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateSftpPassword } from './sftpgo.js';
import { SftpGoViewerAdapter } from './viewer-sftpgo.js';

function fixture() {
  const users = new Map<string, Record<string, unknown>>();
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let loseCreateResponse = false;
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url));
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const username = path.pathname.split('/').at(-1) ?? '';
    calls.push({ method, path: path.pathname + path.search, body });
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('X-SFTPGO-API-KEY')).toBe('fixture-key');
    if (method === 'GET')
      return Response.json(users.get(username) ?? {}, { status: users.has(username) ? 200 : 404 });
    if (method === 'POST') {
      if (users.has(body.username)) return Response.json({}, { status: 409 });
      users.set(body.username, { ...body, id: users.size + 1 });
      if (loseCreateResponse) {
        loseCreateResponse = false;
        throw new Error('lost response secret');
      }
      return Response.json(users.get(body.username), { status: 201 });
    }
    if (method === 'PUT') {
      users.set(username, { ...users.get(username), ...body });
      return Response.json({});
    }
    if (method === 'DELETE') {
      users.delete(username);
      return Response.json({});
    }
    throw new Error('Unexpected fixture request');
  };
  const adapter = new SftpGoViewerAdapter({
    baseURL: 'https://sftp.example.test',
    auth: { apiKey: 'fixture-key' },
    instanceId: randomUUID(),
    dataRoot: '/readonly/servers',
    fetcher,
  });
  const request = {
    serverId: randomUUID(),
    externalServerUuid: randomUUID(),
    credentialId: randomUUID(),
    password: generateSftpPassword(),
    expiresAt: Date.now() + 60_000,
  };
  return {
    adapter,
    request,
    users,
    calls,
    loseCreate: () => {
      loseCreateResponse = true;
    },
  };
}

describe('private read-only viewer SFTPGo credentials', () => {
  it('uses a separate namespace and exact list/download scope without filesystem initialization', async () => {
    const f = fixture();
    const ref = await f.adapter.ensureCredential(f.request);
    expect(ref.username).toBe(`nhv_${f.request.credentialId.replaceAll('-', '')}`);
    const user = f.users.get(ref.username);
    expect(user?.home_dir).toBe(`/readonly/servers/${f.request.externalServerUuid}`);
    expect(user?.permissions).toEqual({ '/': ['list', 'download'] });
    expect(user?.filters).toEqual({
      denied_protocols: ['FTP', 'DAV', 'HTTP'],
      allow_api_key_auth: false,
      disable_fs_checks: true,
    });
    expect(user?.public_keys).toEqual([]);
    expect(user?.virtual_folders).toEqual([]);
    expect(user?.groups).toEqual([]);
    expect(JSON.parse(String(user?.additional_info))).toMatchObject({
      application: 'nickhosting-viewer',
      credentialId: ref.credentialId,
    });
    expect(JSON.stringify(ref)).not.toContain(f.request.password);
  });

  it('recovers a lost response and idempotent retry without rotating passwords or changing files', async () => {
    const f = fixture();
    f.loseCreate();
    const ref = await f.adapter.ensureCredential(f.request);
    expect(await f.adapter.ensureCredential(f.request)).toEqual(ref);
    expect(f.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(f.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it.each([
    { permissions: { '/': ['list', 'download', 'upload'] } },
    { virtual_folders: [{ mapped_path: '/another-server' }] },
    { groups: [{ name: 'broader-access' }] },
    { public_keys: ['ssh-rsa arbitrary'] },
    { filters: { denied_protocols: ['FTP', 'DAV', 'HTTP'], disable_fs_checks: false } },
    { additional_info: '{}' },
    { home_dir: '/readonly/servers' },
  ])('rejects externally broadened or mismatched viewer accounts: %j', async (change) => {
    const f = fixture();
    const ref = await f.adapter.ensureCredential(f.request);
    f.users.set(ref.username, { ...f.users.get(ref.username), ...change });
    await expect(f.adapter.ensureCredential(f.request)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('revokes only the verified account, disconnects channels and never requests home-directory removal', async () => {
    const f = fixture();
    const ref = await f.adapter.ensureCredential(f.request);
    await expect(
      f.adapter.revokeCredential({ ...ref, externalUserId: ref.externalUserId + 1 }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await f.adapter.revokeCredential(ref);
    expect(f.calls.slice(-2).map((call) => [call.method, call.body?.status])).toEqual([
      ['PUT', 0],
      ['DELETE', undefined],
    ]);
    expect(f.calls.at(-2)?.path).toBe(`/api/v2/users/${ref.username}?disconnect=1`);
    expect(f.calls.at(-1)?.path).toBe(`/api/v2/users/${ref.username}`);
    expect(f.calls.at(-2)?.body?.filters).toMatchObject({ disable_fs_checks: true });
    await f.adapter.revokeCredential(ref);
  });
});
