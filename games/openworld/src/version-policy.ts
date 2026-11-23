import type { ConnectionMode } from '@nickhosting/game-sdk';

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
// The publisher names alpha releases aX.Y.Z and their preview builds pre-aX.Y.Z-N.
export function openworldSupportsSrv(version: string | null | undefined) {
  const parts = /^(pre-)?a(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/.exec(version ?? '');
  if (!parts || Boolean(parts[1]) !== Boolean(parts[5])) return false;
  const major = Number(parts[2]);
  const minor = Number(parts[3]);
  const patch = Number(parts[4]);
  if (major !== 1) return major > 1;
  if (minor !== 2) return minor > 2;
  return patch > 10 || (patch === 10 && !parts[1]);
}

export function openworldConnectionMode(
  mode: ConnectionMode,
  version: string | null | undefined,
): ConnectionMode {
  if (mode.mode === 'custom-subdomain' && !openworldSupportsSrv(version)) {
    return { mode: mode.mode, zoneSettingKey: mode.zoneSettingKey };
  }
  return mode;
}

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
