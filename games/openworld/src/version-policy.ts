// Each listed Linux release was started with the dedicated egg and answered the
// correlated server-information query with its own version. Keep future releases
// on direct delivery until their UDP behavior has been verified.
const gatewayVersions = new Set([
  'a1.2.9',
  'a1.2.8',
  'a1.2.7',
  'a1.2.6',
  'a1.2.5',
  'a1.2.4',
  'a1.2.3',
  'a1.2.2',
  'a1.2.1',
  'a1.2.0',
  'pre-a1.2.0-1',
  'a1.1.3',
  'a1.1.2',
  'a1.1.1',
  'a1.1.0',
  'a1.0.13',
  'a1.0.12',
  'a1.0.11',
]);

export const openworldSupportsGateway = (version: string) => gatewayVersions.has(version);
// The a1.0.10 publisher binary needs GLIBC_2.38. The egg uses Debian Bookworm.
export const openworldSupportsRuntime = (version: string) => version !== 'a1.0.10';

export function openworldVersionDelivery(
  version: string,
  configured: { gateway: boolean; direct: boolean },
): 'gateway' | 'direct' | undefined {
  if (!openworldSupportsRuntime(version)) return;
  if (configured.gateway && openworldSupportsGateway(version)) return 'gateway';
  if (configured.direct) return 'direct';
}
