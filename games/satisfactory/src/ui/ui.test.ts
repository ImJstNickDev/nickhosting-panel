import { canManageGameUiSection } from '@nickhosting/game-sdk/ui';
import { expect, it, vi } from 'vitest';
import { satisfactoryUiModule } from './index.js';

it('bundles both locales and both game transports through the common UI schema', () => {
  expect(satisfactoryUiModule.catalogs.it['games.satisfactory.name']).toBe('Satisfactory');
  expect(satisfactoryUiModule.descriptor.ports[0]?.transports).toEqual(['tcp', 'udp']);
});
it('uses explicit server management authority for both native renderers', () => {
  for (const section of satisfactoryUiModule.descriptor.sections) {
    expect(canManageGameUiSection(section, ['server:read', 'server:manage'])).toBe(true);
    expect(canManageGameUiSection(section, ['server:read'])).toBe(false);
    expect(canManageGameUiSection(section, ['server:read', 'settings.write'])).toBe(false);
  }
});
it('creates with exactly the chosen mapping and configuration through the common API', async () => {
  const request = vi.fn().mockResolvedValue({});
  const create = satisfactoryUiModule.handlers.create;
  if (!create) throw new Error('create handler missing');
  await create(
    { request },
    {
      idempotencyKey: 'test',
      values: {
        mappingId: '11111111-1111-4111-8111-111111111111',
        name: 'Factory',
        limits: { memory: 8192, cpu: 200 },
        branch: 'public',
        autoUpdate: false,
      },
    },
  );
  expect(request).toHaveBeenCalledWith(
    '/v1/servers',
    expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({
        satisfactory: { branch: 'public', autoUpdate: false },
        mappingId: '11111111-1111-4111-8111-111111111111',
      }),
    }),
  );
});
