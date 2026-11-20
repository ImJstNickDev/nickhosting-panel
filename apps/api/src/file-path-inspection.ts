import { DomainError } from '@nickhosting/core';
import {
  type PterodactylAdapter,
  relativePath,
  type ServerFile,
} from '@nickhosting/pterodactyl-adapter';

/** Check every component; the provider still owns the filesystem sandbox. */
export async function inspectFilePath(
  adapter: Pick<PterodactylAdapter, 'listFiles'>,
  id: string,
  value: string,
) {
  const parts = relativePath(value).slice(1).split('/');
  let directory = '';
  let entry: ServerFile | undefined;
  for (let index = 0; index < parts.length; index++) {
    entry = (await adapter.listFiles(id, directory)).find((file) => file.name === parts[index]);
    if (!entry) {
      if (index === parts.length - 1) return undefined;
      throw new DomainError('not_found');
    }
    if (entry.is_symlink || (index < parts.length - 1 && entry.is_file))
      throw new DomainError('forbidden');
    directory = [directory, parts[index]].filter(Boolean).join('/');
  }
  return entry;
}
