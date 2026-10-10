import type { Allocation } from '../../../../packages/pterodactyl-adapter/src/types.js';
import type { BackendAllocationPool } from '../../../../packages/server-management/src/allocation-pool.js';

export type AllocationDraft = {
  allocationId: number;
  address: string;
  port: number;
  directOnly: boolean;
  hostname: string;
  directPort: string;
};
export type AllocationSelection = Map<number, AllocationDraft>;
export function allocationDraft(allocation: Allocation): AllocationDraft {
  return {
    allocationId: allocation.id,
    address: allocation.ip,
    port: allocation.port,
    directOnly: false,
    hostname: '',
    directPort: String(allocation.port),
  };
}
export function initialAllocationSelection(
  pins: BackendAllocationPool['allocations'] = [],
): AllocationSelection {
  return new Map(
    pins.map((pin) => [
      pin.allocationId,
      {
        allocationId: pin.allocationId,
        address: pin.address,
        port: pin.port,
        directOnly: pin.delivery === 'direct',
        hostname: pin.directEndpoint?.hostname ?? '',
        directPort: String(pin.directEndpoint?.port ?? pin.port),
      },
    ]),
  );
}
export function canSelectAllocation(
  allocation: Allocation,
  retained: AllocationSelection,
): boolean {
  const pin = retained.get(allocation.id);
  return (
    !allocation.assigned ||
    Boolean(pin && pin.address === allocation.ip && pin.port === allocation.port)
  );
}
export function changeAllocationRange(
  selection: AllocationSelection,
  rows: Allocation[],
  retained: AllocationSelection,
  address: string,
  from: number,
  to: number,
  include: boolean,
): AllocationSelection {
  if (
    !address ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from < 1 ||
    to > 65535 ||
    from > to
  )
    return selection;
  const next = new Map(selection);
  for (const allocation of rows) {
    if (allocation.ip !== address || allocation.port < from || allocation.port > to) continue;
    if (!include) next.delete(allocation.id);
    else if (canSelectAllocation(allocation, retained) && !next.has(allocation.id))
      next.set(allocation.id, retained.get(allocation.id) ?? allocationDraft(allocation));
  }
  return next;
}
export function allocationPins(
  selection: AllocationSelection,
  rows: Allocation[],
  bridgeAddress: string,
): BackendAllocationPool['allocations'] {
  const inventory = new Map(rows.map((row) => [row.id, row]));
  if (inventory.size !== rows.length) throw new Error('Invalid allocation inventory');
  return [...selection.values()].map((pin) => {
    const row = inventory.get(pin.allocationId);
    if (!row || row.ip !== pin.address || row.port !== pin.port)
      throw new Error('Allocation identity changed');
    const hostname = pin.hostname.trim();
    const port = Number(pin.directPort);
    if (hostname && (!Number.isInteger(port) || port < 1 || port > 65535))
      throw new Error('Invalid direct port');
    return {
      allocationId: pin.allocationId,
      address: pin.address,
      port: pin.port,
      ...(pin.directOnly ? { delivery: 'direct' as const } : {}),
      ...(hostname ? { directEndpoint: { hostname, port } } : {}),
      ...(pin.address === '127.0.0.1' ? { backendAddress: bridgeAddress } : {}),
    };
  });
}
