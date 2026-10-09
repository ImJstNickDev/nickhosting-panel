import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertConfigWritable, defaultPlatformConfig, resolveConfig } from './config.js';

describe('Gateway typed configuration', () => {
  it('defaults disabled with no inferred host, endpoint, network or probe', () => {
    const { values } = resolveConfig();
    expect(values.gatewayEnabled).toBe(false);
    expect(values.gatewayObserver).toBeUndefined();
    expect(values.gatewayNetworkPolicy).toBeUndefined();
    expect(values.gatewayNodeProbes).toEqual({});
    expect(values.gatewayId).toBeUndefined();
  });
  it('resolves Owner then environment and locks conflicting writes', () => {
    const gatewayId = randomUUID();
    const config = resolveConfig(
      { gatewayEnabled: false, gatewayLeaseSeconds: 5 },
      { NH_GATEWAY_ENABLED: 'true', NH_GATEWAY_ID: gatewayId, NH_GATEWAY_LEASE_SECONDS: '10' },
    );
    expect(config.values).toMatchObject({
      gatewayEnabled: true,
      gatewayId,
      gatewayLeaseSeconds: 10,
    });
    expect(config.sources.gatewayEnabled).toBe('environment');
    expect(() => assertConfigWritable({ gatewayEnabled: false }, config)).toThrow('conflict');
  });
  it.each([
    { NH_GATEWAY_LEASE_SECONDS: '31' },
    { NH_GATEWAY_ENABLED: 'yes' },
    { NH_GATEWAY_NETWORK_POLICY: '{}' },
    { NH_GATEWAY_NODE_PROBES: '{"1":{"port":0,"transport":"tcp"}}' },
    {
      NH_GATEWAY_DATA_POLICY: JSON.stringify({
        ...defaultPlatformConfig.gatewayDataPolicy,
        maxClockSkewMs: 1001,
      }),
    },
  ])('rejects unsafe/malformed policy %j', (env) => {
    expect(() => resolveConfig({}, env)).toThrow('configuration_invalid');
  });
});
