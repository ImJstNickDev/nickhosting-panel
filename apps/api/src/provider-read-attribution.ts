import { type ProviderReadCaller, withProviderReadCaller } from '@nickhosting/pterodactyl-adapter';
import type { Hono } from 'hono';
import type { Variables } from './app.js';

const sections = new Map<string, ProviderReadCaller>([
  ['telemetry', 'openworld-telemetry'],
  ['telemetry/players', 'openworld-players'],
  ['players', 'openworld-players'],
  ['map', 'openworld-map'],
  ['map/creatures', 'openworld-creatures'],
  ['map/space', 'openworld-space'],
  ['factories', 'openworld-factories'],
  ['screenshots', 'openworld-screenshots'],
  ['rules', 'openworld-rules'],
  ['seed', 'openworld-inspector'],
  ['dashboard', 'openworld-dashboard'],
]);

export function registerProviderReadAttribution(app: Hono<{ Variables: Variables }>) {
  app.use('/internal/gateway/*', (_c, next) => withProviderReadCaller('gateway', next));
  app.use('/v1/servers/:id/openworld/*', (c, next) => {
    const [, , , , , section = '', resource = ''] = c.req.path.split('/', 7);
    const caller = sections.get(`${section}/${resource}`) ?? sections.get(section) ?? 'api-other';
    return withProviderReadCaller(caller, next);
  });
}
