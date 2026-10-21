import { DomainError } from '@nickhosting/core';
import type {
  FilemanEntry,
  FilemanJobServices,
  FilemanTransferManifest,
} from '@nickhosting/game-sdk';
import type { PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import { z } from 'zod';
import { minecraftModpackPathSchema } from '../../../games/minecraft/src/modpack-contracts.js';
import {
  type MinecraftModpackFile,
  type MinecraftModpackPlan,
  modpackDigest,
  modpackFileSchema,
  modpackPlanSchema,
  type PreparedMinecraftModpack,
  preparedModpackSchema,
} from './minecraft-modpacks-plan.js';

type ArchiveInput = Parameters<NonNullable<FilemanJobServices['uploadArchive']>>[0];
export type ModpackPublicationArchive = Omit<
  ArchiveInput,
  'id' | 'destinationRoot' | 'beforePublish' | 'beforeWrite'
>;
const moveSchema = z.strictObject({
  from: minecraftModpackPathSchema,
  to: minecraftModpackPathSchema,
});
const fingerprintSchema = z.strictObject({
  path: minecraftModpackPathSchema,
  kind: z.enum(['file', 'directory']),
  size: z.number().int().nonnegative().safe(),
  modifiedAt: z.string().min(1),
});
const publicationSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.uuid(),
  binding: z.string().regex(/^[a-f0-9]{64}$/),
  state: z.enum(['staging', 'staged', 'retiring', 'publishing', 'verified', 'cleaning', 'cleaned']),
  stageFiles: z.array(modpackFileSchema.extend({ modifiedAt: z.string().min(1) })).max(10000),
  retire: z.array(moveSchema).max(20000),
  publish: z.array(moveSchema).max(10000),
  retiredEntries: z.array(fingerprintSchema).max(40000),
  batches: z
    .array(
      z.strictObject({
        phase: z.enum(['retire', 'publish']),
        moves: z.array(moveSchema).min(1).max(1000),
      }),
    )
    .max(30),
  rollbackCreated: z.boolean(),
});
/** Stored in the operation's publication JSON, separately from the phase journal.
 * Exact batches are saved before dispatch; failed or partial renames are never replayed. */
export type ModpackPublicationJournal = z.infer<typeof publicationSchema>;
export type ModpackPublicationRecovery =
  | { state: 'applied'; files: MinecraftModpackFile[] }
  | { state: 'unchanged' | 'partial' | 'unknown' };

type Move = z.infer<typeof moveSchema>;
type Fingerprint = z.infer<typeof fingerprintSchema>;
type Entries = ReadonlyMap<string, FilemanEntry>;
const parents = (path: string) => {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
};
const matchingRoot = (path: string, roots: ReadonlySet<string>) =>
  [path, ...parents(path).reverse()].find((candidate) => roots.has(candidate));
const pathIndex = (paths: readonly string[]) => ({
  roots: new Set(paths),
  ancestors: new Set(paths.flatMap(parents)),
});
const overlapsIndex = (path: string, index: ReturnType<typeof pathIndex>) =>
  index.ancestors.has(path) || Boolean(matchingRoot(path, index.roots));
const dirname = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));
const chunks = <T>(values: readonly T[], size: number) =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  );
const same = (current: FilemanEntry | undefined, expected: Omit<Fingerprint, 'path'>) =>
  Boolean(
    current &&
      current.kind === expected.kind &&
      (expected.kind === 'directory' || current.size === expected.size) &&
      current.modifiedAt === expected.modifiedAt,
  );

/** Only generated top-level directories belong to this publication. Never infer
 * cleanup ownership from a user-supplied path or a remote folder's name alone. */
export function modpackRemoteStage(operationId: string) {
  const id = z.uuid().parse(operationId);
  return {
    stagingRoot: `.nickhosting-pack-${id}-stage`,
    rollbackRoot: `.nickhosting-pack-${id}-rollback`,
  };
}

export function createModpackPublication(options: {
  operationId: string;
  identifier: string;
  fileman: FilemanJobServices;
  adapter: Pick<PterodactylAdapter, 'renameFiles' | 'createDirectory' | 'deleteFiles'>;
  authorize(): Promise<unknown>;
  archive(
    prepared: PreparedMinecraftModpack,
    files: readonly MinecraftModpackFile[],
    destinationRoot: string,
  ): Promise<ModpackPublicationArchive>;
  readJournal(): Promise<unknown>;
  saveJournal(journal: ModpackPublicationJournal): Promise<void>;
}) {
  const roots = modpackRemoteStage(options.operationId);
  const validate = (prepared: PreparedMinecraftModpack, plan: MinecraftModpackPlan) => {
    preparedModpackSchema.parse(prepared);
    modpackPlanSchema.parse(plan);
    if (plan.blockers.length || plan.write.length > 10000 || !options.fileman.readScope)
      throw new DomainError('validation_failed');
    const available = new Map(prepared.files.map((file) => [file.path, file]));
    const touched = [...plan.write.map((file) => file.path), ...plan.remove];
    const protectedIndex = pathIndex([...plan.protectedPaths, ...plan.preserve]);
    const removed = new Set(plan.remove);
    if (
      plan.write.some((file) => {
        const source = available.get(file.path);
        return !source || source.sha256 !== file.sha256 || source.size !== file.size;
      }) ||
      new Set(plan.write.map((file) => file.path.toLowerCase())).size !== plan.write.length ||
      new Set(plan.remove).size !== plan.remove.length ||
      plan.remove.some((path) => parents(path).some((parent) => removed.has(parent))) ||
      touched.some(
        (path) => path.split('/')[0]?.startsWith('.') || overlapsIndex(path, protectedIndex),
      )
    )
      throw new DomainError('validation_failed');
    return modpackDigest({ operationId: options.operationId, plan, prepared });
  };
  const load = async (binding: string) => {
    const raw = await options.readJournal();
    if (raw == null) return null;
    const journal = publicationSchema.parse(raw);
    if (journal.operationId !== options.operationId || journal.binding !== binding)
      throw new DomainError('conflict');
    return journal;
  };
  const save = async (journal: ModpackPublicationJournal) => {
    const validated = publicationSchema.parse(journal);
    await options.saveJournal(validated);
    return validated;
  };

  /** One fresh Fileman metadata scope per mutation phase; directories are batched,
   * and shared parents are listed only once. No file download or per-file hash pass. */
  const inspect = async (paths: readonly string[]): Promise<Entries> => {
    const scope = options.fileman.readScope?.();
    if (!scope) throw new DomainError('integration_unavailable');
    const requested = [...new Set(paths.flatMap((path) => [...parents(path), path]))];
    const directories = [...new Set(requested.map(dirname))];
    const entries = new Map<string, FilemanEntry>();
    const missing = new Set<string>();
    for (const batch of chunks(directories, 100)) {
      const results = await scope.listMany(batch);
      const returned = new Set<string>();
      for (const result of results) {
        if (!batch.includes(result.directory) || returned.has(result.directory))
          throw new DomainError('operation_uncertain');
        returned.add(result.directory);
        if ('error' in result) {
          if (result.error !== 'not_found') throw new DomainError('operation_uncertain');
          missing.add(result.directory);
          continue;
        }
        const names = new Set<string>();
        for (const entry of result.files) {
          if (
            !entry.name ||
            entry.name.includes('/') ||
            entry.name.includes('\\') ||
            entry.name === '.' ||
            entry.name === '..' ||
            names.has(entry.name.toLowerCase())
          )
            throw new DomainError('operation_uncertain');
          names.add(entry.name.toLowerCase());
          entries.set([result.directory, entry.name].filter(Boolean).join('/'), entry);
        }
      }
      if (returned.size !== batch.length) throw new DomainError('operation_uncertain');
    }
    for (const path of requested) {
      if (
        parents(path).some((parent) => {
          const entry = entries.get(parent);
          return entry && entry.kind !== 'directory';
        })
      )
        throw new DomainError('operation_uncertain');
    }
    // A provider 404 cannot hide a directory which its parent's listing says exists.
    for (const directory of missing)
      if (!directory || entries.has(directory)) throw new DomainError('operation_uncertain');
    return entries;
  };
  const retirement = (plan: MinecraftModpackPlan) => {
    const expected = new Map(plan.expected.map((item) => [item.path, item.entry]));
    const retire = plan.remove.map((path, index) => {
      const entry = expected.get(path);
      if (!entry || entry.kind === 'symlink' || !entry.modifiedAt)
        throw new DomainError('validation_failed');
      return { from: path, to: `${roots.rollbackRoot}/${index}` };
    });
    const retiredRoots = new Set(plan.remove);
    const retiredDestinations = new Map(retire.map((move) => [move.from, move.to]));
    const retiredEntries = plan.expected.flatMap(({ path, entry }) => {
      const root = matchingRoot(path, retiredRoots);
      if (!root || !entry) return [];
      if (entry.kind === 'symlink' || !entry.modifiedAt) throw new DomainError('validation_failed');
      return [
        {
          path: retiredDestinations.get(root) + path.slice(root.length),
          kind: entry.kind,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
        },
      ];
    });
    return { retire, retiredEntries };
  };
  const publicationMoves = (plan: MinecraftModpackPlan): Move[] => {
    const expected = new Map(plan.expected.map((item) => [item.path, item.entry]));
    const destinations = new Set<string>();
    const removed = new Set(plan.remove);
    for (const file of plan.write) {
      let destination = file.path;
      for (const path of [...parents(file.path), file.path]) {
        if (!expected.has(path)) throw new DomainError('validation_failed');
        if (expected.get(path) == null || matchingRoot(path, removed)) {
          destination = path;
          break;
        }
        if (path === file.path || expected.get(path)?.kind !== 'directory')
          throw new DomainError('validation_failed');
      }
      destinations.add(destination);
    }
    // Only staged writes inhabit these trees; moving a new subtree preserves all
    // verified files and avoids a mkdir or rename request for every child.
    return [...destinations].sort().map((path) => ({
      from: `${roots.stagingRoot}/${path}`,
      to: path,
    }));
  };
  const originalUnchanged = (plan: MinecraftModpackPlan, entries: Entries) =>
    plan.expected.every(({ path, entry }) => {
      const current = entries.get(path);
      return entry === null
        ? !current
        : Boolean(
            current &&
              current.kind === entry.kind &&
              (entry.kind === 'directory' || current.size === entry.size) &&
              entry.modifiedAt &&
              current.modifiedAt === entry.modifiedAt,
          );
    });
  const finalFiles = (journal: ModpackPublicationJournal, entries: Entries) => {
    const files: MinecraftModpackFile[] = [];
    const publishedPaths = new Set(
      journal.stageFiles.flatMap((file) => [...parents(file.path), file.path]),
    );
    const publishedIndex = pathIndex(journal.publish.map((move) => move.to));
    for (const file of journal.stageFiles) {
      if (
        entries.has(`${roots.stagingRoot}/${file.path}`) ||
        !same(entries.get(file.path), { ...file, kind: 'file' })
      )
        return null;
      files.push({ ...file });
    }
    for (const entry of journal.retiredEntries)
      if (!same(entries.get(entry.path), entry)) return null;
    for (const move of journal.retire) {
      const replacement =
        publishedIndex.roots.has(move.from) || publishedIndex.ancestors.has(move.from);
      if (!replacement && entries.has(move.from)) return null;
    }
    // New/replaced directory subtrees contain only the sealed archive selection.
    // This also detects old children left behind by an incomplete replacement.
    for (const path of entries.keys())
      if (matchingRoot(path, publishedIndex.roots) && !publishedPaths.has(path)) return null;
    return files;
  };
  const observationPaths = (journal: ModpackPublicationJournal) => [
    ...journal.stageFiles.flatMap((file) => [file.path, `${roots.stagingRoot}/${file.path}`]),
    ...journal.retire.flatMap((move) => [move.from, move.to]),
    ...journal.retiredEntries.map((entry) => entry.path),
    roots.stagingRoot,
    roots.rollbackRoot,
  ];
  const verify = async (prepared: PreparedMinecraftModpack, plan: MinecraftModpackPlan) => {
    const journal = await load(validate(prepared, plan));
    if (!journal || !['publishing', 'verified'].includes(journal.state)) return null;
    const entries = await inspect(observationPaths(journal));
    const files = finalFiles(journal, entries);
    if (files && journal.state !== 'verified') await save({ ...journal, state: 'verified' });
    return files;
  };

  return {
    getRemoteStage(plan: MinecraftModpackPlan) {
      modpackPlanSchema.parse(plan);
      return { ...roots };
    },
    async publish(prepared: PreparedMinecraftModpack, plan: MinecraftModpackPlan) {
      const binding = validate(prepared, plan);
      if (await load(binding)) throw new DomainError('operation_uncertain');
      const { retire, retiredEntries } = retirement(plan);
      const publish = publicationMoves(plan);
      const initial = await inspect([
        roots.stagingRoot,
        roots.rollbackRoot,
        ...(plan.write.length ? [] : plan.expected.map((entry) => entry.path)),
      ]);
      if (initial.has(roots.stagingRoot) || initial.has(roots.rollbackRoot))
        throw new DomainError('conflict');
      if (!plan.write.length && !originalUnchanged(plan, initial))
        throw new DomainError('conflict');
      let journal = await save({
        version: 1,
        operationId: options.operationId,
        binding,
        state: 'staging',
        stageFiles: [],
        retire,
        retiredEntries,
        publish,
        batches: [],
        rollbackCreated: false,
      });
      if (plan.write.length) {
        if (!options.fileman.uploadArchive) throw new DomainError('integration_unavailable');
        const archive = await options.archive(prepared, plan.write, roots.stagingRoot);
        const expected = new Map(
          plan.write.map((file) => [`${roots.stagingRoot}/${file.path}`, file]),
        );
        const validateManifest = (manifest: FilemanTransferManifest) => {
          if (
            manifest.destinationRoot !== roots.stagingRoot ||
            manifest.files.length !== expected.size ||
            new Set(manifest.files.map((file) => file.path)).size !== expected.size ||
            manifest.files.some((file) => {
              const source = expected.get(file.path);
              return !source || source.size !== file.size || source.sha256 !== file.sha256;
            })
          )
            throw new DomainError('conflict');
        };
        const receipt = await options.fileman.uploadArchive({
          ...archive,
          id: `modpack.${options.operationId}`,
          destinationRoot: roots.stagingRoot,
          beforeWrite: async () => {
            await options.authorize();
          },
          beforePublish: async (manifest) => {
            validateManifest(manifest);
          },
        });
        validateManifest(receipt.manifest);
        // Reuse the stage receipt inventory to guard the original paths after a
        // potentially long transfer, immediately before any original is moved.
        const staged = await inspect([
          ...expected.keys(),
          ...plan.expected.map((entry) => entry.path),
        ]);
        if (!originalUnchanged(plan, staged)) throw new DomainError('conflict');
        const stageFiles = plan.write.map((file) => {
          const entry = staged.get(`${roots.stagingRoot}/${file.path}`);
          if (entry?.kind !== 'file' || entry.size !== file.size || !entry.modifiedAt)
            throw new DomainError('operation_uncertain');
          return { ...file, modifiedAt: entry.modifiedAt };
        });
        journal = await save({ ...journal, state: 'staged', stageFiles });
      } else journal = await save({ ...journal, state: 'staged' });
      if (retire.length) {
        await options.authorize();
        journal = await save({ ...journal, state: 'retiring', rollbackCreated: true });
        await options.adapter.createDirectory(options.identifier, '', roots.rollbackRoot);
        const root = await inspect([roots.rollbackRoot]);
        if (root.get(roots.rollbackRoot)?.kind !== 'directory')
          throw new DomainError('operation_uncertain');
        for (const moves of chunks(retire, 1000)) {
          await options.authorize();
          journal = await save({
            ...journal,
            batches: [...journal.batches, { phase: 'retire', moves }],
          });
          await options.adapter.renameFiles(options.identifier, '', moves);
        }
        const retired = await inspect([
          ...retire.map((move) => move.from),
          ...retiredEntries.map((entry) => entry.path),
        ]);
        if (
          retire.some((move) => retired.has(move.from)) ||
          retiredEntries.some((entry) => !same(retired.get(entry.path), entry))
        )
          throw new DomainError('operation_uncertain');
      }
      journal = await save({ ...journal, state: 'publishing' });
      for (const moves of chunks(publish, 1000)) {
        await options.authorize();
        journal = await save({
          ...journal,
          batches: [...journal.batches, { phase: 'publish', moves }],
        });
        await options.adapter.renameFiles(options.identifier, '', moves);
      }
      // The caller invokes verify once after publication. A 204 is not a receipt:
      // Wings can return it when one of the requested moves did not happen.
    },
    verify,
    async recover(
      prepared: PreparedMinecraftModpack,
      plan: MinecraftModpackPlan,
    ): Promise<ModpackPublicationRecovery> {
      try {
        const journal = await load(validate(prepared, plan));
        if (!journal) return { state: 'unknown' };
        const entries = await inspect([
          ...observationPaths(journal),
          ...(!journal.batches.length ? plan.expected.map((entry) => entry.path) : []),
        ]);
        if (['publishing', 'verified'].includes(journal.state)) {
          const files = finalFiles(journal, entries);
          if (files) return { state: 'applied', files };
        }
        if (!journal.batches.length)
          return { state: originalUnchanged(plan, entries) ? 'unchanged' : 'unknown' };
        return { state: 'partial' };
      } catch {
        return { state: 'unknown' };
      }
    },
    /** Invoke only after the durable modpack receipt is applied. Retired files stay
     * available throughout uncertain publication and restart reconciliation. */
    async cleanup(
      prepared: PreparedMinecraftModpack,
      plan: MinecraftModpackPlan,
      confirmation: { applied: true },
    ) {
      if (confirmation.applied !== true) throw new DomainError('validation_failed');
      let journal = await load(validate(prepared, plan));
      if (!journal || !['verified', 'cleaning', 'cleaned'].includes(journal.state))
        throw new DomainError('operation_uncertain');
      if (journal.state === 'cleaned') return;
      const owned = [
        ...(journal.stageFiles.length ? [roots.stagingRoot] : []),
        ...(journal.rollbackCreated ? [roots.rollbackRoot] : []),
      ];
      if (owned.length) {
        const entries = await inspect(owned);
        if (owned.some((path) => entries.has(path) && entries.get(path)?.kind !== 'directory'))
          throw new DomainError('operation_uncertain');
        await options.authorize();
        journal = await save({ ...journal, state: 'cleaning' });
        await options.adapter.deleteFiles(options.identifier, '', owned);
        const after = await inspect(owned);
        if (owned.some((path) => after.has(path))) throw new DomainError('operation_uncertain');
      }
      await save({ ...journal, state: 'cleaned' });
    },
  };
}
