import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

export const satisfactoryModReferenceSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
export const satisfactoryModSelectionSchema = z
  .array(
    z.strictObject({
      reference: satisfactoryModReferenceSchema,
      version: z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/),
    }),
  )
  .max(256)
  .superRefine((items, ctx) => {
    if (new Set(items.map((item) => item.reference)).size !== items.length)
      ctx.addIssue({ code: 'custom', message: 'duplicate_mod_reference' });
  });
export const satisfactoryModLockSchema = z.object({
  version: z.literal(1),
  mods: z.record(
    satisfactoryModReferenceSchema,
    z.object({
      version: z.string(),
      dependencies: z.record(z.string(), z.string()).nullable(),
      targets: z.record(z.string(), z.object({ hash: z.string(), link: z.url() })),
    }),
  ),
});
export type SatisfactoryModSelection = z.infer<typeof satisfactoryModSelectionSchema>;
export type SatisfactoryModLock = z.infer<typeof satisfactoryModLockSchema>;
export type SatisfactoryModFile = { path: string; size: number; sha256: string };
export const satisfactoryVersionPaths = [
  'Engine/Binaries/Linux/UnrealServer-Linux-Shipping.version',
  'Engine/Binaries/Linux/FactoryServer-Linux-Shipping.version',
] as const;

/** Resolves SML/dependencies with the upstream resolver in a private local staging tree.
 * With outputDirectory, numbered artifacts survive in the durable job stage; returned
 * metadata never contains payload buffers. Without it this only resolves/validates.
 * The caller applies preserved files through the existing upload pipeline while stopped.
 * Never gives ficsit-cli credentials, a server mount, or a remote installation URL.
 */
export async function prepareSatisfactoryMods(options: {
  executable: string;
  executableSha256: string;
  sandboxExecutable?: string;
  stagingRoot: string;
  /** Trusted durable operation directory; artifacts are moved to <index>.bin. */
  outputDirectory?: string;
  selection: SatisfactoryModSelection;
  versionPath: (typeof satisfactoryVersionPaths)[number];
  versionFile: Buffer;
  launcherFile: Buffer;
  signal?: AbortSignal;
  run?: (executable: string, args: string[], cwd: string, signal?: AbortSignal) => Promise<void>;
}): Promise<{ files: SatisfactoryModFile[]; lock: SatisfactoryModLock }> {
  const selection = satisfactoryModSelectionSchema.parse(options.selection);
  if (
    !isAbsolute(options.executable) ||
    !isAbsolute(options.stagingRoot) ||
    !/^[a-f0-9]{64}$/.test(options.executableSha256) ||
    !satisfactoryVersionPaths.includes(options.versionPath) ||
    options.versionFile.length > 65536 ||
    options.launcherFile.length > 1048576
  )
    throw new Error('satisfactory_mod_input_invalid');
  const version = JSON.parse(options.versionFile.toString('utf8')) as Record<string, unknown>;
  if (!Number.isSafeInteger(version.Changelist) || Number(version.Changelist) <= 0)
    throw new Error('satisfactory_game_version_invalid');
  const executableHash = createHash('sha256');
  for await (const chunk of createReadStream(options.executable)) executableHash.update(chunk);
  if (executableHash.digest('hex') !== options.executableSha256)
    throw new Error('satisfactory_cli_integrity_failed');
  await mkdir(options.stagingRoot, { recursive: true, mode: 0o700 });
  if (options.outputDirectory) {
    const subpath = relative(options.stagingRoot, options.outputDirectory);
    if (
      !isAbsolute(options.outputDirectory) ||
      !subpath ||
      subpath.startsWith('..') ||
      isAbsolute(subpath)
    )
      throw new Error('satisfactory_mod_output_invalid');
    await mkdir(options.outputDirectory, { recursive: true, mode: 0o700 });
    const directory = await lstat(options.outputDirectory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('satisfactory_mod_output_invalid');
  }
  const root = await mkdtemp(join(options.stagingRoot, 'satisfactory-mods-'));
  try {
    const game = join(root, 'game'),
      state = join(root, 'state');
    await mkdir(join(game, 'Engine/Binaries/Linux'), { recursive: true, mode: 0o700 });
    await mkdir(join(game, 'FactoryGame/Mods'), { recursive: true, mode: 0o700 });
    await mkdir(state, { mode: 0o700 });
    await writeFile(join(game, options.versionPath), options.versionFile, { mode: 0o600 });
    await writeFile(join(game, 'FactoryServer.sh'), options.launcherFile, { mode: 0o600 });
    await writeFile(
      join(state, 'profiles.json'),
      JSON.stringify({
        version: 0,
        selected_profile: 'NickHosting',
        profiles: {
          NickHosting: {
            name: 'NickHosting',
            required_targets: ['LinuxServer'],
            mods: Object.fromEntries(
              selection.map((item) => [item.reference, { version: item.version, enabled: true }]),
            ),
          },
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(state, 'installations.json'),
      JSON.stringify({
        version: 0,
        selected_installation: game,
        installations: [{ path: game, profile: 'NickHosting', vanilla: false }],
      }),
      { mode: 0o600 },
    );
    const args = [
      '--local-dir',
      state,
      '--cache-dir',
      join(root, 'cache'),
      '--pretty=false',
      '--quiet',
      'apply',
      game,
    ];
    const run =
      options.run ??
      (async (binary, argv, cwd, signal) => {
        const budget = new AbortController();
        let scanning: Promise<void> | undefined;
        const scan = async () => {
          let bytes = 0,
            entries = 0;
          const walk = async (directory: string, depth = 0): Promise<void> => {
            if (depth > 32) throw new Error('satisfactory_mod_output_limit');
            for (const entry of await readdir(directory, { withFileTypes: true })) {
              if (++entries > 40000 || entry.isSymbolicLink())
                throw new Error('satisfactory_mod_output_limit');
              const path = join(directory, entry.name);
              if (entry.isDirectory()) await walk(path, depth + 1);
              else {
                try {
                  bytes += (await lstat(path)).size;
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                }
                if (bytes > 1_610_612_736) throw new Error('satisfactory_mod_output_limit');
              }
            }
          };
          await walk(cwd);
        };
        const timer = setInterval(() => {
          if (scanning) return;
          scanning = scan()
            .catch((error: unknown) => budget.abort(error))
            .finally(() => {
              scanning = undefined;
            });
        }, 500);
        try {
          await promisify(execFile)(
            options.sandboxExecutable ?? '/usr/local/bin/nh-content-sandbox',
            [cwd, binary, ...argv],
            {
              cwd,
              signal: signal ? AbortSignal.any([signal, budget.signal]) : budget.signal,
              timeout: 300_000,
              maxBuffer: 1_048_576,
              env: {
                PATH: process.env.PATH,
                HOME: root,
                TMPDIR: root,
                XDG_CONFIG_HOME: state,
                XDG_DATA_HOME: state,
                XDG_CACHE_HOME: join(root, 'cache'),
              },
            },
          );
          await scan();
          budget.signal.throwIfAborted();
        } finally {
          clearInterval(timer);
          await scanning;
        }
      });
    await run(options.executable, args, root, options.signal);
    const lockPath = join(game, 'FactoryGame/Mods/nick_hosting-lock.json');
    const lockStat = await lstat(lockPath);
    if (!lockStat.isFile() || lockStat.isSymbolicLink() || lockStat.size > 1048576)
      throw new Error('satisfactory_mod_output_invalid');
    const lock = satisfactoryModLockSchema.parse(JSON.parse(await readFile(lockPath, 'utf8')));
    for (const item of selection) {
      const resolved = lock.mods[item.reference];
      if (!resolved || resolved.version !== item.version || !resolved.targets.LinuxServer)
        throw new Error('satisfactory_mod_resolution_mismatch');
    }
    const files: SatisfactoryModFile[] = [];
    let total = 0;
    const collect = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(game, relative), { withFileTypes: true })) {
        if (!/^[A-Za-z0-9_. -]+$/.test(entry.name) || entry.isSymbolicLink())
          throw new Error('satisfactory_mod_output_invalid');
        const path = `${relative}/${entry.name}`;
        if (path.length > 1024) throw new Error('satisfactory_mod_output_invalid');
        if (entry.isDirectory()) await collect(path);
        else if (entry.isFile()) {
          const source = join(game, path);
          const stat = await lstat(source);
          const size = stat.size;
          total += size;
          if (total > 536_870_912 || files.length >= 20000)
            throw new Error('satisfactory_mod_output_limit');
          const hash = createHash('sha256');
          let observed = 0;
          for await (const chunk of createReadStream(source)) {
            observed += chunk.length;
            if (observed > size) throw new Error('satisfactory_mod_output_invalid');
            hash.update(chunk);
          }
          if (observed !== size) throw new Error('satisfactory_mod_output_invalid');
          if (options.outputDirectory)
            await rename(source, join(options.outputDirectory, `${files.length}.bin`));
          files.push({ path, size, sha256: hash.digest('hex') });
        } else throw new Error('satisfactory_mod_output_invalid');
      }
    };
    await collect('FactoryGame/Mods');
    return { files, lock };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
