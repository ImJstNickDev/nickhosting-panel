import { defineTrustedGameViewer } from '@nickhosting/game-sdk/ui';
import { isSatisfactoryServerSettings } from '../fileman.js';
import { diagnosticViewers } from './diagnostic-registry.js';
import { satisfactoryLogViewers } from './log-registry.js';
import { matchesManifestName } from './manifest-parser.js';
export const satisfactoryViewers = [
  defineTrustedGameViewer(
    {
      id: 'satisfactory:save',
      gameId: 'satisfactory',
      labelKey: 'games.satisfactory.viewers.save.name',
      extensions: ['sav'],
      readOnly: true,
    },
    () => import('./save-viewer.js'),
    (source) =>
      source.gameId === 'satisfactory' &&
      /\.sav$/i.test(source.name) &&
      !isSatisfactoryServerSettings(source.name),
  ),
  defineTrustedGameViewer(
    {
      id: 'satisfactory:ini',
      gameId: 'satisfactory',
      labelKey: 'games.satisfactory.viewers.ini.name',
      extensions: ['ini'],
      readOnly: true,
    },
    () => import('./ini-viewer.js'),
    (source) => source.gameId === 'satisfactory' && /\.ini$/i.test(source.name),
  ),
  defineTrustedGameViewer(
    {
      id: 'satisfactory:manifest',
      gameId: 'satisfactory',
      labelKey: 'games.satisfactory.viewers.manifest.name',
      extensions: ['uplugin', 'smmprofile', 'json'],
      readOnly: true,
    },
    () => import('./manifest-viewer.js'),
    (source) => source.gameId === 'satisfactory' && matchesManifestName(source.name),
  ),
  ...diagnosticViewers,
  ...satisfactoryLogViewers,
] as const;
