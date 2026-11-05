import { defineTrustedGameViewer } from '@nickhosting/game-sdk/ui';
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
    (source) => source.gameId === 'satisfactory' && /\.sav$/i.test(source.name),
  ),
] as const;
