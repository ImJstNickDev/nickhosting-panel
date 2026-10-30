import { describe, expect, it } from 'vitest';
import {
  assertHandoffRevision,
  assertRemote,
  parseArguments,
} from './provider-account-handoff.mjs';

const serverId = '00000000-0000-4000-8000-000000000001';
const providerUuid = '00000000-0000-4000-8000-000000000002';
const args = [
  '--owner-approved',
  '--server',
  serverId,
  '--expected-provider-id',
  '53',
  '--expected-provider-uuid',
  providerUuid,
  '--expected-owner-id',
  '1',
];
describe('explicit provider owner handoff guards', () => {
  it('requires explicit approval and exact identities', () => {
    expect(parseArguments(args)).toEqual({ serverId, providerId: 53, providerUuid, oldOwnerId: 1 });
    expect(() => parseArguments(args.slice(1))).toThrow();
    expect(() => parseArguments([...args, '--owner-approved'])).toThrow();
    expect(() => parseArguments(args.map((v) => (v === '53' ? '0' : v)))).toThrow();
  });
  it('rejects changed remote ownership identity before a mutation', () => {
    const server = {
      pterodactyl_identifier: 'abc12345',
      external_id: 'nh-test',
      pterodactyl_node_id: 1,
    };
    const remote = {
      id: 53,
      uuid: providerUuid,
      identifier: 'abc12345',
      external_id: 'nh-test',
      node: 1,
    };
    expect(() => assertRemote(remote, server, parseArguments(args))).not.toThrow();
    for (const changed of [
      { id: 54 },
      { uuid: serverId },
      { identifier: 'foreign' },
      { external_id: 'foreign' },
      { node: 2 },
    ])
      expect(() => assertRemote({ ...remote, ...changed }, server, parseArguments(args))).toThrow();
  });
  it('repairs equal revision only through the explicit handoff after lost local confirmation', () => {
    const projection = { revision: '7', identity_invalidated: true };
    expect(() =>
      assertHandoffRevision({ type: 'snapshot', revision: 7 }, projection),
    ).not.toThrow();
    expect(() =>
      assertHandoffRevision({ type: 'snapshot', revision: 8 }, projection),
    ).not.toThrow();
    expect(() => assertHandoffRevision({ type: 'snapshot', revision: 6 }, projection)).toThrow();
    expect(() =>
      assertHandoffRevision({ type: 'identity.invalidated', revision: 8 }, projection),
    ).toThrow();
  });
});
