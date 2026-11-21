import type { ServerPermissionDefinition } from '@nickhosting/core';

export const openworldTelemetryPermissions: ServerPermissionDefinition[] = [
  {
    key: 'game.openworld.players.screenshots',
    resource: 'game.openworld.players',
    kind: 'additional',
    legacy: 'explicit',
    labelKey: 'games.openworld.permissions.screenshots',
    resourceLabelKey: 'games.openworld.telemetry.players',
    descriptionKey: 'games.openworld.permissions.screenshotsHelp',
  },
  {
    key: 'game.openworld.players.read',
    resource: 'game.openworld.players',
    kind: 'read',
    legacy: 'read',
    labelKey: 'games.openworld.permissions.viewPlayers',
    resourceLabelKey: 'games.openworld.telemetry.players',
  },
  {
    key: 'game.openworld.players.inspect',
    resource: 'game.openworld.players',
    kind: 'additional',
    legacy: 'explicit',
    labelKey: 'games.openworld.permissions.inspect',
    resourceLabelKey: 'games.openworld.telemetry.players',
    descriptionKey: 'games.openworld.permissions.inspectHelp',
  },
  {
    key: 'game.openworld.players.moderate',
    resource: 'game.openworld.players',
    kind: 'additional',
    legacy: 'explicit',
    labelKey: 'games.openworld.permissions.moderate',
    resourceLabelKey: 'games.openworld.telemetry.players',
    descriptionKey: 'games.openworld.permissions.moderateHelp',
  },
  {
    key: 'game.openworld.performance.read',
    resource: 'game.openworld.performance',
    kind: 'read',
    legacy: 'read',
    labelKey: 'games.openworld.permissions.viewPerformance',
    resourceLabelKey: 'games.openworld.telemetry.performance',
  },
];
