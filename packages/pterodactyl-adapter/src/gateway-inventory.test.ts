import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createPterodactylAdapter } from './adapter.js';

function fixture() {
  const node = { id: 2, uuid: randomUUID() };
  const primary = { id: 4, ip: '127.0.0.1', port: 25565, assigned: true };
  const extra = { ...primary, id: 5, port: 25566 };
  const unrelated = { ...primary, id: 6, port: 25567 };
  const free = { ...primary, id: 7, port: 25568, assigned: false };
  const server = {
    id: 3,
    uuid: randomUUID(),
    identifier: 'fixture',
    external_id: 'test',
    user: 1,
    node: node.id,
    allocation: primary.id,
    nest: 8,
    egg: 9,
    suspended: false,
    relationships: {
      allocations: { object: 'list', data: [primary, extra].map((attributes) => ({ attributes })) },
    },
  };
  const value = {
    schemaVersion: 1,
    nodes: [node],
    servers: [server],
    allocations: [{ nodeId: node.id, allocations: [primary, extra, unrelated, free] }],
  };
  const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(value),
  );
  const adapter = createPterodactylAdapter({
    baseURL: 'http://provider.test',
    applicationKey: 'test',
    fetcher,
  });
  return {
    primary,
    value,
    read: () => adapter.readGatewayInventory([node.id], [server.uuid]),
    fetcher,
    node,
    server,
  };
}

describe('Blueprint Gateway inventory', () => {
  it('reads one complete node inventory with owned, foreign and free allocations', async () => {
    const f = fixture();
    expect(await f.read()).toEqual(f.value);
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const [url, options] = f.fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'http://provider.test/api/application/extensions/nickhosting/gateway-inventory',
    );
    expect(options?.method).toBe('POST');
    expect(JSON.parse(String(options?.body))).toEqual({
      nodeIds: [f.node.id],
      serverUuids: [f.server.uuid],
    });
  });
  it.each([
    'extra server',
    'missing group',
    'missing node',
    'duplicate allocation',
    'inconsistent ownership',
    'missing claim',
    'missing primary',
  ])('rejects %s', async (kind) => {
    const f = fixture();
    const group = f.value.allocations[0];
    if (!group) throw new Error('Missing test group');
    const claims = f.server.relationships.allocations.data;
    if (kind === 'extra server') f.value.servers.push(f.server);
    if (kind === 'missing group') f.value.allocations.pop();
    if (kind === 'missing node') f.value.nodes.pop();
    if (kind === 'duplicate allocation') group.allocations.push(f.primary);
    if (kind === 'inconsistent ownership') group.allocations[0] = { ...f.primary, assigned: false };
    if (kind === 'missing claim') group.allocations.splice(1, 1);
    if (kind === 'missing primary') claims.shift();
    await expect(f.read()).rejects.toMatchObject({
      reason: 'invalid_response',
      outcome: 'rejected',
    });
  });
});
