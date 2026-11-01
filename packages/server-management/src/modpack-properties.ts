import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DomainError } from '@nickhosting/core';
import type { FilemanReadService } from '@nickhosting/game-sdk';
import {
  editMinecraftProperties,
  mergeMinecraftPropertiesText,
  minecraftEditablePropertyKeys,
  parseMinecraftProperties,
} from '../../../games/minecraft/src/management.js';
import { minecraftPropertyEnumName } from '../../../games/minecraft/src/property-enums.js';
import type { ModpackStaged } from '../../content-providers/src/modpack-staging.js';

export interface ModpackPropertiesStage extends ModpackStaged {
  propertiesMerged?: true;
  /** Listing before the one content read binds the merge to the planning snapshot. */
  propertiesSource?: { size: number; modifiedAt: string } | null;
}
const gameplayKeys = minecraftEditablePropertyKeys.filter(
  (key) => !['white-list', 'enforce-whitelist'].includes(key),
);
/** Pack settings only alter supported gameplay fields. Network/authentication,
 * operator/whitelist policy and existing world identity/generation stay local. */
export function mergeModpackProperties(current: string, pack: string, release: string): string {
  const values = parseMinecraftProperties(pack);
  const changes: Record<string, string> = {};
  for (const key of gameplayKeys)
    if (values[key] !== undefined) changes[key] = minecraftPropertyEnumName(key, values[key]);
  let content = Object.keys(changes).length
    ? editMinecraftProperties(current, changes, { release, supportedKeys: gameplayKeys }).content
    : current;
  if (values['enable-command-block'] !== undefined) {
    if (!['true', 'false'].includes(values['enable-command-block']))
      throw new DomainError('validation_failed');
    content = mergeMinecraftPropertiesText(content, {
      'enable-command-block': values['enable-command-block'],
    });
  }
  return content;
}
/** Transforms the private prepared file once; no remote write and no second download. */
export async function prepareModpackProperties(
  staged: ModpackStaged,
  files: FilemanReadService,
): Promise<ModpackPropertiesStage> {
  const property = staged.files.find((file) => file.path === 'server.properties');
  if (!property) return staged;
  if (property.size > 1024 * 1024) throw new DomainError('validation_failed');
  const sourcePath = join(staged.directory, property.path);
  const handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let pack: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== property.size) throw new DomainError('conflict');
    pack = await handle.readFile();
  } finally {
    await handle.close();
  }
  if (createHash('sha256').update(pack).digest('hex') !== property.sha256)
    throw new DomainError('conflict');
  const entry = (await files.list('')).find((file) => file.name === 'server.properties');
  if (entry && (entry.kind !== 'file' || !entry.modifiedAt || entry.size > 1024 * 1024))
    throw new DomainError('conflict');
  const current = await files.read({
    path: 'server.properties',
    maxBytes: 1024 * 1024,
    missing: 'allow',
  });
  if (
    (entry === undefined) !== (current === undefined) ||
    (current && current.byteLength !== entry?.size)
  )
    throw new DomainError('conflict');
  const content = Buffer.from(
    mergeModpackProperties(
      current ? Buffer.from(current).toString('utf8') : '',
      pack.toString('utf8'),
      staged.target.minecraftVersion,
    ),
  );
  if (content.equals(Buffer.from(current ?? [])))
    return { ...staged, files: staged.files.filter((file) => file !== property) };
  const temporary = join(staged.directory, `.properties-${randomUUID()}`);
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    await rename(temporary, sourcePath);
  } finally {
    await rm(temporary, { force: true });
  }
  return {
    ...staged,
    propertiesMerged: true,
    propertiesSource: entry ? { size: entry.size, modifiedAt: entry.modifiedAt as string } : null,
    files: staged.files.map((file) =>
      file === property
        ? {
            path: file.path,
            size: content.length,
            sha256: createHash('sha256').update(content).digest('hex'),
          }
        : file,
    ),
  };
}
