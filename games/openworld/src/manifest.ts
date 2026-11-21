import { gameManifestSchema } from '@nickhosting/game-sdk';

export const openworldRuntimeImage = 'ghcr.io/ptero-eggs/yolks:debian_bookworm';
export const openworldManifest = gameManifestSchema.parse({
  id: 'openworld',
  version: '1.0.0',
  nameKey: 'games.openworld.name',
  capabilities: {
    console: true,
    files: true,
    backups: true,
    players: false,
    mods: false,
    worlds: false,
    idleDetection: true,
    gracefulStop: true,
    readiness: true,
    wake: 'manual',
  },
  backupPolicy: { offline: 'required' },
  connection: { mode: 'shared-host', defaultLabel: 'openworld', allowCustomSubdomain: false },
  ports: [
    { role: 'game', required: true, transport: 'udp', defaultPort: 24710 },
    { role: 'dashboard', required: true, transport: 'tcp', visibility: 'private' },
  ],
  runtimes: [
    {
      id: 'dedicated',
      nameKey: 'games.openworld.runtime',
      supportedGameVersions: [],
      imagePolicy: { mode: 'fixed', image: openworldRuntimeImage },
      supports: {},
    },
  ],
  wizard: { steps: [{ id: 'version', titleKey: 'games.openworld.version', fields: ['version'] }] },
  management: [],
  localizations: { namespace: 'games.openworld', locales: ['en', 'it'] },
});
