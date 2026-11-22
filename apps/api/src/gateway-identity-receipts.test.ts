import { afterEach, expect, it, vi } from 'vitest';
import {
  createGatewayIdentityReceipts,
  type GatewayIdentityReceipt,
} from './gateway-identity-receipts.js';

afterEach(() => vi.restoreAllMocks());

it('accepts an independent provider heartbeat only across matching local witnesses and preserves the original expiry on hits', () => {
  const receipts = createGatewayIdentityReceipts();
  const clock = vi.spyOn(Date, 'now');
  function publish(now: number, observedAt: number, revision: string, fresh = false) {
    clock.mockReturnValue(now);
    const proof: GatewayIdentityReceipt = {
      revision,
      gatewayId: 'gateway',
      providerUuid: 'uuid',
      snapshotRevision: 3,
      observedAt,
      expiresAt: observedAt + 5000,
    };
    receipts.begin('provider').publish(new Map([['server', proof]]), fresh);
    return receipts.lookup('server', 'provider');
  }
  expect(publish(100, 90, 'v1', true)?.expiresAt).toBe(5090);
  expect(publish(1000, 90, 'v1')?.expiresAt).toBe(5090);
  expect(publish(5200, 90, 'v1')).toBeUndefined();
  expect(publish(5500, 5400, 'v1')?.expiresAt).toBe(10400);
  expect(publish(6000, 5400, 'v2')).toBeUndefined();
  expect(publish(6100, 6000, 'v2')).toBeUndefined();
  expect(publish(10000, 9900, 'v2')?.expiresAt).toBe(14900);
  receipts.bind('rotated');
  receipts.bind('provider');
  expect(receipts.lookup('server', 'provider')).toBeUndefined();
  const pending = receipts.begin('provider');
  receipts.clear();
  pending.publish(new Map(), true);
  expect(publish(10100, 9900, 'v2')).toBeUndefined();
});
