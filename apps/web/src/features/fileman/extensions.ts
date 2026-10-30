import type { TrustedFilemanExtension } from '@nickhosting/game-sdk/ui';
import type { ReactNode } from 'react';

/** Statically import trusted first-party game contributions here, alongside their viewers.
 * Never load module names or executable patches from settings or provider metadata.
 */
export const gameFilemanExtensions: readonly TrustedFilemanExtension<ReactNode>[] = [];
