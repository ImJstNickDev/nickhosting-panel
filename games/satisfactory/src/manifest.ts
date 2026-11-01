import { defineGameIntegration, gameManifestSchema } from '@nickhosting/game-sdk';
import { satisfactoryPorts, satisfactoryRuntime } from './runtime.js';

export const satisfactoryManifest = gameManifestSchema.parse({
  id: 'satisfactory',
  version: '1.0.0',
  nameKey: 'games.satisfactory.name',
  backupPolicy: { offline: 'required' },
  capabilities: {
    console: true,
    files: true,
    backups: true,
    players: false,
    mods: true,
    worlds: false,
    idleDetection: false,
    gracefulStop: false,
    readiness: false,
    wake: 'manual',
  },
  connection: { mode: 'static-host-port', hostnameSettingKey: 'gatewayHostname', showPort: true },
  ports: satisfactoryPorts,
  runtimes: [
    {
      id: 'dedicated',
      nameKey: 'games.satisfactory.runtimes.dedicated',
      supportedGameVersions: [],
      supports: {},
    },
  ],
  wizard: {
    steps: [
      {
        id: 'configure',
        titleKey: 'games.satisfactory.steps.configure',
        fields: ['branch', 'autoUpdate'],
      },
      { id: 'resources', titleKey: 'games.satisfactory.steps.resources', fields: ['limits'] },
      { id: 'create', titleKey: 'games.satisfactory.steps.create', fields: [] },
    ],
  },
  management: [],
  contentProviders: [],
  localizations: { namespace: 'games.satisfactory', locales: ['en', 'it'] },
});
export const satisfactoryIntegration = defineGameIntegration({
  manifest: satisfactoryManifest,
  runtimes: [satisfactoryRuntime],
});
