import type { ConnectionMode } from '@nickhosting/game-sdk';

export const openworldVersionId = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// The catalog pins the actual published build. Compatibility diagnostics are
// advisory; the data plane still requires a correlated reply for that build.
export const openworldSupportsGateway = (version: string) =>
  openworldVersionId.test(version) && openworldSupportsRuntime(version);

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
