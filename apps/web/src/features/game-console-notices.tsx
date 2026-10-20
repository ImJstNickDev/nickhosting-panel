import { lazy, Suspense } from 'react';
import { availableGameSections } from './integrations.js';
import type { ServerInfo } from './service-contracts.js';

const MinecraftModRestartNotice = lazy(() =>
  import('../integrations/minecraft/mod-restart-notice.js').then((module) => ({
    default: module.MinecraftModRestartNotice,
  })),
);
/** Bundled contributions follow the same section capability/runtime declaration.
 * Other games don't acquire a Minecraft request or an extra polling loop. */
export function GameConsoleNotices({ server, state }: { server?: ServerInfo; state?: string }) {
  if (
    !server ||
    !availableGameSections(server).some((section) => section.renderer === 'minecraft-mods')
  )
    return null;
  return (
    <Suspense fallback={null}>
      <MinecraftModRestartNotice serverId={server.id} state={state} revision={server.updatedAt} />
    </Suspense>
  );
}
