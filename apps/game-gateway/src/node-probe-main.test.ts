import { describe, expect, it } from 'vitest';
import { nodeProbeConfiguration } from './node-probe-main.js';

describe('explicit private node probe deployment', () => {
  it.each(['10.42.0.1', '172.20.0.1', '192.168.50.1', 'fd12::1'])(
    'accepts an explicit private address %s',
    (address) => {
      expect(
        nodeProbeConfiguration({ NH_NODE_PROBE_ADDRESS: address, NH_NODE_PROBE_PORT: '31000' }),
      ).toEqual({ address, port: 31000, transport: 'tcp' });
    },
  );
  it.each([
    '',
    '0.0.0.0',
    '::',
    '127.0.0.1',
    '::1',
    '192.0.2.1',
    'provider',
    'fd12::1%eth0',
    '::ffff:10.42.0.1',
  ])('rejects nonprivate or ambiguous deployment address %s', (address) => {
    expect(() =>
      nodeProbeConfiguration({ NH_NODE_PROBE_ADDRESS: address, NH_NODE_PROBE_PORT: '31000' }),
    ).toThrow();
  });
  it.each(['', '0', '80', '65536', '31000.5', 'no-port'])(
    'rejects missing, privileged or invalid port %s',
    (port) => {
      expect(() =>
        nodeProbeConfiguration({ NH_NODE_PROBE_ADDRESS: '10.42.0.1', NH_NODE_PROBE_PORT: port }),
      ).toThrow();
    },
  );
});
