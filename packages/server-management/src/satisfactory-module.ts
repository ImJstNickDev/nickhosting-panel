import { DomainError, type SecretCodec } from '@nickhosting/core';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import {
  satisfactoryCertificatePaths,
  satisfactoryManifest,
} from '../../../games/satisfactory/src/index.js';
import type { GameRuntimeHooks, TrustedGameModule } from './game-modules.js';
import type { GameLifecycleContext } from './lifecycle.js';
import { ensureSatisfactoryTlsIdentity } from './satisfactory-tls.js';

export const satisfactoryModule: TrustedGameModule = {
  id: 'satisfactory',
  manifest: satisfactoryManifest,
  managementCapabilities: ['players', 'mods', 'worlds'],
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
    const missingInstallation = () =>
      new DomainError('configuration_invalid', 503, {
        reason: 'installation_outputs_missing',
      });
    // A missing directory can be reported as HTTP 500 by Panel/Wings. Prove
    // absence through its successfully listed parent instead of interpreting
    // an unavailable provider response as an empty installation.
    let parent = '';
    for (const name of ['Engine', 'Binaries', 'Linux']) {
      const entries = await context.adapter.listFiles(identifier, parent);
      const directory = entries.find((entry) => entry.name === name);
      if (!directory || directory.is_file || directory.is_symlink) throw missingInstallation();
      parent = [parent, name].filter(Boolean).join('/');
    }
    const binaries = await context.adapter
      .listFiles(identifier, 'Engine/Binaries/Linux')
      .catch((error: unknown) => {
        if (
          error instanceof PterodactylError &&
          error.reason === 'not_found' &&
          error.outcome === 'rejected'
        )
          throw missingInstallation();
        throw error;
      });
    if (
      !binaries.some(
        (entry) =>
          entry.is_file &&
          !entry.is_symlink &&
          /-Linux-Shipping$/.test(entry.name) &&
          entry.size > 0,
      )
    )
      throw missingInstallation();
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
    cleanupSecrets: async (serverId, db) =>
      (await import('./satisfactory-setup.js')).deleteSatisfactorySetup(db, serverId),
    finalizeStart: async (context) =>
      (await import('./satisfactory-setup.js')).finalizeSatisfactorySetup(context, codec),
    async prepareStop(context) {
      const { satisfactoryApiConfigured, resolveSatisfactoryApi } = await import(
        './satisfactory-api.js'
      );
      if (!(await satisfactoryApiConfigured(context.db, context.server.id))) {
        if (context.operation().plan.gatewayConsole)
          throw new DomainError('integration_unavailable');
        return;
      }
      await context.authorize();
      const api = await resolveSatisfactoryApi(context.db, codec, context.server.id);
      const state = await api.state();
      if (state.isGameRunning) {
        await context.authorize();
        const name = `nh-stop-${context.operation().job_id}`;
        await api.save(name);
        await (await import('./satisfactory-save-retention.js')).captureSatisfactorySafetySave(
          context,
          state.activeSessionName,
          name,
        );
        await context.authorize();
      }
    },
    finalizeStop: async (context) =>
      (await import('./satisfactory-save-retention.js')).rotateSatisfactorySafetySaves(
        context,
        env,
        codec,
      ),
    verifyRestore: configure,
    processContent: async (context) =>
      (await import('./satisfactory-mods.js')).processSatisfactoryMods(context, env),
    async assertRuntimeImage(serverId, db, _requireObserved, snapshot) {
      const server = await db
        .selectFrom('managed_servers as server')
        .innerJoin('runtime_egg_mappings as mapping', 'mapping.id', 'server.mapping_id')
        .select([
          'mapping.game_id',
          'mapping.runtime_id',
          'mapping.docker_image',
          'mapping.egg_id',
          'mapping.image_mode',
        ])
        .where('server.id', '=', serverId)
        .executeTakeFirstOrThrow();
      if (server.game_id !== 'satisfactory' || server.runtime_id !== 'dedicated')
        throw new DomainError('configuration_invalid');
      if (snapshot?.providerServer) {
        const remote = await snapshot.providerServer;
        const policy = satisfactoryManifest.runtimes.find(
          (runtime) => runtime.id === server.runtime_id,
        )?.imagePolicy;
        const expectedImage =
          server.image_mode === 'integration' && policy?.mode === 'fixed'
            ? policy.image
            : server.docker_image;
        if (remote.egg !== server.egg_id || remote.container.image !== expectedImage)
          throw new DomainError('configuration_invalid');
      }
    },
    async assertFileMutation(serverId, paths, connection) {
      if (
        paths.some((path) =>
          Object.values(satisfactoryCertificatePaths).some(
            (protectedPath) => protectedPath === path || protectedPath.startsWith(`${path}/`),
          ),
        )
      )
        throw new DomainError('conflict');
      const modRoot = 'factorygame/mods';
      if (
        paths.some((path) => {
          const normalized = path.replace(/^\/+|\/+$/g, '').toLowerCase();
          return (
            !normalized ||
            normalized === modRoot ||
            normalized.startsWith(`${modRoot}/`) ||
            modRoot.startsWith(`${normalized}/`)
          );
        })
      ) {
        const state = await connection
          .selectFrom('satisfactory_mod_states')
          .select('external_mode')
          .where('server_id', '=', serverId)
          .executeTakeFirst();
        if (state?.external_mode) throw new DomainError('conflict');
      }
    },
    async verifyProcessEpoch(_serverId, _db, before, readAgain) {
      const after = await readAgain();
      if (before !== after) throw new DomainError('operation_uncertain');
      return after;
    },
  };
}
