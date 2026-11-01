import type { ApplicationServer } from '@nickhosting/pterodactyl-adapter';
import { describe, expect, it } from 'vitest';
import { assertManagedIdentity, type ManagedIdentitySnapshot } from './managed-identity.js';

function fixture() {
  const server = {
    external_id: 'nh-fixture',
    provider_user_id: 3,
    pterodactyl_id: 4,
    pterodactyl_uuid: '7cf58636-382c-40f8-a50c-a869617a038d',
    pterodactyl_identifier: '7cf58636',
  };
  const snapshot: ManagedIdentitySnapshot = {
    pterodactyl_node_id: 5,
    allocations: [
      { pterodactyl_allocation_id: 6, is_primary: true, address: '192.0.2.1', port: 25565 },
      { pterodactyl_allocation_id: 7, is_primary: false, address: '2001:db8::1', port: 25566 },
    ],
  };
  const remote = {
    id: server.pterodactyl_id,
    uuid: server.pterodactyl_uuid,
    identifier: server.pterodactyl_identifier,
    external_id: server.external_id,
    node: snapshot.pterodactyl_node_id,
    user: server.provider_user_id,
    allocation: 6,
    relationships: {
      allocations: {
        object: 'list',
        data: snapshot.allocations.map((claim) => ({
          attributes: {
            id: claim.pterodactyl_allocation_id,
            ip: claim.address,
            port: claim.port,
            assigned: true,
          },
        })),
      },
    },
  } as ApplicationServer;
  return { server, snapshot, remote };
}

describe('managed identity snapshot comparison', () => {
  it('compares every owned allocation and canonicalizes the reported IP address', () => {
    const { server, snapshot, remote } = fixture();
    const claims = remote.relationships?.allocations?.data;
    if (!claims?.[1]) throw new Error('Missing fixture');
    claims[1].attributes.ip = '2001:0db8:0000:0000:0000:0000:0000:0001';
    claims.reverse();
    expect(() => assertManagedIdentity(server, remote, snapshot)).not.toThrow();
  });

  it.each(['id', 'uuid', 'identifier', 'external_id', 'node', 'user', 'allocation'] as const)(
    'rejects a mismatched provider %s',
    (field) => {
      const { server, snapshot, remote } = fixture();
      Object.assign(remote, {
        [field]: typeof remote[field] === 'number' ? 999 : 'different-identity',
      });
      expect(() => assertManagedIdentity(server, remote, snapshot)).toThrow('provenance_mismatch');
    },
  );

  it.each(['missing', 'extra', 'unassigned', 'id', 'address', 'invalid-address', 'port'])(
    'rejects %s secondary allocation claims',
    (change) => {
      const { server, snapshot, remote } = fixture();
      const claims = remote.relationships?.allocations?.data;
      const secondary = claims?.[1];
      if (!claims || !secondary) throw new Error('Missing fixture');
      if (change === 'missing') claims.pop();
      if (change === 'extra') claims.push(structuredClone(secondary));
      if (change === 'unassigned') secondary.attributes.assigned = false;
      if (change === 'id') secondary.attributes.id = 99;
      if (change === 'address') secondary.attributes.ip = '2001:db8::2';
      if (change === 'invalid-address') secondary.attributes.ip = 'game.example.test';
      if (change === 'port') secondary.attributes.port = 25567;
      expect(() => assertManagedIdentity(server, remote, snapshot)).toThrow('provenance_mismatch');
    },
  );

  it('rejects absent allocation metadata and a registry without a primary allocation', () => {
    const { server, snapshot, remote } = fixture();
    expect(() => assertManagedIdentity(server, { ...remote, relationships: {} }, snapshot)).toThrow(
      'provenance_mismatch',
    );
    expect(() =>
      assertManagedIdentity(server, remote, {
        ...snapshot,
        allocations: snapshot.allocations.map((claim) => ({ ...claim, is_primary: false })),
      }),
    ).toThrow('provenance_mismatch');
  });

  it('allows unbound provider IDs only during provisioning while preserving ownership checks', () => {
    const { server, snapshot, remote } = fixture();
    const unbound = {
      ...server,
      pterodactyl_id: null,
      pterodactyl_uuid: null,
      pterodactyl_identifier: null,
    };
    expect(() => assertManagedIdentity(unbound, remote, snapshot, true)).not.toThrow();
    expect(() => assertManagedIdentity(unbound, remote, snapshot)).toThrow('provenance_mismatch');
    expect(() => assertManagedIdentity(unbound, { ...remote, user: 999 }, snapshot, true)).toThrow(
      'provenance_mismatch',
    );
    expect(() =>
      assertManagedIdentity(unbound, { ...remote, external_id: 'foreign' }, snapshot, true),
    ).toThrow('provenance_mismatch');
  });
});
