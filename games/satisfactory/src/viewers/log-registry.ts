import { defineTrustedGameViewer } from '@nickhosting/game-sdk/ui';
export const satisfactoryLogViewers = [
  defineTrustedGameViewer(
    {
      id: 'satisfactory:log',
      gameId: 'satisfactory',
      labelKey: 'games.satisfactory.viewers.log.name',
      extensions: ['log'],
      readOnly: true,
    },
    () => import('./log-viewer.js'),
    (source) => source.gameId === 'satisfactory' && /\.log$/i.test(source.name),
  ),
] as const;
