import { randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { describe, expect, it, vi } from 'vitest';
import type { GameLifecycleContext } from './lifecycle.js';
import { resolveSatisfactoryApi, satisfactoryApiConfigured } from './satisfactory-api.js';
import { createSatisfactoryModuleRuntime } from './satisfactory-module.js';

vi.mock('./satisfactory-api.js', () => ({
  satisfactoryApiConfigured: vi.fn(async () => false),
  resolveSatisfactoryApi: vi.fn(),
}));

vi.mock('./satisfactory-tls.js', () => ({
  ensureSatisfactoryTlsIdentity: vi.fn(async () => ({
    certificatePem: 'certificate',
    privateKeyPem: 'private-key',
  })),
}));
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 42) } });
function fixture() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set([
    'FactoryGame',
    'Engine',
    'Engine/Binaries',
    'Engine/Binaries/Linux',
  ]);
  const authorize = vi.fn(async () => {});
  const assertStopped = vi.fn(async () => {});
  const adapter = {
    listFiles: vi.fn(async (_id: string, root: string) =>
      root === 'Engine/Binaries/Linux'
        ? [{ name: 'FactoryServer-Linux-Shipping', is_file: true, is_symlink: false, size: 1024 }]
        : [...directories]
            .filter((path) => path.split('/').slice(0, -1).join('/') === root)
            .map((path) => ({ name: path.split('/').at(-1), is_file: false, is_symlink: false })),
    ),
    createDirectory: vi.fn(async (_id: string, root: string, name: string) => {
      directories.add([root, name].filter(Boolean).join('/'));
    }),
    uploadFile: vi.fn(
      async (
        _id: string,
        path: string,
        input: { body: ReadableStream<Uint8Array>; authorize: () => Promise<void> },
      ) => {
        await input.authorize();
        files.set(path, new Uint8Array(await new Response(input.body).arrayBuffer()));
      },
    ),
    readFile: vi.fn(async (_id: string, path: string) => files.get(path)),
  };
  return {
    adapter,
    files,
    authorize,
    assertStopped,
    context: {
      db: {},
      server: { id: randomUUID(), pterodactyl_identifier: 'fixture' },
      adapter,
      authorize,
      assertStopped,
      operation: () => ({ plan: {} }),
      effect: async (_phase: string, perform: () => Promise<unknown>) => {
        await perform();
        return true;
      },
    } as unknown as GameLifecycleContext,
  };
}
describe('Satisfactory prestart TLS distribution', () => {
  it('retains native stop when no application token exists', async () => {
    const f = fixture();
    vi.mocked(satisfactoryApiConfigured).mockResolvedValue(false);
    vi.mocked(resolveSatisfactoryApi).mockClear();
    await createSatisfactoryModuleRuntime(codec).prepareStop?.(f.context);
    expect(resolveSatisfactoryApi).not.toHaveBeenCalled();
  });
  it('refuses a console sleep when no credential can verify the required save', async () => {
    const f = fixture();
    vi.mocked(satisfactoryApiConfigured).mockResolvedValue(false);
    f.context.operation = () =>
      ({ plan: { gatewayConsole: { action: 'sleep' } } }) as unknown as ReturnType<
        GameLifecycleContext['operation']
      >;
    await expect(createSatisfactoryModuleRuntime(codec).prepareStop?.(f.context)).rejects.toThrow(
      'integration_unavailable',
    );
  });
  it('saves active game state before the provider stop handoff', async () => {
    const f = fixture();
    const save = vi.fn(async () => {});
    vi.mocked(satisfactoryApiConfigured).mockResolvedValue(true);
    vi.mocked(resolveSatisfactoryApi).mockResolvedValue({
      state: async () => ({ isGameRunning: true }),
      save,
    } as unknown as Awaited<ReturnType<typeof resolveSatisfactoryApi>>);
    f.context.operation = () =>
      ({ job_id: 'baf5311a-bec0-4b82-9948-92e77a8401a4' }) as ReturnType<
        GameLifecycleContext['operation']
      >;
    await createSatisfactoryModuleRuntime(codec).prepareStop?.(f.context);
    expect(save).toHaveBeenCalledWith('nh-stop-baf5311a-bec0-4b82-9948-92e77a8401a4');
    expect(f.authorize).toHaveBeenCalledTimes(3);
  });

  it('uploads and verifies both identity files using the authenticated transfer pipeline', async () => {
    const f = fixture();
    const runtime = createSatisfactoryModuleRuntime(codec);
    expect(await runtime.configureProvision(f.context)).toBe(true);
    expect(f.adapter.uploadFile).toHaveBeenCalledTimes(2);
    expect(f.files.has('FactoryGame/Certificates/private_key.pem')).toBe(true);
    expect(f.assertStopped).toHaveBeenCalled();
    await runtime.verifyRestore(f.context);
    expect(new TextDecoder().decode(f.files.get('FactoryGame/Certificates/private_key.pem'))).toBe(
      'private-key',
    );
  });
  it('rejects a provider-installed flag when the game executable is absent', async () => {
    const f = fixture();
    f.adapter.listFiles.mockResolvedValue([]);
    await expect(
      createSatisfactoryModuleRuntime(codec).configureProvision(f.context),
    ).rejects.toMatchObject({
      code: 'configuration_invalid',
      details: { reason: 'installation_outputs_missing' },
    });
    expect(f.adapter.uploadFile).not.toHaveBeenCalled();
  });
  it('classifies a missing executable directory as an installation failure and retains transient provider errors', async () => {
    const f = fixture();
    const runtime = createSatisfactoryModuleRuntime(codec);
    const list = f.adapter.listFiles.getMockImplementation();
    if (!list) throw new Error('fixture listing absent');
    f.adapter.listFiles.mockImplementation(async (id, root) => {
      if (root === 'Engine/Binaries/Linux')
        throw new PterodactylError('not_found', 'client', 'rejected', 404);
      return list(id, root);
    });
    await expect(runtime.configureProvision(f.context)).rejects.toMatchObject({
      code: 'configuration_invalid',
      details: { reason: 'installation_outputs_missing' },
    });
    const unavailable = new PterodactylError('unavailable', 'client', 'unknown', 503);
    f.adapter.listFiles.mockRejectedValueOnce(unavailable);
    await expect(runtime.configureProvision(f.context)).rejects.toBe(unavailable);
    expect(f.adapter.uploadFile).not.toHaveBeenCalled();
  });
  it('does not publish keys when process stop cannot be proven', async () => {
    const f = fixture();
    f.assertStopped.mockRejectedValue(new Error('running'));
    await expect(
      createSatisfactoryModuleRuntime(codec).configureProvision(f.context),
    ).rejects.toThrow('running');
    expect(f.adapter.uploadFile).not.toHaveBeenCalled();
  });
  it('fails closed if uploaded bytes differ', async () => {
    const f = fixture();
    f.adapter.readFile.mockResolvedValue(Buffer.from('different'));
    await expect(
      createSatisfactoryModuleRuntime(codec).configureProvision(f.context),
    ).rejects.toThrow();
  });
});
