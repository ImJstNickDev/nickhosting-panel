import { describe, expect, it } from 'vitest';
import {
  estimateGatewayStartup,
  gatewayObservationSchema,
  gatewayPolicySchema,
} from './gateway-orchestration.js';
import { assertGatewaySleepFence } from './registry.js';

describe('gateway startup measurement and policy contracts', () => {
  it('allows expired-fence confirmation only after a valid durable handoff, never a new effect', () => {
    const deadline = new Date('2026-01-01T00:00:10.000Z');
    const plan = {
      gatewayAutomation: { kind: 'sleep', quiescenceUntil: deadline.toISOString() },
      gatewaySleepHandoffAt: '2026-01-01T00:00:09.999Z',
    };
    const later = new Date(deadline.getTime() + 1000);
    expect(() => assertGatewaySleepFence(plan, later, true)).not.toThrow();
    expect(() => assertGatewaySleepFence(plan, later)).toThrow('forbidden');
    expect(() =>
      assertGatewaySleepFence(
        { ...plan, gatewaySleepHandoffAt: deadline.toISOString() },
        later,
        true,
      ),
    ).toThrow('forbidden');
    expect(() =>
      assertGatewaySleepFence({ gatewayAutomation: { kind: 'sleep' } }, later, true),
    ).toThrow('forbidden');
  });
  it('does not invent an estimate before five measurements', () => {
    for (let count = 0; count < 5; count++)
      expect(estimateGatewayStartup(Array(count).fill(1000))).toBeNull();
    expect(estimateGatewayStartup([900, 1000, 1100, 1200, 1300])).toEqual({
      sampleCount: 5,
      p50Ms: 1100,
      p90Ms: 1300,
    });
  });
  it('rejects invalid and unrepresentative measurement populations', () => {
    for (const values of [
      [0, 1, 2, 3, 4],
      [1, 100, 100, 100, 100],
      [100, 100, 100, 100, 1000],
      [1, 1, 1, 1, NaN],
    ])
      expect(estimateGatewayStartup(values)).toBeNull();
  });
  it('requires explicit bounded policy and observation values', () => {
    expect(gatewayPolicySchema.safeParse({ enabled: true }).success).toBe(false);
    expect(
      gatewayObservationSchema.safeParse({ ready: true, processStartedAt: 'yesterday' }).success,
    ).toBe(false);
  });
});
