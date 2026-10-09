import { gameManifestSchema } from '@nickhosting/game-sdk';
import { minecraftProfiles } from './compatibility.js';

/** Public capabilities are implemented backend contracts, not a release support matrix. */
export const minecraftManifest = gameManifestSchema.parse({
  id: 'minecraft-java',
  version: '1.0.0',
  nameKey: 'games.minecraft-java.name',
  capabilities: {
    console: true,
    files: true,
    backups: true,
    players: true,
    mods: true,
    worlds: true,
    idleDetection: true,
    gracefulStop: true,
    readiness: true,
    wake: 'manual',
  },
  connection: {
    mode: 'custom-subdomain',
    zoneSettingKey: 'cloudflareZoneId',
    srv: { service: '_minecraft', proto: 'tcp' },
  },
  ports: [{ role: 'game', transport: 'tcp', required: true }],
  runtimes: minecraftProfiles.map((id) => ({
    id,
    nameKey: `games.minecraft-java.runtimes.${id}`,
    supportedGameVersions: [],
    supports: { mods: ['fabric', 'forge'].includes(id), plugins: ['paper', 'folia'].includes(id) },
  })),
  wizard: {
    steps: [
      { id: 'choose-game', titleKey: 'games.minecraft-java.steps.chooseGame', fields: ['game'] },
      {
        id: 'configure',
        titleKey: 'games.minecraft-java.steps.configure',
        fields: ['choiceId', 'modpack', 'operators', 'whitelist'],
      },
      { id: 'resources', titleKey: 'games.minecraft-java.steps.resources', fields: ['limits'] },
      { id: 'create', titleKey: 'games.minecraft-java.steps.create', fields: ['eulaAccepted'] },
    ],
  },
  management: [
    {
      id: 'content',
      titleKey: 'games.minecraft-java.management.content',
      requiredCapability: 'mods',
    },
    {
      id: 'worlds',
      titleKey: 'games.minecraft-java.management.worlds',
      requiredCapability: 'worlds',
    },
    {
      id: 'properties',
      titleKey: 'games.minecraft-java.management.properties',
      requiredCapability: 'files',
    },
    {
      id: 'players',
      titleKey: 'games.minecraft-java.management.players',
      requiredCapability: 'players',
    },
  ],
  contentProviders: ['modrinth', 'curseforge'],
  localizations: { namespace: 'games.minecraft-java', locales: ['en', 'it'] },
});
