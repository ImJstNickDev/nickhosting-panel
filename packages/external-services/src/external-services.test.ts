import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  CloudflareDnsProvider,
  type DnsOwnership,
  type DnsRecord,
  generateSftpPassword,
  type ObservedDnsRecord,
  type OwnedDnsRecord,
  planConnection,
  planDnsChanges,
  SftpGoAdapter,
  sftpServerDirectory,
} from './index.js';

const instanceId = randomUUID();
const serverId = randomUUID();
const externalServerUuid = randomUUID();
const zoneId = 'a'.repeat(32);
const now = 1_900_000_000_000;
function sftpFixture() {
  const users = new Map<string, Record<string, unknown>>();
  let id = 0;
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let loseNextCreateResponse = false;
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('X-SFTPGO-API-KEY')).toBe('fixture-private-key');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const username = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    if (method === 'GET')
      return Response.json(users.get(username) ?? {}, { status: users.has(username) ? 200 : 404 });
    if (method === 'POST') {
      if (users.has(body.username)) return Response.json({}, { status: 409 });
      users.set(body.username, { ...body, id: ++id });
      if (loseNextCreateResponse) {
        loseNextCreateResponse = false;
        throw new Error('timeout secret-key fixture-private-key');
      }
      return Response.json(users.get(body.username), { status: 201 });
    }
    if (method === 'PUT') {
      users.set(username, { ...users.get(username), ...body });
      return Response.json({ message: 'updated' });
    }
    if (method === 'DELETE') {
      users.delete(username);
      return Response.json({ message: 'deleted' });
    }
    throw new Error('unexpected fixture method');
  });
  const adapter = new SftpGoAdapter({
    baseURL: 'http://sftp.example.test',
    instanceId,
    dataRoot: '/isolated/servers',
    auth: { apiKey: 'fixture-private-key' },
    fetcher,
    now: () => now,
  });
  const request = () => ({
    serverId,
    externalServerUuid,
    credentialId: randomUUID(),
    password: generateSftpPassword(),
    expiresAt: now + 3_600_000,
    quotaBytes: 10_485_760,
  });
  return {
    adapter,
    users,
    calls,
    request,
    fetcher,
    loseNextCreate: () => {
      loseNextCreateResponse = true;
    },
  };
}

describe('SFTPGo credentials', () => {
  it('provisions independent users with one mapped UUID directory and no broad permissions', async () => {
    const fixture = sftpFixture();
    const first = await fixture.adapter.ensureCredential(fixture.request());
    const second = await fixture.adapter.ensureCredential({
      ...fixture.request(),
      serverId: randomUUID(),
      externalServerUuid: randomUUID(),
    });
    expect(first.username).not.toBe(second.username);
    expect(fixture.users.get(first.username)?.home_dir).toBe(
      `/isolated/servers/${externalServerUuid}`,
    );
    expect(fixture.users.get(first.username)?.home_dir).not.toBe(
      fixture.users.get(second.username)?.home_dir,
    );
    expect(fixture.users.get(first.username)?.permissions).toEqual({
      '/': ['list', 'download', 'upload', 'overwrite', 'delete', 'rename', 'create_dirs'],
    });
    expect(fixture.users.get(first.username)?.virtual_folders).toEqual([]);
    expect(fixture.users.get(first.username)?.groups).toEqual([]);
    expect(JSON.stringify(first)).not.toContain('password');
    expect(fixture.users.get(first.username)?.filters).toEqual({
      denied_protocols: ['FTP', 'DAV', 'HTTP'],
      allow_api_key_auth: false,
      disable_fs_checks: false,
    });
  });
  it('recovers lost creation response and repeated requests without password resets or duplicate users', async () => {
    const fixture = sftpFixture();
    const request = fixture.request();
    fixture.loseNextCreate();
    const first = await fixture.adapter.ensureCredential(request);
    expect(await fixture.adapter.ensureCredential(request)).toEqual(first);
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(fixture.calls.filter((call) => call.method === 'PUT')).toHaveLength(0);
  });
  it('rejects reused external identities and broadened folder mappings', async () => {
    const fixture = sftpFixture();
    const request = fixture.request();
    const ref = await fixture.adapter.ensureCredential(request);
    const user = fixture.users.get(ref.username);
    expect(user).toBeDefined();
    if (!user) throw new Error('fixture missing');
    user.virtual_folders = [{ virtual_path: '/other', mapped_path: '/outside' }];
    await expect(fixture.adapter.ensureCredential(request)).rejects.toMatchObject({
      code: 'conflict',
    });
    user.id = ref.externalUserId + 1;
    await expect(fixture.adapter.revokeCredential(ref)).rejects.toMatchObject({ code: 'conflict' });
    expect(fixture.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
  it('requires durable identity metadata, never relying on username prefix', async () => {
    const fixture = sftpFixture();
    const request = fixture.request();
    const ref = await fixture.adapter.ensureCredential(request);
    const user = fixture.users.get(ref.username);
    if (!user) throw new Error('fixture missing');
    user.additional_info = '{}';
    await expect(fixture.adapter.revokeCredential(ref)).rejects.toMatchObject({ code: 'conflict' });
    await expect(
      fixture.adapter.rotateCredential(ref, {
        password: generateSftpPassword(),
        expiresAt: request.expiresAt,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rotates with active session disconnection, then revokes without deleting files', async () => {
    const fixture = sftpFixture();
    const ref = await fixture.adapter.ensureCredential(fixture.request());
    const password = generateSftpPassword();
    const rotated = await fixture.adapter.rotateCredential(ref, {
      password,
      expiresAt: now + 7_200_000,
    });
    expect(fixture.users.get(ref.username)?.password).toBe(password);
    expect(fixture.calls.at(-1)?.path).toContain('disconnect=1');
    await fixture.adapter.revokeCredential(rotated);
    expect(fixture.calls.slice(-2).map((call) => [call.method, call.body?.status])).toEqual([
      ['PUT', 0],
      ['DELETE', undefined],
    ]);
    expect(fixture.calls.at(-2)?.path).toContain('disconnect=1');
    await fixture.adapter.revokeCredential(rotated);
    expect(fixture.users.size).toBe(0);
  });
  it('rejects traversal, root mappings, missing expiration and oversized lifetime before provider calls', async () => {
    for (const root of [
      '/',
      '/allowed/../outside',
      'relative',
      '/allowed/',
      '/allowed\\other',
      '/allowed\0',
    ]) {
      expect(() => sftpServerDirectory(root, externalServerUuid)).toThrow();
    }
    for (const id of ['../other', '%2e%2e', `${externalServerUuid}/..`])
      expect(() => sftpServerDirectory('/isolated', id)).toThrow();
    const fixture = sftpFixture();
    await expect(
      fixture.adapter.ensureCredential({ ...fixture.request(), expiresAt: now }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      fixture.adapter.ensureCredential({ ...fixture.request(), expiresAt: now + 31 * 86_400_000 }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(fixture.calls).toHaveLength(0);
  });
  it('redacts errors, credentials and oversized provider bodies', async () => {
    const fixture = sftpFixture();
    const denied = new SftpGoAdapter({
      baseURL: 'https://sftp.example.test',
      instanceId,
      dataRoot: '/isolated',
      auth: { accessToken: 'private-secret' },
      fetcher: async () => new Response('private-secret', { status: 403 }),
    });
    await expect(
      denied.ensureCredential({ ...fixture.request(), expiresAt: Date.now() + 60_000 }),
    ).rejects.toMatchObject({ message: 'forbidden' });
    const oversized = new SftpGoAdapter({
      baseURL: 'https://sftp.example.test',
      instanceId,
      dataRoot: '/isolated',
      auth: { accessToken: 'private-secret' },
      fetcher: async () => new Response('x'.repeat(1_048_577)),
    });
    await expect(
      oversized.ensureCredential({ ...fixture.request(), expiresAt: Date.now() + 60_000 }),
    ).rejects.toMatchObject({ message: 'integration_unavailable' });
  });
});

function dnsFixture() {
  const ownership: DnsOwnership = { instanceId, serverId, assignmentId: randomUUID() };
  const records = new Map<string, ObservedDnsRecord>();
  const ledger: OwnedDnsRecord[] = [];
  const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let id = 0;
  let loseNextWrite = false;
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
    expect(init?.redirect).toBe('error');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: `${url.pathname}${url.search}`, body });
    const recordId = url.pathname.split('/').at(-1) ?? '';
    let result: unknown;
    if (method === 'GET' && url.searchParams.has('name'))
      result = [...records.values()].filter((entry) => entry.name === url.searchParams.get('name'));
    else if (method === 'GET') {
      result = records.get(recordId);
      if (!result) return Response.json({}, { status: 404 });
    } else if (method === 'POST') {
      const newId = (++id).toString(16).padStart(32, '0');
      result = { ...body, id: newId };
      records.set(newId, result as ObservedDnsRecord);
    } else if (method === 'PUT') {
      result = { ...body, id: recordId };
      records.set(recordId, result as ObservedDnsRecord);
    } else if (method === 'DELETE') {
      records.delete(recordId);
      result = { id: recordId };
    } else throw new Error('unexpected fixture method');
    if (method !== 'GET' && loseNextWrite) {
      loseNextWrite = false;
      throw new Error('timeout fixture-token');
    }
    return Response.json({ success: true, result, result_info: { total_pages: 1 } });
  });
  const provider = new CloudflareDnsProvider({ instanceId, apiToken: 'fixture-token', fetcher });
  const callbacks = {
    onRecordCreated: async (entry: OwnedDnsRecord) => {
      const index = ledger.findIndex((item) => item.id === entry.id);
      if (index < 0) ledger.push(entry);
      else ledger[index] = entry;
    },
    onRecordDeleted: async (entry: OwnedDnsRecord) => {
      const index = ledger.findIndex((item) => item.id === entry.id);
      if (index >= 0) ledger.splice(index, 1);
    },
  };
  const desired = (): DnsRecord[] =>
    planConnection({
      mode: 'custom-subdomain',
      zoneName: 'example.test',
      subdomain: 'fixture',
      port: 25565,
      target: { type: 'A', content: '192.0.2.10' },
      srv: { service: '_game', protocol: 'tcp' },
    }).records;
  return {
    ownership,
    records,
    ledger,
    provider,
    calls,
    callbacks,
    desired,
    loseNextWrite: () => {
      loseNextWrite = true;
    },
  };
}

describe('DNS connection planning and Cloudflare ownership', () => {
  it('supports explicit static hostname and port without any DNS writes', () => {
    expect(
      planConnection({ mode: 'static-host-port', hostname: 'PLAY.EXAMPLE.TEST.', port: 7777 }),
    ).toEqual({
      hostname: 'play.example.test',
      port: 7777,
      displayAddress: 'play.example.test:7777',
      records: [],
    });
  });
  it('plans unproxied A/AAAA/CNAME with optional protocol-specific SRV', () => {
    const fixture = dnsFixture();
    expect(fixture.desired()[1]).toMatchObject({
      type: 'SRV',
      name: '_game._tcp.fixture.example.test',
      data: { port: 25565, target: 'fixture.example.test' },
      proxied: false,
    });
    const alias = planConnection({
      mode: 'custom-subdomain',
      zoneName: 'example.test',
      subdomain: 'alias',
      port: 7777,
      target: { type: 'CNAME', content: 'canonical.example.test' },
      srv: { service: '_game', protocol: 'udp' },
    });
    expect(alias.records[1]).toMatchObject({
      name: '_game._udp.alias.example.test',
      data: { target: 'canonical.example.test' },
    });
    expect(
      planConnection({
        mode: 'custom-subdomain',
        zoneName: 'example.test',
        subdomain: 'ipv6',
        port: 1234,
        target: { type: 'AAAA', content: '2001:db8::1' },
      }).records[0],
    ).toMatchObject({ type: 'AAAA' });
  });
  it('creates, updates and removes only proven owned records with durable callbacks', async () => {
    const fixture = dnsFixture();
    const plan = (desired: DnsRecord[]) =>
      fixture.provider.plan({
        zoneId,
        ownership: fixture.ownership,
        desired,
        ledger: fixture.ledger,
      });
    await fixture.provider.apply(await plan(fixture.desired()), fixture.callbacks);
    expect(fixture.records.size).toBe(2);
    expect(fixture.ledger).toHaveLength(2);
    expect(await plan(fixture.desired())).toEqual([]);
    const changed = fixture
      .desired()
      .map((entry) => (entry.type === 'A' ? { ...entry, content: '192.0.2.11' } : entry));
    await fixture.provider.apply(await plan(changed), fixture.callbacks);
    expect(fixture.calls.filter((call) => call.method === 'PUT')).toHaveLength(1);
    await fixture.provider.apply(await plan([]), fixture.callbacks);
    expect(fixture.records.size).toBe(0);
    expect(fixture.ledger).toHaveLength(0);
  });
  it('rejects foreign names regardless of matching content, and never adopts a prefix', async () => {
    const fixture = dnsFixture();
    const desired = fixture.desired();
    fixture.records.set('f'.repeat(32), {
      ...desired[0],
      id: 'f'.repeat(32),
      comment: 'nickhosting:untrusted',
    } as ObservedDnsRecord);
    await expect(
      fixture.provider.plan({ zoneId, ownership: fixture.ownership, desired, ledger: [] }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(fixture.calls.every((call) => call.method === 'GET')).toBe(true);
  });
  it('recovers a timeout after successful create from persisted intent without duplicate DNS records', async () => {
    const fixture = dnsFixture();
    const input = {
      zoneId,
      ownership: fixture.ownership,
      desired: fixture.desired(),
      ledger: fixture.ledger,
    };
    fixture.loseNextWrite();
    await expect(
      fixture.provider.apply(await fixture.provider.plan(input), fixture.callbacks),
    ).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(fixture.records.size).toBe(1);
    expect(fixture.ledger).toHaveLength(0);
    await fixture.provider.apply(await fixture.provider.plan(input), fixture.callbacks);
    expect(fixture.records.size).toBe(2);
    expect(fixture.ledger).toHaveLength(2);
    expect(fixture.calls.filter((call) => call.method === 'POST')).toHaveLength(2);
  });
  it('rechecks ownership immediately before mutation and blocks deleted/recreated identities', async () => {
    const fixture = dnsFixture();
    await fixture.provider.apply(
      await fixture.provider.plan({
        zoneId,
        ownership: fixture.ownership,
        desired: fixture.desired(),
        ledger: [],
      }),
      fixture.callbacks,
    );
    const deletion = await fixture.provider.plan({
      zoneId,
      ownership: fixture.ownership,
      desired: [],
      ledger: fixture.ledger,
    });
    const first = fixture.records.values().next().value;
    if (!first) throw new Error('fixture missing');
    first.comment = 'manually-reassigned';
    await expect(fixture.provider.apply(deletion, fixture.callbacks)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(fixture.calls.some((call) => call.method === 'DELETE')).toBe(false);
  });
  it('orders type replacement deletion before creation and rejects duplicate planned names', () => {
    const fixture = dnsFixture();
    const original = fixture.desired()[0];
    if (!original) throw new Error('fixture missing');
    const ledger: OwnedDnsRecord = {
      id: 'b'.repeat(32),
      zoneId,
      ownership: fixture.ownership,
      record: original,
    };
    const marker = `nickhosting:${instanceId}:${serverId}:${fixture.ownership.assignmentId}`;
    const replacement: DnsRecord = {
      type: 'CNAME',
      name: original.name,
      content: 'canonical.example.test',
      ttl: 120,
      proxied: false,
    };
    const base = {
      zoneId,
      ownership: fixture.ownership,
      observed: [{ ...original, id: ledger.id, comment: marker }],
      ledger: [ledger],
    };
    expect(
      planDnsChanges({ ...base, desired: [replacement] }).map((entry) => entry.action),
    ).toEqual(['delete', 'create']);
    expect(() => planDnsChanges({ ...base, desired: [replacement, original] })).toThrow();
    expect(() => planDnsChanges({ ...base, desired: [original, original] })).toThrow();
  });
  it('validates DNS names, ports and IPs without accepting path-like or wildcard input', () => {
    for (const name of ['../other', '*.example.test', 'host/path', '-invalid.example.test'])
      expect(() =>
        planConnection({ mode: 'static-host-port', hostname: name, port: 1234 }),
      ).toThrow();
    for (const assignedPort of [0, 65536, 1.5])
      expect(() =>
        planConnection({ mode: 'static-host-port', hostname: 'example.test', port: assignedPort }),
      ).toThrow();
    expect(() =>
      planConnection({
        mode: 'custom-subdomain',
        zoneName: 'example.test',
        subdomain: 'ok',
        port: 1,
        target: { type: 'A', content: 'not-an-ip' },
      }),
    ).toThrow();
  });
});
