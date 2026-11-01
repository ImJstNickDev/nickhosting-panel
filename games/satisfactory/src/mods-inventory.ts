import { z } from 'zod';
import {
  type SatisfactoryModLock,
  type SatisfactoryModSelection,
  satisfactoryModLockSchema,
  satisfactoryModReferenceSchema,
  satisfactoryVersionPaths,
} from './mods.js';

export type SatisfactoryInventoryEntry = {
  name: string;
  is_file: boolean;
  is_symlink: boolean;
  size: number;
};
export type SatisfactoryInventoryMod = {
  reference: string;
  name: string;
  version: string | null;
  path: string;
  gameFeature: boolean;
  /** Upstream .smm marker only; not proof of NickPanel ownership. */
  managed: boolean;
  direct: boolean;
  dependency: boolean;
  enabled: boolean;
  dependencies: string[];
  issues: string[];
};
export type SatisfactoryInventory = {
  items: SatisfactoryInventoryMod[];
  lockfiles: { path: string; lock: SatisfactoryModLock }[];
  issues: { path: string; reason: string }[];
  gameBuild: number | null;
};
const descriptorSchema = z.object({
  FriendlyName: z.string().max(256).optional(),
  VersionName: z.string().max(256).optional(),
  Plugins: z
    .array(z.object({ Name: z.string().max(128), Enabled: z.boolean().optional() }))
    .max(512)
    .optional(),
});

/** Read bounded metadata through the existing adapter. Never follows symlinks,
 * downloads native binaries or infers ownership from the presence of a mod.
 * Lockfiles are observations only: do not seed a resolver from external locks.
 */
export async function readSatisfactoryModInventory(input: {
  listFiles: (path: string) => Promise<SatisfactoryInventoryEntry[]>;
  readFile: (path: string, maxBytes: number) => Promise<string | Buffer>;
  selection?: SatisfactoryModSelection;
  lock?: SatisfactoryModLock;
}): Promise<SatisfactoryInventory> {
  const result: SatisfactoryInventory = { items: [], lockfiles: [], issues: [], gameBuild: null };
  let entriesSeen = 0;
  const lists = new Map<string, SatisfactoryInventoryEntry[]>();
  const list = async (path: string) => {
    const cached = lists.get(path);
    if (cached) return cached;
    const entries = await input.listFiles(path);
    entriesSeen += entries.length;
    if (entriesSeen > 20000) throw new Error('satisfactory_inventory_limit');
    if (
      entries.some(
        (entry) =>
          !entry.name ||
          [...entry.name].some(
            (char) => char.charCodeAt(0) < 32 || char === '/' || char === '\\',
          ) ||
          entry.name === '.' ||
          entry.name === '..',
      )
    )
      throw new Error('satisfactory_inventory_invalid');
    lists.set(path, entries);
    return entries;
  };
  const directory = async (path: string): Promise<boolean> => {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i++) {
      const entry = (await list(parts.slice(0, i).join('/'))).find(
        (entry) => entry.name === parts[i],
      );
      if (!entry) return false;
      if (entry.is_file || entry.is_symlink) {
        result.issues.push({ path: parts.slice(0, i + 1).join('/'), reason: 'unsafe_path' });
        return false;
      }
    }
    return true;
  };
  const readJson = async (
    path: string,
    entry: SatisfactoryInventoryEntry,
    limit: number,
  ): Promise<unknown> => {
    if (!entry.is_file || entry.is_symlink || entry.size > limit)
      throw new Error('satisfactory_inventory_invalid');
    const content = await input.readFile(path, limit);
    if (Buffer.byteLength(content) > limit) throw new Error('satisfactory_inventory_limit');
    try {
      return JSON.parse(content.toString());
    } catch {
      return null;
    }
  };
  if (await directory('Engine/Binaries/Linux')) {
    const entries = await list('Engine/Binaries/Linux');
    for (const path of satisfactoryVersionPaths) {
      const entry = entries.find((entry) => entry.name === path.split('/').at(-1));
      if (!entry) continue;
      const parsed = z
        .object({ Changelist: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
        .safeParse(await readJson(path, entry, 65536));
      if (parsed.success) {
        result.gameBuild = parsed.data.Changelist;
        break;
      }
      result.issues.push({ path, reason: 'invalid_game_version' });
    }
  }
  if (!(await directory('FactoryGame/Mods'))) return result;
  const root = await list('FactoryGame/Mods');
  for (const entry of root) {
    if (!entry.name.endsWith('-lock.json')) continue;
    const path = `FactoryGame/Mods/${entry.name}`;
    if (!entry.is_file || entry.is_symlink || entry.size > 1048576) {
      result.issues.push({ path, reason: 'invalid_lockfile' });
      continue;
    }
    const parsed = satisfactoryModLockSchema.safeParse(await readJson(path, entry, 1048576));
    if (parsed.success) result.lockfiles.push({ path, lock: parsed.data });
    else result.issues.push({ path, reason: 'invalid_lockfile' });
  }
  const selected = new Map((input.selection ?? []).map((mod) => [mod.reference, mod]));
  const hasContents = async (path: string, depth = 0): Promise<boolean> => {
    if (depth > 32) throw new Error('satisfactory_inventory_limit');
    for (const entry of await list(path)) {
      if (
        entry.is_file ||
        entry.is_symlink ||
        (await hasContents(`${path}/${entry.name}`, depth + 1))
      )
        return true;
    }
    return false;
  };
  for (const base of ['FactoryGame/Mods', 'FactoryGame/Mods/GameFeatures']) {
    if (base.endsWith('/GameFeatures') && !(await directory(base))) continue;
    for (const entry of await list(base)) {
      if (entry.name === 'GameFeatures' || entry.is_file) continue;
      const path = `${base}/${entry.name}`;
      if (entry.is_symlink) {
        result.issues.push({ path, reason: 'unsafe_path' });
        continue;
      }
      if (!satisfactoryModReferenceSchema.safeParse(entry.name).success) {
        result.issues.push({ path, reason: 'unknown_directory' });
        continue;
      }
      const files = await list(path);
      const descriptor = files.find((file) => file.name === `${entry.name}.uplugin`);
      const marker = files.find((file) => file.name === '.smm');
      // File-based removal can leave empty provider directories. They are not
      // installed mods; retain nonempty unknown trees as visible observations.
      if (!descriptor && !marker && !(await hasContents(path))) continue;
      const issues: string[] = [];
      let metadata: z.infer<typeof descriptorSchema> | undefined;
      if (descriptor?.is_file && !descriptor.is_symlink && descriptor.size <= 1048576) {
        const parsed = descriptorSchema.safeParse(
          await readJson(`${path}/${descriptor.name}`, descriptor, 1048576),
        );
        if (parsed.success) metadata = parsed.data;
        else issues.push('invalid_descriptor');
      } else issues.push(descriptor ? 'invalid_descriptor' : 'missing_descriptor');
      if (marker?.is_symlink || (marker && !marker.is_file)) issues.push('invalid_marker');
      if (result.items.some((mod) => mod.reference === entry.name))
        issues.push('duplicate_reference');
      const direct = selected.has(entry.name);
      result.items.push({
        reference: entry.name,
        name: metadata?.FriendlyName || entry.name,
        version: metadata?.VersionName ?? null,
        path,
        gameFeature: base.endsWith('/GameFeatures'),
        managed: Boolean(marker?.is_file && !marker.is_symlink),
        direct,
        dependency: !direct || selected.get(entry.name)?.enabled === false,
        enabled: selected.get(entry.name)?.enabled !== false,
        dependencies:
          metadata?.Plugins?.filter((plugin) => plugin.Enabled !== false)
            .map((plugin) => plugin.Name)
            .sort() ?? [],
        issues,
      });
    }
  }
  result.items.sort(
    (a, b) => a.reference.localeCompare(b.reference) || a.path.localeCompare(b.path),
  );
  result.lockfiles.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
