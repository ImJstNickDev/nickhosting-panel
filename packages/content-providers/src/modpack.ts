import { z } from 'zod';
import { hashArchiveFile, readArchiveFile, visitArchive } from './archive.js';
import {
  type ContentLimits,
  type ContentPlan,
  type ContentTarget,
  contentLimits,
  fail,
  safeContentPath,
  validateContentPlan,
} from './contracts.js';
import type { CurseForgeProvider } from './curseforge.js';

const mrpackSchema = z.object({
  formatVersion: z.literal(1),
  game: z.literal('minecraft'),
  versionId: z.string().min(1),
  name: z.string().min(1),
  dependencies: z.record(z.string(), z.string().min(1)),
  files: z
    .array(
      z.object({
        path: z.string(),
        hashes: z.object({
          sha1: z.string().regex(/^[a-f0-9]{40}$/),
          sha512: z.string().regex(/^[a-f0-9]{128}$/),
        }),
        env: z
          .object({
            client: z.enum(['required', 'optional', 'unsupported']),
            server: z.enum(['required', 'optional', 'unsupported']),
          })
          .optional(),
        downloads: z.array(z.string().url()).min(1).max(8),
        fileSize: z.number().int().nonnegative(),
      }),
    )
    .max(10000),
});
const curseSchema = z.object({
  manifestType: z.literal('minecraftModpack'),
  manifestVersion: z.literal(1),
  minecraft: z.object({
    version: z.string().min(1),
    modLoaders: z
      .array(z.object({ id: z.string().min(1), primary: z.boolean() }))
      .min(1)
      .max(8),
  }),
  files: z
    .array(
      z.object({
        projectID: z.number().int().positive(),
        fileID: z.number().int().positive(),
        required: z.boolean(),
      }),
    )
    .max(10000),
  overrides: z.string().min(1),
});
export function targetFromMrpack(dependencies: Record<string, string>): ContentTarget {
  const allowed: Record<string, ContentTarget['loader']> = {
    'fabric-loader': 'fabric',
    forge: 'forge',
    neoforge: 'neoforge',
    'quilt-loader': 'quilt',
  };
  if (
    !dependencies.minecraft ||
    Object.keys(dependencies).some((k) => k !== 'minecraft' && !allowed[k])
  )
    fail('modpack_dependency');
  const loaders = Object.entries(dependencies).filter(([k]) => k !== 'minecraft');
  if (loaders.length > 1) fail('modpack_loader_conflict');
  const selected = loaders[0];
  return selected
    ? {
        minecraftVersion: dependencies.minecraft,
        loader: allowed[selected[0]] as ContentTarget['loader'],
        loaderVersion: selected[1],
      }
    : { minecraftVersion: dependencies.minecraft, loader: 'vanilla' };
}
export async function inspectModpack(
  archivePath: string,
  options: { limits?: Partial<ContentLimits>; curseforge?: CurseForgeProvider } = {},
): Promise<ContentPlan> {
  const limits = contentLimits(options.limits);
  let mr: unknown;
  let cf: unknown;
  const overrides: {
    archivePath: string;
    path: string;
    sha256: string;
    size: number;
    layer: number;
  }[] = [];
  // Read manifests first: ZIP ordering never determines precedence or parsing.
  await visitArchive(
    archivePath,
    async (file) => {
      if (file.path === 'modrinth.index.json')
        mr = JSON.parse((await readArchiveFile(file, limits.maxMetadataBytes)).toString('utf8'));
      if (file.path === 'manifest.json')
        cf = JSON.parse((await readArchiveFile(file, limits.maxMetadataBytes)).toString('utf8'));
    },
    limits,
  );
  if ((mr === undefined) === (cf === undefined)) fail('modpack_manifest');
  let plan: ContentPlan;
  let cfOverrides: string | undefined;
  if (mr !== undefined) {
    const parsed = mrpackSchema.parse(mr);
    plan = {
      format: 'modrinth',
      target: targetFromMrpack(parsed.dependencies),
      artifacts: [],
      overrides: [],
      projects: [],
      warnings: [],
    };
    for (const file of parsed.files) {
      if (file.env?.server === 'unsupported') continue;
      if (file.env?.server === 'optional') {
        plan.warnings.push('content.optional_server_file_skipped');
        continue;
      }
      safeContentPath(file.path);
      plan.artifacts.push({
        path: file.path,
        urls: file.downloads,
        size: file.fileSize,
        hashes: file.hashes,
        kind: file.path.startsWith('plugins/')
          ? 'plugin'
          : file.path.startsWith('mods/')
            ? 'mod'
            : 'override',
        serverSide: 'required',
      });
    }
  } else {
    const parsed = curseSchema.parse(cf);
    if (!options.curseforge) fail('curseforge_credentials');
    if (parsed.minecraft.modLoaders.length !== 1 || !parsed.minecraft.modLoaders[0]?.primary)
      fail('modpack_loader_conflict');
    const match = /^(forge|fabric|neoforge|quilt)-(.+)$/.exec(parsed.minecraft.modLoaders[0].id);
    if (!match) fail('modpack_loader');
    const target: ContentTarget = {
      minecraftVersion: parsed.minecraft.version,
      loader: match[1] as ContentTarget['loader'],
      loaderVersion: match[2],
    };
    plan = await options.curseforge.resolveMany(
      parsed.files
        .filter((f) => f.required)
        .map(({ projectID, fileID }) => ({ projectID, fileID })),
      target,
    );
    cfOverrides = parsed.overrides;
    if (!/^[A-Za-z0-9_-]+$/.test(cfOverrides)) fail('overrides_path');
    if (parsed.files.some((f) => !f.required))
      plan.warnings.push('content.optional_server_file_skipped');
  }
  await visitArchive(
    archivePath,
    async (file) => {
      const roots = cfOverrides ? [`${cfOverrides}/`] : ['overrides/', 'server-overrides/'];
      const layer = roots.findIndex((root) => file.path.startsWith(root));
      if (layer < 0) return;
      const root = roots[layer];
      if (!root) fail('overrides_path');
      const path = safeContentPath(file.path.slice(root.length));
      overrides.push({
        archivePath: file.path,
        path,
        size: file.size,
        sha256: await hashArchiveFile(file),
        layer,
      });
    },
    limits,
  );
  const selected = new Map<string, (typeof overrides)[number]>();
  for (const override of overrides.sort((a, b) => a.layer - b.layer)) {
    const key = override.path.toLowerCase();
    const previous = selected.get(key);
    if (previous && previous.path !== override.path) fail('override_case_conflict');
    selected.set(key, override);
  }
  // The specification explicitly layers common then server overrides after downloads.
  plan.artifacts = plan.artifacts.filter((a) => !selected.has(a.path.toLowerCase()));
  plan.overrides = [...selected.values()].map(({ layer: _layer, ...file }) => file);
  return validateContentPlan(plan);
}
