import {
  type AuthorizedGameServices,
  defineGameIntegration,
  gameManifestSchema,
} from '@nickhosting/game-sdk';
import type { SatisfactoryApi } from './api.js';
import { createSatisfactoryLifecycle } from './lifecycle.js';
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
    worlds: true,
    idleDetection: true,
    gracefulStop: true,
    readiness: true,
    wake: 'manual',
  },
  connection: { mode: 'static-host-port', hostnameSettingKey: 'gatewayHostname', showPort: true },
  ports: satisfactoryPorts,
  runtimes: [
    {
      id: 'dedicated',
      imagePolicy: { mode: 'fixed', image: 'ghcr.io/ptero-eggs/steamcmd:debian' },
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
/** Runtime services are injected by the common platform; an unbound module
 * cannot manufacture player observations or authenticated lifecycle actions. */
export function createSatisfactoryIntegration(
  resolveApi: (services: AuthorizedGameServices) => Promise<SatisfactoryApi>,
) {
  return defineGameIntegration({
    manifest: satisfactoryManifest,
    runtimes: [satisfactoryRuntime],
    lifecycle: createSatisfactoryLifecycle(resolveApi),
  });
}
