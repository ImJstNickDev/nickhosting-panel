import { safeArchivePath } from './contracts.js';

/** Pack data is broader than individual addons. JavaScript under KubeJS is game
 * content; host launchers and NickHosting's private files are never pack data. */
export function modpackDataPath(input: string): string | null {
  const path = safeArchivePath(input);
  if (path.endsWith('/')) return null;
  const lower = path.toLowerCase();
  const root = lower.split('/')[0] ?? '';
  if (
    root.startsWith('.') ||
    ['libraries', 'versions', 'natives', 'bin', 'cache', 'logs', 'crash-reports'].includes(root) ||
    /^(?:server|minecraft_server|minecraft-server|fabric-server-launch|fabric-installer|forge|neoforge|quilt).*(?:\.jar)$/.test(
      lower,
    ) ||
    [
      'eula.txt',
      'ops.json',
      'ops.txt',
      'whitelist.json',
      'white-list.txt',
      'banned-players.json',
      'banned-ips.json',
      'banned-players.txt',
      'banned-ips.txt',
      'usercache.json',
      'session.lock',
      'user_jvm_args.txt',
      'fabric-server-launcher.properties',
      'server-icon.png',
    ].includes(lower) ||
    (!path.includes('/') && /\.(?:jar|sh|bat|cmd|ps1|exe|dll|so|dylib)$/i.test(path))
  )
    return null;
  return path;
}

export function assertModpackPaths(paths: readonly string[]) {
  const files = new Set<string>();
  const spellings = new Map<string, string>();
  for (const path of paths) {
    if (modpackDataPath(path) !== path || files.has(path.toLowerCase()))
      throw new Error('modpack_path_conflict');
    files.add(path.toLowerCase());
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index++) {
      const prefix = parts.slice(0, index).join('/');
      const prior = spellings.get(prefix.toLowerCase());
      if (prior !== undefined && prior !== prefix) throw new Error('modpack_path_conflict');
      spellings.set(prefix.toLowerCase(), prefix);
    }
  }
  for (const path of paths) {
    const parts = path.toLowerCase().split('/');
    if (parts.slice(0, -1).some((_, index) => files.has(parts.slice(0, index + 1).join('/'))))
      throw new Error('modpack_path_conflict');
  }
}
