import { gameManifestSchema } from '@nickhosting/game-sdk';
import { openworldTelemetryPermissions } from './server-permissions.js';

export const openworldRuntimeImage = 'ghcr.io/ptero-eggs/yolks:debian_bookworm';
export const openworldManifest = gameManifestSchema.parse({
  id: 'openworld',
  version: '1.0.0',
  nameKey: 'games.openworld.name',
  capabilities: {
    console: true,
    files: true,
    backups: true,
    players: true,
    mods: false,
    worlds: false,
    idleDetection: true,
    gracefulStop: true,
    readiness: true,
    wake: 'manual',
  },
  backupPolicy: { offline: 'required' },
  connection: { mode: 'custom-subdomain', zoneSettingKey: 'dnsBaseDomain' },
  serverPermissions: [
    ...openworldTelemetryPermissions,
    {
      key: 'game.openworld.dashboard.admin',
      resource: 'game.openworld.dashboard',
      kind: 'additional',
      legacy: 'explicit',
      labelKey: 'games.openworld.dashboard.permission',
      resourceLabelKey: 'games.openworld.dashboard.title',
      descriptionKey: 'games.openworld.dashboard.permissionHelp',
    },
  ],
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
  management: [
    { id: 'players', titleKey: 'games.openworld.telemetry.players', requiredCapability: 'players' },
  ],
  localizations: { namespace: 'games.openworld', locales: ['en', 'it'] },
});
