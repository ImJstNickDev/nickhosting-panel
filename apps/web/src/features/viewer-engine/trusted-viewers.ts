import { createTrustedViewerRegistry, type TrustedGameViewer } from '@nickhosting/game-sdk/ui';
import { type ComponentType, lazy } from 'react';
import type { ViewerProps } from './core/types.js';

/** Add compiled first-party integration imports here. API JSON is never a module source. */
const integrationViewers: readonly TrustedGameViewer<{ default: ComponentType<ViewerProps> }>[] =
  [];
export const gameViewerRegistry = createTrustedViewerRegistry(integrationViewers);
const compiledRenderers = new Map(
  integrationViewers.map((module) => [module.descriptor.id, lazy(module.load)]),
);
export const gameViewerRenderer = (id: string) => compiledRenderers.get(id);
