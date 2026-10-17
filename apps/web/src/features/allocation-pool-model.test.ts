import { describe, expect, it } from 'vitest';
import type { Allocation } from '../../../../packages/pterodactyl-adapter/src/types.js';
import {
  allocationPins,
  canSelectAllocation,
  changeAllocationRange,
  initialAllocationSelection,
} from './allocation-pool-model.js';

const rows: Allocation[] = Array.from({ length: 2400 }, (_, index) => ({
  id: index + 1,
  ip: index < 400 ? '192.168.50.5' : '10.50.0.1',
  port: index < 400 ? 24000 + index : 30000 + index - 400,
  assigned: false,
}));
const first: Allocation = { id: 1, ip: '192.168.50.5', port: 24000, assigned: false };
describe('Owner allocation pool selection', () => {
  it('selects 2000 exact-address ports without selecting another address or changing endpoint edits', () => {
    const retained = initialAllocationSelection([
      {
        allocationId: 1,
        address: first.ip,
        port: first.port,
        delivery: 'direct',
        directEndpoint: { hostname: 'play.example.test', port: 25565 },
      },
    ]);
    const selection = changeAllocationRange(
      retained,
      rows,
      retained,
      '10.50.0.1',
      30000,
      31999,
      true,
    );
    expect(selection.size).toBe(2001);
    expect(selection.get(1)).toEqual(retained.get(1));
    expect(allocationPins(selection, rows, '')).toHaveLength(2001);
    const removed = changeAllocationRange(
      selection,
      rows,
      retained,
      '10.50.0.1',
      30000,
      31999,
      false,
    );
    expect([...removed.keys()]).toEqual([1]);
  });
  it('excludes assigned foreign allocations and retains only matching original identities', () => {
    const assigned = rows.slice(0, 3).map((row) => ({ ...row, assigned: true }));
    const retained = initialAllocationSelection([
      { allocationId: 1, address: first.ip, port: first.port },
    ]);
    expect([
      ...changeAllocationRange(new Map(), assigned, retained, first.ip, 24000, 24002, true).keys(),
    ]).toEqual([1]);
    expect(canSelectAllocation({ ...{ ...first, assigned: true }, port: 25000 }, retained)).toBe(
      false,
    );
    expect(canSelectAllocation({ ...first, assigned: true }, new Map())).toBe(false);
  });
  it('rejects disappeared, duplicate or changed inventory rather than dropping selected pins', () => {
    const retained = initialAllocationSelection([
      { allocationId: 1, address: first.ip, port: first.port },
    ]);
    expect(() => allocationPins(retained, [], '')).toThrow();
    expect(() => allocationPins(retained, [first, first], '')).toThrow();
    expect(() => allocationPins(retained, [{ ...first, ip: '10.99.0.1' }], '')).toThrow();
  });
  it('retains hidden edited endpoint settings, validates hidden ports and serializes loopback remapping', () => {
    const selected = initialAllocationSelection([
      { allocationId: 1, address: '127.0.0.1', port: 24000 },
    ]);
    const pin = selected.get(1);
    if (!pin) throw Error('Missing fixture pin');
    selected.set(1, {
      ...pin,
      hostname: 'play.example.test',
      directPort: '25565',
      directOnly: true,
    });
    expect(allocationPins(selected, [{ ...first, ip: '127.0.0.1' }], '10.50.0.1')[0]).toMatchObject(
      {
        backendAddress: '10.50.0.1',
        delivery: 'direct',
        directEndpoint: { hostname: 'play.example.test', port: 25565 },
      },
    );
    selected.set(1, { ...pin, hostname: 'play.example.test', directPort: '70000' });
    expect(() => allocationPins(selected, [{ ...first, ip: '127.0.0.1' }], '10.50.0.1')).toThrow();
  });
  it('ignores invalid ranges', () => {
    const selection = new Map();
    for (const [address, from, to] of [
      ['', 1, 2],
      ['10.50.0.1', 0, 2],
      ['10.50.0.1', 4, 2],
      ['10.50.0.1', 1, 65536],
    ] as const)
      expect(changeAllocationRange(selection, rows, new Map(), address, from, to, true)).toBe(
        selection,
      );
  });
});
