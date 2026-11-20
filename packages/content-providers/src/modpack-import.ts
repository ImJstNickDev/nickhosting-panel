import { z } from 'zod';
import { type ContentTarget, fail } from './contracts.js';

const markers = {
  'modrinth.index.json': 'modrinth-index',
  'manifest.json': 'curseforge-manifest',
  'mmc-pack.json': 'launcher-instance',
} as const;
export type ImportedModpackFormat = (typeof markers)[keyof typeof markers];
export const importMetadataNames = [...Object.keys(markers), 'instance.cfg'];
/** Identify a single exported instance, either at the root or under one wrapper. */
export function identifyModpackImport(manifests: ReadonlyMap<string, Buffer>) {
  const candidates = [...manifests.keys()].flatMap((path) => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    const match = Object.entries(markers).find(([marker]) => marker === name);
    return match ? [{ root: path.slice(0, -name.length), format: match[1] }] : [];
  });
  const [candidate] = candidates;
  if (!candidate || candidates.length !== 1) fail('modpack_archive_format');
  return candidate;
}
const loaders: Record<string, ContentTarget['loader']> = {
  'net.fabricmc.fabric-loader': 'fabric',
  'net.minecraftforge': 'forge',
  'net.neoforged': 'neoforge',
  'org.quiltmc.quilt-loader': 'quilt',
};
const dependencies = new Set([
  'net.minecraft.java',
  'net.adoptium.java',
  'com.azul.java',
  'com.ibm.java',
  'org.lwjgl',
  'org.lwjgl3',
  'net.fabricmc.intermediary',
  'org.quiltmc.hashed',
  'org.quiltmc.intermediary',
  'net.minecraft.launchwrapper',
]);
const component = z.object({
  uid: z.string().min(1),
  version: z.string().trim().min(1).max(128).optional(),
});
export function launcherImportTarget(raw: unknown): ContentTarget {
  const { components } = z
    .object({ formatVersion: z.literal(1), components: z.array(component).max(100) })
    .parse(raw);
  const mc = components.filter((item) => item.uid === 'net.minecraft');
  const mod = components.filter((item) => Object.hasOwn(loaders, item.uid));
  if (
    mc.length !== 1 ||
    !mc[0]?.version ||
    mod.length > 1 ||
    mod.some((item) => !item.version) ||
    components.some(
      (item) =>
        item.uid !== 'net.minecraft' &&
        !Object.hasOwn(loaders, item.uid) &&
        !dependencies.has(item.uid),
    )
  )
    fail('modpack_target_unresolved');
  return {
    minecraftVersion: mc[0].version,
    loader: mod[0] ? (loaders[mod[0].uid] ?? fail('modpack_target_unresolved')) : 'vanilla',
    ...(mod[0] ? { loaderVersion: mod[0].version } : {}),
  };
}
const nativeRoots = new Set([
  'mods',
  'plugins',
  'config',
  'defaultconfigs',
  'kubejs',
  'scripts',
  'coremods',
  'openloader',
  'datapacks',
  'global_packs',
  'globalpacks',
  'patchouli_books',
  'crafttweaker',
  'serverconfig',
]);
export function importServerPath(path: string, native: boolean) {
  const lower = path.toLowerCase();
  if (
    /^(?:resourcepacks|shaderpacks|screenshots|saves|crash-reports|logs|journeymap|xaeroworldmap|xaerominimap)\//.test(
      lower,
    ) ||
    /^kubejs\/(?:client_scripts|assets)\//.test(lower) ||
    /^(?:options(?:of|shaders)?\.txt|servers\.dat(?:_old)?|accounts\.json)$/.test(lower) ||
    (native && lower.split('/').some((part) => part.startsWith('.'))) ||
    lower.endsWith('.jar.disabled')
  )
    return false;
  return (
    !native ||
    lower === 'server.properties' ||
    (lower.includes('/') && nativeRoots.has(lower.slice(0, lower.indexOf('/'))))
  );
}
