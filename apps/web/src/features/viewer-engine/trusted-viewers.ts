import {
  createTrustedViewerRegistry,
  type GameViewerProps,
  type TrustedGameViewer,
} from '@nickhosting/game-sdk/ui';
import { minecraftViewers } from '@nickhosting/minecraft/ui';
import { type ComponentType, lazy } from 'react';

/** Add compiled first-party integration imports here. API JSON is never a module source. */
const integrationViewers: readonly TrustedGameViewer<{
  default: ComponentType<GameViewerProps>;
}>[] = [...minecraftViewers];
export const gameViewerRegistry = createTrustedViewerRegistry(integrationViewers);
const compiledRenderers = new Map(
  integrationViewers.map((module) => [module.descriptor.id, lazy(module.load)]),
);
export const gameViewerRenderer = (id: string) => compiledRenderers.get(id);
