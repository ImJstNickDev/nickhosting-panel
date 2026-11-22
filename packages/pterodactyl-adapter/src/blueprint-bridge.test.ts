import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createNickHostingBridge,
  verifyProviderChangeSignature,
  verifyProviderEventSignature,
} from './blueprint.js';

const instanceId = randomUUID();
const event = {
  schemaVersion: 1,
  eventId: randomUUID(),
  instanceId,
  server: {
    providerId: 1,
    providerUuid: randomUUID(),
    identifier: 'abcdef12',
    externalId: randomUUID(),
    nodeId: 1,
  },
  revision: 1,
  type: 'limits.updated',
  limits: { memory: 1024, cpu: 100, disk: 4096, swap: 0, io: 500, threads: null },
  occurredAt: new Date().toISOString(),
};
const secret = 'ab'.repeat(32);
function signed() {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    body,
    timestamp,
    signature: createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
    eventId: String(event.eventId),
    secret,
  };
}
describe('Blueprint event authentication', () => {
  it('accepts the exact signed raw body', () =>
    expect(verifyProviderChangeSignature(signed())).toEqual(event));
  it.each(['body', 'timestamp', 'signature', 'eventId', 'secret'] as const)(
    'rejects changed %s',
    (field) => {
      const input = signed();
      input[field] =
        field === 'body'
          ? `${input.body} `
          : field === 'eventId'
            ? randomUUID()
            : field === 'timestamp'
              ? '1000000000'
              : 'cd'.repeat(32);
      expect(() => verifyProviderChangeSignature(input)).toThrow();
    },
  );
  it('rejects stale requests and oversized bodies', () => {
    const input = signed();
    expect(() =>
      verifyProviderChangeSignature({ ...input, now: Number(input.timestamp) * 1000 + 61000 }),
    ).toThrow();
    expect(() => verifyProviderChangeSignature({ ...input, body: ' '.repeat(65537) })).toThrow();
  });
});
describe('Blueprint administrative transport', () => {
  const options = {
    baseURL: 'https://panel.example.com',
    applicationKey: 'fixture-app',
    clientKey: 'never-client',
  };
  it('registers with Application authority and no redirects', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ instanceId }));
    await createNickHostingBridge({ ...options, fetcher }).registerInstance(instanceId, {
      callbackUrl: 'https://hub.example.com/v1/provider-events/pterodactyl',
      webhookSecret: secret,
    });
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Missing request');
    const [url, init] = call;
    expect(String(url)).toContain(`/instances/${instanceId}`);
    expect(init?.method).toBe('POST');
    expect(init?.redirect).toBe('error');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-app');
  });
  it('provisions opaque user identities through Application authority and validates the result', async () => {
    const userId = randomUUID();
    const identity = {
      providerId: 9,
      providerUuid: randomUUID(),
      externalId: `nh:${instanceId}:${userId}`,
    };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(identity));
    expect(
      await createNickHostingBridge({ ...options, fetcher }).provisionUser(instanceId, userId),
    ).toEqual(identity);
    const call = fetcher.mock.calls[0];
    if (!call) throw new Error('Missing request');
    const [url, init] = call;
    expect(String(url)).toContain(`/users/${userId}/provision`);
    expect(init?.body).toBe('{}');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-app');
    await expect(
      createNickHostingBridge({
        ...options,
        fetcher: async () => Response.json({ ...identity, providerId: -1 }),
      }).provisionUser(instanceId, userId),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });
  it('validates snapshot membership and bounds before accepting a batch', async () => {
    const snapshot = { ...event, type: 'snapshot' };
    const target = snapshot.server.providerUuid;
    const other = randomUUID();
    const reply = { schemaVersion: 1, instanceId, servers: [snapshot] };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(reply));
    const bridge = createNickHostingBridge({ ...options, fetcher });
    expect(() => bridge.getLinkedServerSnapshots(instanceId, [target, target])).toThrow();
    expect(() => bridge.getLinkedServerSnapshots(instanceId, [])).toThrow();
    expect(() =>
      bridge.getLinkedServerSnapshots(
        instanceId,
        Array.from({ length: 101 }, () => randomUUID()),
      ),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    expect(await bridge.getLinkedServerSnapshots(instanceId, [target, other])).toEqual(reply);
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/instances/${instanceId}/server-snapshots`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ serverUuids: [target, other] });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-app');
    for (const malformed of [
      { ...reply, instanceId: randomUUID() },
      { ...reply, servers: [snapshot, snapshot] },
      { ...reply, servers: [{ ...snapshot, instanceId: randomUUID() }] },
      {
        ...reply,
        servers: [{ ...snapshot, server: { ...snapshot.server, providerUuid: randomUUID() } }],
      },
      { ...reply, servers: [event] },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json(malformed));
      await expect(
        bridge.getLinkedServerSnapshots(instanceId, [target, other]),
      ).rejects.toMatchObject({ reason: 'invalid_response' });
    }
  });
  it('accepts legacy health and rejects unrequested, duplicate or malformed scope proofs', async () => {
    const id = event.server.providerUuid;
    const legacy = {
      schemaVersion: 1,
      instanceId,
      pendingEvents: 1,
      lastDeliveredAt: null,
      checkedAt: event.occurredAt,
    };
    const proof = { providerUuid: id, ownerId: 7, revision: 2, valid: true, pending: false };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(legacy));
    const bridge = createNickHostingBridge({ ...options, fetcher });
    expect(await bridge.health(instanceId, [id])).toEqual(legacy);
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).searchParams.get('scopes')).toBe(id);
    expect(() => bridge.health(instanceId, [id, id])).toThrow();
    expect(() =>
      bridge.health(
        instanceId,
        Array.from({ length: 101 }, () => randomUUID()),
      ),
    ).toThrow();
    for (const patch of [
      { scopes: [proof, proof] },
      { scopes: [{ ...proof, providerUuid: randomUUID() }] },
      { scopes: [{ ...proof, revision: 0 }] },
      { scopes: [proof], instanceId: randomUUID() },
    ]) {
      fetcher.mockResolvedValueOnce(Response.json({ ...legacy, ...patch }));
      await expect(bridge.health(instanceId, [id, randomUUID()])).rejects.toMatchObject({
        reason: 'invalid_response',
      });
    }
  });

  it('sends an explicit owner pin only on a reviewed relink', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(event));
    await createNickHostingBridge({ ...options, fetcher }).linkServer(instanceId, event.server, 9);
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
      ...event.server,
      expectedOwnerId: 9,
    });
  });
  it('refuses invalid callback or identity before a request', () => {
    const fetcher = vi.fn<typeof fetch>();
    const bridge = createNickHostingBridge({ ...options, fetcher });
    expect(() =>
      bridge.registerInstance(instanceId, {
        callbackUrl: 'http://hub.example.com/events',
        webhookSecret: secret,
      }),
    ).toThrow();
    expect(() =>
      bridge.linkServer(instanceId, { ...event.server, providerUuid: '../foreign' }),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves uncertainty after key issuance loses its response', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error('private secret');
    });
    await expect(
      createNickHostingBridge({ ...options, fetcher }).issueKey(
        instanceId,
        randomUUID(),
        randomUUID(),
      ),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('uses explicit scoped deletion and validates snapshots', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    await createNickHostingBridge({ ...options, fetcher }).revokeKey(
      instanceId,
      randomUUID(),
      'fixture-key',
    );
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('DELETE');
    await expect(
      createNickHostingBridge({
        ...options,
        fetcher: async () => Response.json({ ...event, unexpected: 'secret' }),
      }).getServer(instanceId, event.server.providerUuid),
    ).rejects.toMatchObject({ reason: 'invalid_response' });
  });
});

it('authenticates installation outcomes independently of limit revisions and rejects contradictory states', () => {
  const { revision: _revision, limits: _limits, ...base } = event;
  const payload = {
    ...base,
    type: 'installation.updated',
    installation: { state: 'installed', status: null },
  };
  const sign = (value: unknown) => {
    const body = JSON.stringify(value);
    const timestamp = String(Math.floor(Date.now() / 1000));
    return {
      body,
      timestamp,
      eventId: event.eventId,
      secret,
      signature: createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
    };
  };
  expect(verifyProviderEventSignature(sign(payload))).toEqual(payload);
  for (const installation of [
    { state: 'installed', status: 'install_failed' },
    { state: 'failed', status: null },
    { state: 'installing', status: 'suspended' },
  ])
    expect(() => verifyProviderEventSignature(sign({ ...payload, installation }))).toThrow();
  expect(() =>
    verifyProviderEventSignature({ ...sign(payload), signature: '00'.repeat(32) }),
  ).toThrow();
});
