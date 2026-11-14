import { defineTrustedGameViewer } from '@nickhosting/game-sdk/ui';
import { isCertificateName, isCrashContextName } from './diagnostic-names.js';
export const diagnosticViewers = [
  defineTrustedGameViewer(
    {
      id: 'satisfactory:crash',
      gameId: 'satisfactory',
      labelKey: 'games.satisfactory.viewers.diagnostic.crash',
      extensions: ['runtime-xml'],
      readOnly: true,
    },
    () => import('./diagnostic-viewer.js'),
    (source) => source.gameId === 'satisfactory' && isCrashContextName(source.name),
  ),
  defineTrustedGameViewer(
    {
      id: 'satisfactory:certificate',
      gameId: 'satisfactory',
      labelKey: 'games.satisfactory.viewers.diagnostic.certificate',
      extensions: ['pem', 'crt', 'cer'],
      readOnly: true,
    },
    () => import('./diagnostic-viewer.js'),
    (source) => source.gameId === 'satisfactory' && isCertificateName(source.name),
  ),
] as const;
