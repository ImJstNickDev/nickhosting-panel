import { DomainError } from '@nickhosting/core';
import type { Hono } from 'hono';
import { readOpenworldRuleFiles } from '../../../games/openworld/src/rule-files.js';
import { resolveOpenworldDashboardTarget } from '../../../packages/server-management/src/openworld-dashboard.js';
import { createOpenworldPlayerActions } from '../../../packages/server-management/src/openworld-player-actions.js';
import { createOpenworldPlayerChannel } from '../../../packages/server-management/src/openworld-player-channel.js';
import { createOpenworldRules } from '../../../packages/server-management/src/openworld-rules.js';
import {
  createOpenworldNativeConnection,
  createOpenworldTelemetry,
} from '../../../packages/server-management/src/openworld-telemetry.js';
import { createOpenworldWorldMap } from '../../../packages/server-management/src/openworld-world-map.js';
import type { Variables } from './app.js';
import { registerOpenworldDashboardRoutes } from './openworld-dashboard.js';
import {
  createOpenworldInspector,
  registerOpenworldInspectorRoutes,
} from './openworld-inspector.js';
import { registerOpenworldPlayerActionRoutes } from './openworld-player-actions.js';
import { registerOpenworldRulesRoutes } from './openworld-rules.js';
import { registerOpenworldThumbnailRoute } from './openworld-screenshot-thumbnails.js';
import { registerOpenworldScreenshotRoutes } from './openworld-screenshots.js';
import { registerOpenworldTelemetryRoutes } from './openworld-telemetry.js';
import { registerOpenworldWorldMapRoutes } from './openworld-world-map.js';
import type { ServerRouteOptions } from './servers.js';

export function registerOpenworldNativeRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal'> &
    Partial<Pick<ServerRouteOptions, 'management'>>,
) {
  const { db } = options;
  function management() {
    if (!options.management) throw new DomainError('integration_unavailable');
    return options.management();
  }
  const target = async (id: string) =>
    resolveOpenworldDashboardTarget(db, (await management()).adapter, id);
  const native = createOpenworldNativeConnection({ db, target });
  const shared = { db, target, native };
  registerOpenworldDashboardRoutes(app, options, native);
  registerOpenworldTelemetryRoutes(app, options, createOpenworldTelemetry(shared));
  registerOpenworldPlayerActionRoutes(app, options, createOpenworldPlayerActions(shared));
  const screenshots = createOpenworldPlayerChannel(shared);
  registerOpenworldThumbnailRoute(app, options, screenshots);
  registerOpenworldScreenshotRoutes(app, options, screenshots);
  registerOpenworldInspectorRoutes(app, options, createOpenworldInspector(shared));
  registerOpenworldRulesRoutes(
    app,
    options,
    createOpenworldRules({
      ...shared,
      readFiles: async (who, id, signal) =>
        (await management()).fileReadScope(
          who,
          id,
          readOpenworldRuleFiles,
          signal,
          'game.openworld.rules.view',
        ),
    }),
  );
  registerOpenworldWorldMapRoutes(app, options, createOpenworldWorldMap(shared));
}
