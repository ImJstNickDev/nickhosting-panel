/** Target metadata profiles, separate from client wire sniffing and runtime installation. */
export function minecraftLegacyStatusVariant(release: string): 'original' | 'extended' | undefined {
  if (/^b1\.(?:8|9)(?:[._-]|$)/.test(release)) return 'original';
  const stable = /^1\.(\d+)(?:\.\d+)?$/.exec(release);
  if (stable) {
    const minor = Number(stable[1]);
    if (minor <= 3) return 'original';
    if (minor <= 6) return 'extended';
  }
  return undefined;
}

export function minecraftLegacyGatewaySupported(release: string): boolean {
  if (
    /^b1\./.test(release) ||
    /^1\.[0-6](?:[._ -]|$)/.test(release) ||
    /^\d{2}w\d{2}[a-z]$/.test(release) ||
    minecraftLegacyStatusVariant(release)
  )
    return true;
  const alpha = /^a1\.(\d+)\.(\d+)(?:[_-].*)?$/.exec(release);
  return !!alpha && (Number(alpha[1]) > 0 || Number(alpha[2]) >= 15);
}

/** Unversioned client handshakes use the configured target as a presentation hint. */
export function minecraftLegacyMultiline(release: string): boolean {
  return /^1\.[3-6](?:[. _-]|$)/.test(release);
}
