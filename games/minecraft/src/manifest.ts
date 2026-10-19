import { gameManifestSchema } from '@nickhosting/game-sdk';
import { minecraftProfiles } from './compatibility.js';
import { minecraftContentCapabilities } from './content-capabilities.js';
import { minecraftGatewayMessages } from './gateway-messages.js';
import { minecraftRuntimeImagePolicy } from './image-policy.js';

/** Public capabilities are implemented backend contracts, not a release support matrix. */
export const minecraftManifest = gameManifestSchema.parse({
  id: 'minecraft',
  version: '1.0.0',
  nameKey: 'games.minecraft.name',
  // Live save-command receipts need runtime/version-specific evidence before exposure.
  backupPolicy: { offline: 'required' },
  gatewayMessages: minecraftGatewayMessages,
  capabilities: {
    console: true,
    files: true,
    backups: true,
    players: true,
    mods: true,
    worlds: true,
    idleDetection: true,
    gracefulStop: true,
    gatewayMessages: true,
    readiness: true,
    wake: 'manual',
  },
  connection: {
    mode: 'custom-subdomain',
    zoneSettingKey: 'dnsBaseDomain',
    srv: { service: '_minecraft', proto: 'tcp' },
  },
  ports: [{ role: 'game', transport: 'tcp', required: true }],
  runtimes: minecraftProfiles.map((id) => ({
    id,
    nameKey: `games.minecraft.runtimes.${id}`,
    supportedGameVersions: [],
    imagePolicy: minecraftRuntimeImagePolicy(id),
    supports: minecraftContentCapabilities(id),
  })),
  wizard: {
    steps: [
      { id: 'choose-game', titleKey: 'games.minecraft.steps.chooseGame', fields: ['game'] },
      {
        id: 'configure',
        titleKey: 'games.minecraft.steps.configure',
        fields: ['choiceId', 'modpack', 'operators', 'whitelist'],
      },
      { id: 'resources', titleKey: 'games.minecraft.steps.resources', fields: ['limits'] },
      { id: 'create', titleKey: 'games.minecraft.steps.create', fields: ['eulaAccepted'] },
    ],
  },
  management: [
    {
      id: 'content',
      titleKey: 'games.minecraft.management.content',
      requiredCapability: 'mods',
    },
    {
      id: 'worlds',
      titleKey: 'games.minecraft.management.worlds',
      requiredCapability: 'worlds',
    },
    {
      id: 'properties',
      titleKey: 'games.minecraft.management.properties',
      requiredCapability: 'files',
    },
    {
      id: 'players',
      titleKey: 'games.minecraft.management.players',
      requiredCapability: 'players',
    },
  ],
  contentProviders: ['modrinth', 'curseforge'],
  localizations: { namespace: 'games.minecraft', locales: ['en', 'it'] },
});
