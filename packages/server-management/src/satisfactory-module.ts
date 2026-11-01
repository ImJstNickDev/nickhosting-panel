import { DomainError, type SecretCodec } from '@nickhosting/core';
import {
  satisfactoryCertificatePaths,
  satisfactoryManifest,
} from '../../../games/satisfactory/src/index.js';
import type { GameRuntimeHooks, TrustedGameModule } from './game-modules.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { processSatisfactoryMods } from './satisfactory-mods.js';
import { ensureSatisfactoryTlsIdentity } from './satisfactory-tls.js';

export const satisfactoryModule: TrustedGameModule = {
  id: 'satisfactory',
  manifest: satisfactoryManifest,
  provisionAsResourceOwner: true,
  async assertProfileBinding(_db, _server, mapping) {
    if (mapping.game_id === 'satisfactory' && mapping.runtime_id !== 'dedicated')
      throw new DomainError('configuration_invalid');
  },
  async authorizeOperation({ mapping }) {
    if (mapping.runtime_id !== 'dedicated') throw new DomainError('configuration_invalid');
  },
  async filterCatalog(_db, _context, entry) {
    return entry;
  },
  async gatewayPolicyBinding() {
    return { protocolId: 'satisfactory', gameVersion: 'dedicated' };
  },
};

export function createSatisfactoryModuleRuntime(
  codec: SecretCodec,
  env: Readonly<Record<string, string | undefined>> = {},
): GameRuntimeHooks & { id: string } {
  async function configure(context: GameLifecycleContext) {
    const identifier = context.server.pterodactyl_identifier;
    if (!identifier) throw new DomainError('integration_unavailable');
    await context.authorize();
    await context.assertStopped();
    const identity = await ensureSatisfactoryTlsIdentity(context.db, codec, context.server.id);
    for (const [path, value] of [
      [satisfactoryCertificatePaths.certificate, identity.certificatePem],
      [satisfactoryCertificatePaths.privateKey, identity.privateKeyPem],
    ] as const) {
      const parts = path.split('/');
      for (let index = 0; index < parts.length - 1; index++) {
        const root = parts.slice(0, index).join('/');
        const name = parts[index];
        if (!name) throw new DomainError('configuration_invalid');
        const entries = await context.adapter.listFiles(identifier, root);
        const entry = entries.find(
          (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
        );
        if (entry && (entry.name !== name || entry.is_symlink || entry.is_file))
          throw new DomainError('conflict');
        if (!entry)
          await context.effect(`satisfactory.directory.${index}`, async () => {
            await context.authorize();
            await context.assertStopped();
            await context.adapter.createDirectory(identifier, root, name);
          });
      }
      const bytes = Buffer.from(value);
      await context.effect(`satisfactory.tls.${parts.at(-1)}`, async () => {
        await context.authorize();
        await context.assertStopped();
        await context.adapter.uploadFile(identifier, path, {
          privateFile: true,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          }),
          contentLength: bytes.length,
          maxBytes: bytes.length,
          authorize: async () => {
            await context.authorize();
            await context.assertStopped();
          },
        });
      });
      const actual = await context.adapter.readFile(identifier, path, 32768);
      if (!Buffer.from(actual).equals(bytes)) throw new DomainError('operation_uncertain');
    }
    return true;
  }
  return {
    id: satisfactoryModule.id,
    configureProvision: configure,
    verifyRestore: configure,
    processContent: (context) => processSatisfactoryMods(context, env),
    async assertRuntimeImage(serverId, db, _requireObserved, snapshot) {
      const server = await db
        .selectFrom('managed_servers as server')
        .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
        .select(['mapping.game_id', 'mapping.runtime_id', 'mapping.docker_image', 'mapping.egg_id'])
        .where('server.id', '=', serverId)
        .executeTakeFirstOrThrow();
      if (server.game_id !== 'satisfactory' || server.runtime_id !== 'dedicated')
        throw new DomainError('configuration_invalid');
      if (snapshot?.providerServer) {
        const remote = await snapshot.providerServer;
        if (remote.egg !== server.egg_id || remote.container.image !== server.docker_image)
          throw new DomainError('configuration_invalid');
      }
    },
    async assertFileMutation(_serverId, paths) {
      if (
        paths.some((path) =>
          Object.values(satisfactoryCertificatePaths).some(
            (protectedPath) => protectedPath === path || protectedPath.startsWith(`${path}/`),
          ),
        )
      )
        throw new DomainError('conflict');
    },
    async verifyProcessEpoch(_serverId, _db, before, readAgain) {
      const after = await readAgain();
      if (before !== after) throw new DomainError('operation_uncertain');
      return after;
    },
  };
}
