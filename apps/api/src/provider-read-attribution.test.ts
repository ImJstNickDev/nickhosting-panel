import { createTransportCoordinator } from '@nickhosting/pterodactyl-adapter';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import type { Variables } from './app.js';
import { registerProviderReadAttribution } from './provider-read-attribution.js';

it('uses fixed Openworld, gateway and fallback caller labels for overlapping API requests', async () => {
  const coordinator = createTransportCoordinator('api');
  const app = new Hono<{ Variables: Variables }>();
  registerProviderReadAttribution(app);
  const detail = new URL('https://panel.example/api/application/servers/1');
  app.get('*', async (c) => {
    await Promise.resolve();
    return c.text(coordinator.providerReadAgent('application', 'GET', 'servers/1', detail) ?? '');
  });
  const cases = [
    ['/internal/gateway/test/evidence', 'gateway'],
    ['/v1/servers/demo/openworld/map', 'openworld-map'],
    ['/v1/servers/demo/openworld/map/changes', 'openworld-map'],
    ['/v1/servers/demo/openworld/map/space', 'openworld-space'],
    ['/v1/servers/demo/openworld/map/creatures?markers=1', 'openworld-creatures'],
    ['/v1/servers/demo/openworld/telemetry/status', 'openworld-telemetry'],
    ['/v1/servers/demo/openworld/telemetry/players/3/skin', 'openworld-players'],
    ['/v1/servers/demo/openworld/players/saved', 'openworld-players'],
    ['/v1/servers/demo/openworld/screenshots', 'openworld-screenshots'],
    ['/v1/servers/demo/openworld/seed', 'openworld-inspector'],
    ['/v1/servers/demo/openworld/arbitrary-input', 'api-other'],
    ['/v1/servers/demo', 'api-other'],
  ] as const;
  await Promise.all(
    cases.map(async ([path, label]) => {
      const response = await app.request(path, { headers: { 'user-agent': 'untrusted-caller' } });
      expect(await response.text()).toBe(`NickPanel/${label}`);
    }),
  );
});
