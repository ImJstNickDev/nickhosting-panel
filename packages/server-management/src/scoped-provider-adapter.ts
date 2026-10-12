import { DomainError } from '@nickhosting/core';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';

/** Client calls always use the managed resource owner's credentials, never the actor's.
 * Composite operations select by their second (Client identifier) argument. */
const identifierArguments: Partial<Record<keyof PterodactylAdapter, number>> = {
  getClientServer: 0,
  getClientPermissions: 0,
  getResources: 0,
  confirmInstallation: 1,
  reinstallWithConfirmation: 1,
  stopWithConfirmation: 1,
  power: 0,
  reinstall: 0,
  sendCommand: 0,
  listFiles: 0,
  readFile: 0,
  writeFile: 0,
  deleteFiles: 0,
  createDirectory: 0,
  renameFiles: 0,
  listBackups: 0,
  listBackupActivity: 0,
  listPowerActivity: 0,
  getBackup: 0,
  createBackup: 0,
  deleteBackup: 0,
  restoreBackup: 0,
  downloadBackup: 0,
  downloadFile: 0,
  uploadFile: 0,
  prepareUpload: 0,
  prepareUploadBatch: 0,
  relayConsole: 0,
};
export function createScopedProviderAdapter(
  application: PterodactylAdapter,
  resolve: (identifier: string) => Promise<PterodactylAdapter>,
): PterodactylAdapter {
  return new Proxy(application, {
    get(target, property, receiver) {
      if (property === 'getAccount' || property === 'listClientServers')
        return async () => {
          throw new DomainError('forbidden');
        };
      if (property === 'discoverCapabilities')
        return async () => {
          const { client: _client, ...applicationScopes } =
            await target.discoverCapabilities(false);
          return applicationScopes;
        };
      const index = identifierArguments[property as keyof PterodactylAdapter];
      if (index !== undefined)
        return async (...args: unknown[]) => {
          const identifier = args[index];
          if (typeof identifier !== 'string' || !identifier) throw new DomainError('forbidden');
          const scoped = await resolve(identifier);
          const method = Reflect.get(scoped, property);
          return Reflect.apply(method, scoped, args);
        };
      return Reflect.get(target, property, receiver);
    },
  });
}
