import { createHash } from 'node:crypto';
import { lstat, mkdtemp, open, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareSatisfactoryMods, satisfactoryModSelectionSchema } from './mods.js';
import { searchSatisfactoryMods } from './mods-catalog.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'nh-satisfactory-mod-test-'));
  roots.push(root);
  const executable = join(root, 'ficsit');
  await writeFile(executable, 'fixture');
  return {
    executable,
    executableSha256: createHash('sha256').update('fixture').digest('hex'),
    stagingRoot: join(root, 'staging'),
    selection: [{ reference: 'Example', version: '1.2.3' }],
    versionPath: 'Engine/Binaries/Linux/UnrealServer-Linux-Shipping.version' as const,
    versionFile: Buffer.from(JSON.stringify({ Changelist: 400000 })),
    launcherFile: Buffer.from('#!/bin/sh\n'),
  };
}
const lock = {
  version: 1,
  mods: {
    Example: {
      version: '1.2.3',
      dependencies: { SML: '>=3.0.0' },
      targets: { LinuxServer: { hash: 'abc', link: 'https://api.ficsit.app/mod.zip' } },
    },
    SML: {
      version: '3.10.0',
      dependencies: {},
      targets: { LinuxServer: { hash: 'def', link: 'https://api.ficsit.app/sml.zip' } },
    },
  },
};
describe('Satisfactory ficsit preparation', () => {
  it('spools large files into durable output and returns metadata without payload buffers', async () => {
    const input = await fixture();
    const outputDirectory = join(input.stagingRoot, 'output');
    const result = await prepareSatisfactoryMods({
      ...input,
      outputDirectory,
      run: async (_binary, _args, cwd) => {
        await writeFile(
          join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
          JSON.stringify(lock),
        );
        const binary = await open(join(cwd, 'game/FactoryGame/Mods/large.so'), 'w');
        try {
          await binary.truncate(8 * 1024 * 1024);
        } finally {
          await binary.close();
        }
      },
    });
    const index = result.files.findIndex((file) => file.path.endsWith('large.so'));
    expect(index).toBeGreaterThanOrEqual(0);
    expect(result.files[index]).toMatchObject({ size: 8 * 1024 * 1024 });
    expect(result.files[index]).not.toHaveProperty('bytes');
    expect((await lstat(join(outputDirectory, `${index}.bin`))).size).toBe(8 * 1024 * 1024);
    for (const [position, file] of result.files.entries()) {
      const bytes = await readFile(join(outputDirectory, `${position}.bin`));
      expect(bytes.length).toBe(file.size);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    expect(await readdir(input.stagingRoot)).toEqual(['output']);
  });
  it('pins exact requested mods, requests LinuxServer and returns dependency lock and hashes', async () => {
    const input = await fixture();
    const result = await prepareSatisfactoryMods({
      ...input,
      run: async (_binary, args, cwd) => {
        expect(args.slice(-2)).toEqual(['apply', join(cwd, 'game')]);
        const profiles = JSON.parse(await readFile(join(cwd, 'state/profiles.json'), 'utf8'));
        expect(profiles.profiles.NickHosting.required_targets).toEqual(['LinuxServer']);
        expect(profiles.profiles.NickHosting.mods.Example).toEqual({
          version: '1.2.3',
          enabled: true,
        });
        await writeFile(
          join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
          JSON.stringify(lock),
        );
      },
    });
    expect(result.lock.mods.SML?.version).toBe('3.10.0');
    expect(result.files[0]?.sha256).toHaveLength(64);
    expect(await readdir(input.stagingRoot)).toEqual([]);
  });
  it('preserves disabled roots and checks resolved versions against constraints', async () => {
    const input = await fixture();
    const result = await prepareSatisfactoryMods({
      ...input,
      selection: [
        { reference: 'Example', version: '>=1.0.0 <2.0.0' },
        { reference: 'Paused', version: '9.0.0', enabled: false },
      ],
      run: async (_binary, _args, cwd) => {
        const profiles = JSON.parse(await readFile(join(cwd, 'state/profiles.json'), 'utf8'));
        expect(profiles.profiles.NickHosting.mods.Paused.enabled).toBe(false);
        await writeFile(
          join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
          JSON.stringify(lock),
        );
      },
    });
    expect(result.lock.mods.Example?.version).toBe('1.2.3');
    expect(result.lock.mods.Paused).toBeUndefined();
  });
  it('handles upstream vanilla mode without requiring a lockfile', async () => {
    const result = await prepareSatisfactoryMods({
      ...(await fixture()),
      vanilla: true,
      run: async (_binary, _args, cwd) => {
        const installs = JSON.parse(await readFile(join(cwd, 'state/installations.json'), 'utf8'));
        expect(installs.installations[0].vanilla).toBe(true);
      },
    });
    expect(result).toMatchObject({ files: [], lock: { version: 1, mods: {} } });
    expect(result.timings?.totalMs).toBeGreaterThanOrEqual(0);
  });
  it('accepts resolved shared profiles containing client-only and server-only roots', async () => {
    const result = await prepareSatisfactoryMods({
      ...(await fixture()),
      selection: [
        { reference: 'ClientOnly', version: '1.0.0' },
        { reference: 'ServerOnly', version: '1.0.0' },
      ],
      requiredTargets: ['LinuxServer', 'Windows'],
      run: async (_binary, _args, cwd) => {
        await writeFile(
          join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
          JSON.stringify({
            version: 1,
            mods: {
              ClientOnly: {
                version: '1.0.0',
                dependencies: {},
                targets: { Windows: { hash: 'a', link: 'https://api.ficsit.app/client.zip' } },
              },
              ServerOnly: {
                version: '1.0.0',
                dependencies: {},
                targets: { LinuxServer: { hash: 'b', link: 'https://api.ficsit.app/server.zip' } },
              },
            },
          }),
        );
      },
    });
    expect(Object.keys(result.lock.mods)).toEqual(['ClientOnly', 'ServerOnly']);
  });
  it('rejects unsafe prior lock URLs and roots with no relevant target', async () => {
    const run = vi.fn();
    await expect(
      prepareSatisfactoryMods({
        ...(await fixture()),
        run,
        priorLock: {
          version: 1,
          mods: {
            Example: {
              version: '1.2.3',
              dependencies: {},
              targets: { LinuxServer: { hash: 'abc', link: 'http://127.0.0.1/private' } },
            },
          },
        },
      }),
    ).rejects.toThrow('lock_url_invalid');
    expect(run).not.toHaveBeenCalled();
    await expect(
      prepareSatisfactoryMods({
        ...(await fixture()),
        requiredTargets: ['LinuxServer', 'Windows'],
        run: async (_binary, _args, cwd) => {
          await writeFile(
            join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
            JSON.stringify({
              ...lock,
              mods: {
                ...lock.mods,
                Example: {
                  ...lock.mods.Example,
                  targets: {
                    WindowsServer: { hash: 'abc', link: 'https://api.ficsit.app/mod.zip' },
                  },
                },
              },
            }),
          );
        },
      }),
    ).rejects.toThrow('resolution_mismatch');
  });
  it('rejects an untrusted CLI before executing it', async () => {
    const run = vi.fn();
    await expect(
      prepareSatisfactoryMods({ ...(await fixture()), executableSha256: '0'.repeat(64), run }),
    ).rejects.toThrow('integrity');
    expect(run).not.toHaveBeenCalled();
  });
  it('rejects a solver result that changes an exact requested version', async () => {
    const input = await fixture();
    await expect(
      prepareSatisfactoryMods({
        ...input,
        run: async (_b, _a, cwd) => {
          await writeFile(
            join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
            JSON.stringify({ ...lock, mods: {} }),
          );
        },
      }),
    ).rejects.toThrow('resolution_mismatch');
    expect(await readdir(input.stagingRoot)).toEqual([]);
  });
  it('rejects symlinks instead of uploading files outside the mod tree', async () => {
    await expect(
      prepareSatisfactoryMods({
        ...(await fixture()),
        run: async (_b, _a, cwd) => {
          await writeFile(
            join(cwd, 'game/FactoryGame/Mods/nick_hosting-lock.json'),
            JSON.stringify(lock),
          );
          await symlink('/etc/passwd', join(cwd, 'game/FactoryGame/Mods/escape'));
        },
      }),
    ).rejects.toThrow('output_invalid');
  });
  it('validates references, duplicates and versions before passing arguments to a process', () => {
    expect(
      satisfactoryModSelectionSchema.safeParse([{ reference: '--help', version: '1.0.0' }]).success,
    ).toBe(false);
    expect(
      satisfactoryModSelectionSchema.safeParse([{ reference: 'X', version: '$(curl bad)' }])
        .success,
    ).toBe(false);
    expect(
      satisfactoryModSelectionSchema.safeParse([
        { reference: 'X', version: '1.0.0' },
        { reference: 'X', version: '1.0.1' },
      ]).success,
    ).toBe(false);
  });
});
describe('SMR catalog', () => {
  it('browses without an empty search filter and rejects short searches before contacting SMR', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: { mods: { count: 0, mods: [] } },
          }),
        ),
    );
    await searchSatisfactoryMods({ query: '   ', fetch: request as typeof fetch });
    const init = (request.mock.calls as unknown as [string, RequestInit][])[0]?.[1];
    expect(JSON.parse(String(init?.body)).variables.filter).not.toHaveProperty('search');
    for (const query of ['a', 'ab'])
      await expect(
        searchSatisfactoryMods({ query, fetch: request as typeof fetch }),
      ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('passes search as GraphQL variables and normalizes public projects', async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              mods: { count: 1, mods: [{ id: 'a', name: 'Example', mod_reference: 'Example' }] },
            },
          }),
        ),
    );
    expect(
      (await searchSatisfactoryMods({ query: '"query"', fetch: request as typeof fetch })).items[0]
        ?.reference,
    ).toBe('Example');
    const init = (request.mock.calls as unknown as [string, RequestInit][])[0]?.[1];
    expect(JSON.parse(String(init?.body)).variables.filter.search).toBe('"query"');
  });
  it('fails on GraphQL errors even with partial data', async () => {
    await expect(
      searchSatisfactoryMods({
        query: '',
        fetch: (async () =>
          new Response(
            JSON.stringify({ errors: [{}], data: { mods: { count: 0, mods: [] } } }),
          )) as typeof fetch,
      }),
    ).rejects.toThrow('unavailable');
  });
});
