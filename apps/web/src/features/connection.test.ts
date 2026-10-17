import { describe, expect, it } from 'vitest';
import {
  assignmentConnectionChoice,
  type ConnectionOptions,
  creationConnectionChoice,
  matchingConnectionReservation,
} from './connection.api.js';

const options: ConnectionOptions = {
  mode: 'custom-subdomain',
  customizable: true,
  domains: [
    { id: 'root', hostname: 'example.test' },
    { id: 'games', hostname: 'games.example.test' },
  ],
  defaultDomainId: 'root',
  defaultHostname: null,
  supportsSrv: true,
  configured: true,
};
describe('Connection edit label', () => {
  it('omits DNS requests for static endpoints and unconfigured integrations during creation', () => {
    expect(creationConnectionChoice({ ...options, mode: 'static-host-port' }, {})).toBeUndefined();
    expect(creationConnectionChoice({ ...options, configured: false }, {})).toBeUndefined();
    expect(creationConnectionChoice(options, {})).toEqual({});
  });
  it('rejects expired holds and holds for another name or domain', () => {
    const reservation = {
      reservationId: 'id',
      hostname: 'foo.example.test',
      subdomain: 'foo',
      domainId: 'root',
      expiresAt: '2026-10-16T12:00:00Z',
    };
    const now = Date.parse('2026-10-16T11:59:59Z');
    expect(matchingConnectionReservation(reservation, { subdomain: 'foo' }, options, now)).toBe(
      true,
    );
    expect(matchingConnectionReservation(reservation, { subdomain: 'bar' }, options, now)).toBe(
      false,
    );
    expect(
      matchingConnectionReservation(
        reservation,
        { subdomain: 'foo', domainId: 'games' },
        options,
        now,
      ),
    ).toBe(false);
    expect(
      matchingConnectionReservation(reservation, { subdomain: 'foo' }, options, now + 1000),
    ).toBe(false);
  });
  it('uses stored identity and longest suffix for legacy overlapping domains', () => {
    const connection = { hostname: 'blue.games.example.test' };
    expect(assignmentConnectionChoice({ domainId: 'games', connection }, options)).toEqual({
      domainId: 'games',
      subdomain: 'blue',
    });
    expect(assignmentConnectionChoice({ connection }, options)).toEqual({
      domainId: 'games',
      subdomain: 'blue',
    });
  });
  it('preserves shared semantics even when that assignment is on another domain', () => {
    expect(
      assignmentConnectionChoice(
        { domainId: 'games', shared: true, connection: { hostname: 'fixture.games.example.test' } },
        { ...options, mode: 'shared-host', defaultHostname: 'fixture.example.test' },
      ),
    ).toEqual({ domainId: 'games' });
  });
});
