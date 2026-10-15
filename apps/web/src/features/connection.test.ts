import { describe, expect, it } from 'vitest';
import {
  assignmentConnectionChoice,
  type ConnectionOptions,
  creationConnectionChoice,
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
