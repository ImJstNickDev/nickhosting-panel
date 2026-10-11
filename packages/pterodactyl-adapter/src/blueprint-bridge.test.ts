import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNickHostingBridge, verifyProviderChangeSignature } from './blueprint.js';

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
