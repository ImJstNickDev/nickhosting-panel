import { canManageGameUiSection, gameUiDescriptorSchema } from '@nickhosting/game-sdk/ui';
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

it('declares shared hostname and explicit port in the common UI contract', () => {
  expect(satisfactoryUiModule.descriptor.connectionModes).toEqual([
    { mode: 'shared-host', showPort: true },
  ]);
  for (const invalid of [
    { mode: 'shared-host', showPort: false },
    { mode: 'shared-host', showPort: true, srv: { service: '_satisfactory', transport: 'tcp' } },
  ]) {
    expect(
      gameUiDescriptorSchema.safeParse({
        ...satisfactoryUiModule.descriptor,
        connectionModes: [invalid],
      }).success,
    ).toBe(false);
  }
});

it('keeps setup optional and strips stale credentials when choosing the game client', async () => {
  const request = vi.fn().mockResolvedValue({});
  await satisfactoryUiModule.handlers.create?.(
    { request },
    {
      idempotencyKey: 'skip',
      values: {
        mappingId: '11111111-1111-4111-8111-111111111111',
        name: 'Factory',
        limits: { memory: 8192, cpu: 200 },
        setupMode: 'client',
        adminPassword: 'stale admin',
        clientPassword: 'stale player',
      },
    },
  );
  const body = request.mock.calls[0]?.[1].body;
  expect(body.satisfactory).toEqual({ branch: 'public', autoUpdate: true });
  expect(JSON.stringify(body)).not.toMatch(/stale|Password|setupMode/);
  expect(satisfactoryUiModule.descriptor.creation.defaults.setupMode).toBe('client');
});
it('sends opt-in credentials only inside setup without changing their bytes', async () => {
  const request = vi.fn().mockResolvedValue({});
  const values = {
    mappingId: '11111111-1111-4111-8111-111111111111',
    name: 'Factory',
    limits: { memory: 8192, cpu: 200 },
    setupMode: 'panel',
    adminPassword: ' admin café ',
    clientPassword: ' player ',
  };
  await satisfactoryUiModule.handlers.create?.({ request }, { idempotencyKey: 'panel', values });
  expect(request.mock.calls[0]?.[1].body).toMatchObject({
    satisfactory: { setup: { adminPassword: ' admin café ', clientPassword: ' player ' } },
  });
  expect(request.mock.calls[0]?.[1].body).not.toHaveProperty('adminPassword');
  for (const invalid of [
    { adminPassword: '' },
    { adminPassword: 'a'.repeat(129) },
    { adminPassword: 'same', clientPassword: 'same' },
  ]) {
    await expect(
      satisfactoryUiModule.handlers.create?.(
        { request },
        {
          idempotencyKey: 'invalid',
          values: { ...values, ...invalid },
        },
      ),
    ).rejects.toThrow();
  }
  expect(request).toHaveBeenCalledTimes(1);
});
it('declares conditional masked credentials and validates them before leaving the form', async () => {
  const { validateUiValues, visibleFields } = await import('@nickhosting/game-sdk/ui');
  const fields = satisfactoryUiModule.descriptor.creation.fields;
  expect(visibleFields(fields, { setupMode: 'client' }).some((f) => f.id === 'adminPassword')).toBe(
    false,
  );
  expect(fields.find((f) => f.id === 'adminPassword')).toMatchObject({
    type: 'text',
    secret: true,
  });
  const credentials = fields.filter((f) => ['adminPassword', 'clientPassword'].includes(f.id));
  expect(
    validateUiValues(credentials, {
      setupMode: 'panel',
      adminPassword: 'same',
      clientPassword: 'same',
    }),
  ).toEqual([{ field: 'clientPassword', code: 'invalid' }]);
  expect(validateUiValues(credentials, { setupMode: 'panel', adminPassword: ' admin ' })).toEqual(
    [],
  );
  const descriptor = satisfactoryUiModule.descriptor;
  expect(
    gameUiDescriptorSchema.safeParse({
      ...descriptor,
      creation: {
        ...descriptor.creation,
        pages: [
          {
            id: 'bad',
            titleKey: 'games.satisfactory.setup.title',
            field: 'adminPassword',
            kind: 'form',
            fields: ['unknown'],
          },
        ],
      },
    }).success,
  ).toBe(false);
});
