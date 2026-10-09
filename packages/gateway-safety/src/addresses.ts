import { isIP } from 'node:net';

export function canonicalAddress(value: string): string | null {
  if (!isIP(value) || value.includes('%')) return null;
  const canonical = isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value;
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(canonical);
  if (!mapped) return canonical;
  const high = Number.parseInt(mapped[1] ?? '', 16),
    low = Number.parseInt(mapped[2] ?? '', 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/** IPv6 wildcard is conservatively dual-stack; unknown IPs can never prove disjointness. */
export function addressesOverlap(first: string, second: string): boolean {
  const a = canonicalAddress(first),
    b = canonicalAddress(second);
  return (
    !a ||
    !b ||
    a === b ||
    a === '::' ||
    b === '::' ||
    (a === '0.0.0.0' && isIP(b) === 4) ||
    (b === '0.0.0.0' && isIP(a) === 4)
  );
}
export interface Endpoint {
  address: string;
  port: number;
  transport: 'tcp' | 'udp';
}
export function endpointsOverlap(first: Endpoint, second: Endpoint): boolean {
  return (
    first.transport === second.transport &&
    first.port === second.port &&
    addressesOverlap(first.address, second.address)
  );
}
export function exactEndpoint(first: Endpoint, second: Endpoint): boolean {
  return (
    first.transport === second.transport &&
    first.port === second.port &&
    canonicalAddress(first.address) === canonicalAddress(second.address)
  );
}
export function exactBindableAddress(address: string): boolean {
  const canonical = canonicalAddress(address);
  return canonical !== null && canonical === address && !['0.0.0.0', '::'].includes(canonical);
}
