import { randomUUID } from 'node:crypto';
import { SecretCodec } from '@nickhosting/core';
import { describe, expect, it, vi } from 'vitest';
import type { GameLifecycleContext } from './lifecycle.js';
import { createSatisfactoryModuleRuntime } from './satisfactory-module.js';

vi.mock('./satisfactory-tls.js', () => ({
  ensureSatisfactoryTlsIdentity: vi.fn(async () => ({
    certificatePem: 'certificate',
    privateKeyPem: 'private-key',
  })),
}));
const codec = new SecretCodec({ activeKeyId: 'test', keys: { test: Buffer.alloc(32, 42) } });
function fixture() {
  const files = new Map<string, Uint8Array>();
  const directories = new Set(['FactoryGame']);
  const authorize = vi.fn(async () => {});
  const assertStopped = vi.fn(async () => {});
  const adapter = {
    listFiles: vi.fn(async (_id: string, root: string) =>
      [...directories]
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
      effect: async (_phase: string, perform: () => Promise<unknown>) => {
        await perform();
        return true;
      },
    } as unknown as GameLifecycleContext,
  };
}
describe('Satisfactory prestart TLS distribution', () => {
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
