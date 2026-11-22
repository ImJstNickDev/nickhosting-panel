import { randomUUID } from 'node:crypto';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import type { ManagementRuntime } from '@nickhosting/server-management';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGatewayIdentityReceipts } from './gateway-identity-receipts.js';
import { createGatewayInventoryReader } from './gateway-inventory-reader.js';

function fixture() {
  const id = randomUUID();
  let receipt = { epoch: randomUUID(), revision: '1', digest: 'a'.repeat(64) };
  let fire = () => {};
  let fail: PterodactylError | undefined;
  let coordinated: unknown;
  const snapshot = vi.fn(async () => {
    if (fail) throw fail;
    return { receipt, nodes: [], allocations: [], servers: [], schemaVersion: 1 as const };
  });
  const revision = vi.fn(
    (_receipt, _nodes, _servers, waitMs: number) =>
      new Promise((resolve, reject) => {
        const started = Date.now();
        const timer = setTimeout(() => fire(), waitMs);
        fire = () => {
          clearTimeout(timer);
          if (fail) return reject(fail);
          resolve({ ...receipt, waitedMs: Math.min(waitMs, Date.now() - started), coordinated });
        };
      }),
  );
  const legacy = vi.fn(async () => ({ nodes: [], servers: [], allocations: [] }));
  const runtime = {
    consoleProviderBinding: 'application-key-1',
    adapter: {
      supportsGatewayInventory: vi.fn(async () => true),
      readGatewayInventory: legacy,
      gatewayTopology: { snapshot, revision },
    },
  } as unknown as ManagementRuntime;
  const changed = vi.fn(async () => {});
  const reader = createGatewayInventoryReader(changed);
  const read = (uuids = [id], interval = 7500, admission = 'route-set-1') =>
    reader(runtime, [4], uuids, interval, admission);
  return {
    read,
    changed,
    snapshot,
    revision,
    legacy,
    runtime,
    replyWith(sections: unknown) {
      coordinated = sections;
    },
    advance() {
      receipt = { ...receipt, revision: '2' };
      fire();
    },
    revoke(status = 403) {
      fail = new PterodactylError(
        status === 403 ? 'permission_denied' : 'invalid_request',
        'application',
        'rejected',
        status,
      );
      fire();
    },
    ddl() {
      receipt = { ...receipt, digest: 'b'.repeat(64) };
    },
  };
}

afterEach(() => vi.useRealTimers());
describe('gateway topology confirmation', () => {
  it('uses one watch and one bootstrap for 30 polls, timestamps only actual confirmations', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const start = Date.now();
    for (let cycle = 0; cycle < 30; cycle++) {
      const observed = await f.read();
      expect(observed.providerObservedAt - start).toBe(Math.floor((cycle * 2000) / 7500) * 7500);
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(f.snapshot).toHaveBeenCalledTimes(1);
    // Eight completed waits at t=60s and the ninth outstanding for the next minute.
    expect(f.revision).toHaveBeenCalledTimes(9);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.legacy).not.toHaveBeenCalled();
  });
  it('corroborates 30 stable Openworld observations with one bootstrap and 15 completed topology heartbeats', async () => {
    vi.useFakeTimers();
    const inventory = fixture();
    const identities = createGatewayIdentityReceipts();
    let misses = 0;
    for (let observation = 0; observation < 30; observation++) {
      const source = await inventory.read(undefined, 4000);
      identities.begin('provider').publish(
        new Map([
          [
            'server',
            {
              revision: 'unchanged-local-identity',
              providerUuid: 'uuid',
              gatewayId: 'gateway',
              snapshotRevision: 1,
              observedAt: source.providerObservedAt,
              expiresAt: source.providerObservedAt + 5000,
            },
          ],
        ]),
        source.providerReadFresh,
      );
      if (!identities.lookup('server', 'provider')) misses++;
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(misses).toBe(0);
    expect(inventory.snapshot).toHaveBeenCalledOnce();
    expect(inventory.revision).toHaveBeenCalledTimes(16); // 15 complete, one outstanding.
  });
  it('publishes coordinated sections independently while an unchanged topology continues renewing', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const sections = { snapshots: { error: 409 } };
    const request = { instanceId: randomUUID(), snapshots: [randomUUID()] };
    const publishing = Promise.withResolvers<void>();
    const accept = vi.fn(() => publishing.promise);
    const prepare = vi.fn(async () => ({ request, accept }));
    Object.assign(f.runtime, { prepareGatewayHeartbeat: prepare });
    f.replyWith(sections);
    const start = Date.now();
    const first = await f.read(undefined, 4000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.revision.mock.calls[0]?.slice(4)).toEqual([request]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(accept).toHaveBeenCalledWith(sections);
    first.checkCurrent();
    expect((await f.read(undefined, 4000)).providerObservedAt).toBe(start + 4000);
    expect(prepare).toHaveBeenCalledOnce();
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(f.changed).not.toHaveBeenCalled();
    publishing.reject(new Error('feed publication failed'));
    await vi.advanceTimersByTimeAsync(0);
    first.checkCurrent();
  });
  it('reuses consecutive heartbeats when feed publication finishes inside the planning budget', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const request = { capabilities: true as const };
    const accept = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 15)));
    Object.assign(f.runtime, { prepareGatewayHeartbeat: async () => ({ request, accept }) });
    const start = Date.now();
    await f.read(undefined, 4000);
    await vi.advanceTimersByTimeAsync(4016);
    expect(f.revision.mock.calls[1]?.slice(3)).toEqual([3985, request]);
    await f.read(undefined, 4000);
    await vi.advanceTimersByTimeAsync(3984);
    expect((await f.read(undefined, 4000)).providerObservedAt).toBe(start + 8000);
  });
  it('renews topology when feed planning is stalled and discards a late plan only once', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const accept = vi.fn(async () => {});
    const work = { request: { capabilities: true }, accept };
    const blocked = Promise.withResolvers<typeof work>();
    const prepare = vi.fn(() => blocked.promise);
    Object.assign(f.runtime, { prepareGatewayHeartbeat: prepare });
    const start = Date.now();
    await f.read(undefined, 4000);
    await vi.advanceTimersByTimeAsync(100);
    expect(f.revision.mock.calls[0]?.slice(3)).toEqual([3900, undefined]);
    await vi.advanceTimersByTimeAsync(3900);
    expect((await f.read(undefined, 4000)).providerObservedAt).toBe(start + 4000);
    expect(prepare).toHaveBeenCalledOnce();
    blocked.resolve(work);
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(f.changed).not.toHaveBeenCalled();
  });
  it('renews with the original wire contract on a rolling downgrade that rejects the optional field', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const accept = vi.fn(async () => {});
    const prepare = vi.fn(async () => ({ request: { capabilities: true }, accept }));
    Object.assign(f.runtime, { prepareGatewayHeartbeat: prepare });
    f.revision.mockRejectedValueOnce(
      new PterodactylError('invalid_request', 'application', 'rejected', 422),
    );
    const start = Date.now();
    const first = await f.read(undefined, 4000);
    await vi.advanceTimersByTimeAsync(4000);
    expect(accept).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(prepare).toHaveBeenCalledOnce();
    expect(f.revision.mock.calls.map((c) => c.slice(4)[0]).slice(0, 2)).toEqual([
      { capabilities: true },
      undefined,
    ]);
    expect((await f.read(undefined, 4000)).providerObservedAt).toBe(start + 4000);
    first.checkCurrent();
    expect(f.snapshot).toHaveBeenCalledOnce();
  });
  it('discards optional work when the heartbeat was dispatched for a replaced scope', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const accept = vi.fn(async () => {});
    Object.assign(f.runtime, {
      prepareGatewayHeartbeat: async () => ({ request: { capabilities: true }, accept }),
    });
    await f.read(undefined, 4000);
    await vi.advanceTimersByTimeAsync(1);
    await f.read([randomUUID()], 4000);
    f.advance();
    await vi.advanceTimersByTimeAsync(0);
    expect(accept).toHaveBeenCalledExactlyOnceWith(undefined);
  });
  it('immediately invalidates an old proof on bulk mutation and reads a new bootstrap', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const old = await f.read();
    f.advance();
    await vi.advanceTimersByTimeAsync(1);
    expect(old.checkCurrent).toThrow();
    expect(f.changed).toHaveBeenCalledOnce();
    expect((await f.read()).providerReadFresh).toBe(true);
    expect(f.snapshot).toHaveBeenCalledTimes(2);
  });
  it('rejects a different digest after a missed event even if the counter repeats', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const old = await f.read();
    f.ddl();
    await vi.advanceTimersByTimeAsync(7500);
    expect(old.checkCurrent).toThrow();
    await f.read();
    expect(f.snapshot).toHaveBeenCalledTimes(2);
  });
  it('rejects revoked provider access and preserves legacy full reads on incomplete coverage', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const old = await f.read();
    f.revoke();
    await vi.advanceTimersByTimeAsync(1);
    expect(old.checkCurrent).toThrow();
    await expect(f.read()).rejects.toMatchObject({ upstreamStatus: 403 });
    expect(f.legacy).not.toHaveBeenCalled();
    f.snapshot.mockRejectedValueOnce(
      new PterodactylError('unavailable', 'application', 'rejected', 501),
    );
    await f.read();
    await f.read();
    expect(f.legacy).toHaveBeenCalledTimes(2);
  });
  it.each([403, 409])(
    'withdraws authority on heartbeat %i even if the next snapshot is temporarily unavailable',
    async (status) => {
      vi.useFakeTimers();
      const f = fixture();
      const old = await f.read();
      f.revoke(status);
      await vi.advanceTimersByTimeAsync(1);
      expect(old.checkCurrent).toThrow();
      expect(f.changed).toHaveBeenCalledOnce();
      f.snapshot.mockRejectedValueOnce(
        new PterodactylError('unavailable', 'application', 'rejected', 503),
      );
      await expect(f.read()).rejects.toMatchObject({ upstreamStatus: status });
      expect(f.snapshot).toHaveBeenCalledTimes(1);
      await expect(f.read()).rejects.toMatchObject({ upstreamStatus: status });
      expect(f.snapshot).toHaveBeenCalledTimes(2);
      f.snapshot.mockResolvedValueOnce(await f.snapshot.mock.results[0]?.value);
      expect((await f.read()).providerReadFresh).toBe(true);
    },
  );
  it('delivers a standing revocation through an admission change and a transient bootstrap failure', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.read();
    f.revoke();
    await vi.advanceTimersByTimeAsync(1);
    f.snapshot.mockRejectedValueOnce(
      new PterodactylError('unavailable', 'application', 'rejected', 503),
    );
    const changedPort = () => f.read(undefined, 7500, 'changed-port');
    await expect(changedPort()).rejects.toMatchObject({ upstreamStatus: 403 });
    await expect(changedPort()).rejects.toMatchObject({ upstreamStatus: 403 });
    expect(f.snapshot).toHaveBeenCalledTimes(2);
    f.snapshot.mockResolvedValueOnce(await f.snapshot.mock.results[0]?.value);
    expect((await changedPort()).providerReadFresh).toBe(true);
  });
  it('re-reads provider allocations before admitting a changed local endpoint for the same server', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const previous = await f.read();
    const current = await f.read(undefined, 7500, 'route-set-2');
    expect(previous.checkCurrent).toThrow();
    expect(current.providerReadFresh).toBe(true);
    expect(f.snapshot).toHaveBeenCalledTimes(2);
  });
  it('drops old scopes, joins simultaneous bootstrap, skips an empty Gateway', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const [first, joined] = await Promise.all([f.read(), f.read()]);
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect([first.providerReadFresh, joined.providerReadFresh].sort()).toEqual([false, true]);
    await f.read([randomUUID()]);
    expect(first.checkCurrent).toThrow();
    expect(f.revision).toHaveBeenCalledTimes(1);
    expect((await f.read([])).servers).toEqual([]);
    expect(f.snapshot).toHaveBeenCalledTimes(2);
  });
});

it('expires a worker capability at its original deadline when first used by a Gateway 59 seconds later', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const supports = vi.mocked(f.runtime.adapter.supportsGatewayInventory);
  supports.mockImplementationOnce(async (observed) => {
    observed?.(new Date(Date.now() - 59000));
    return true;
  });
  await f.read();
  await vi.advanceTimersByTimeAsync(999);
  await f.read();
  expect(supports).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await f.read();
  expect(supports).toHaveBeenCalledTimes(2);
});
