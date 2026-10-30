import { describe, expect, it, vi } from 'vitest';
import { type ModArchiveReader, modArchiveResourcePath, readModArchive } from './mod-metadata.js';

const json = (value: unknown) => JSON.stringify(value);
function fixture(files: Record<string, string | Uint8Array>, pageSize = 200) {
  const bytes = Object.fromEntries(
    Object.entries(files).map(([path, value]) => [
      path,
      typeof value === 'string' ? new TextEncoder().encode(value) : value,
    ]),
  );
  const list = vi.fn<ModArchiveReader['list']>(async (directory, signal, query) => {
    signal.throwIfAborted();
    const prefix = directory ? `${directory}/` : '';
    const entries = new Map<
      string,
      { name: string; path: string; directory: boolean; size: number }
    >();
    for (const [path, value] of Object.entries(bytes)) {
      if (!path.startsWith(prefix)) continue;
      const relative = path.slice(prefix.length);
      const name = relative.split('/')[0];
      if (!name || (query && !name.includes(query))) continue;
      entries.set(name, {
        name,
        path: `${prefix}${name}`,
        directory: relative.includes('/'),
        size: relative.includes('/') ? 0 : value.byteLength,
      });
    }
    const found = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    return { entries: found.slice(0, pageSize), total: found.length };
  });
  const read = vi.fn<ModArchiveReader['read']>(async (path, maxBytes, signal) => {
    signal.throwIfAborted();
    const value = bytes[path];
    if (!value) throw new Error(`Unexpected read ${path}`);
    if (value.byteLength > maxBytes) throw new Error(`Unbounded read ${path}`);
    return value;
  });
  return { archive: { list, read }, list, read };
}
const signal = () => new AbortController().signal;

describe('Minecraft mod archive descriptors', () => {
  it('reads Fabric metadata without loading code, nested JARs or icons', async () => {
    const files = fixture({
      'fabric.mod.json': json({
        schemaVersion: 1,
        id: 'lithium',
        name: 'Lithium',
        version: '0.16.1',
        description: 'Optimizations for Minecraft.',
        authors: [
          'jellysquid3',
          { name: '2No2Name', contact: { email: 'example@example.invalid' } },
        ],
        contributors: ['Other contributor'],
        license: ['LGPL-3.0-only'],
        environment: '*',
        contact: {
          homepage: 'https://modrinth.com/mod/lithium',
          sources: 'https://github.com/CaffeineMC/lithium',
          email: 'example@example.invalid',
        },
        icon: { '32': 'assets/small.png', '128': 'assets/icon.png', '512': 'assets/large.png' },
        depends: { fabricloader: '>=0.16.0', minecraft: ['1.21.1', '1.21.2'] },
        recommends: { recommended: '*' },
        suggests: { optional: '*' },
        breaks: { broken: '<2' },
        conflicts: { discouraged: '*' },
        jars: [{ file: 'embedded.jar' }],
        entrypoints: { main: ['example.DoNotExecute'] },
      }),
      'embedded.jar': 'not read',
      'assets/icon.png': 'not read',
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.issues).toEqual([]);
    expect(result.mods).toEqual([
      expect.objectContaining({
        id: 'lithium',
        name: 'Lithium',
        version: '0.16.1',
        loader: 'fabric',
        source: 'fabric.mod.json',
        authors: ['jellysquid3', '2No2Name'],
        licenses: ['LGPL-3.0-only'],
        environment: 'both',
        iconPath: 'assets/icon.png',
        links: [
          { label: 'homepage', url: 'https://modrinth.com/mod/lithium' },
          { label: 'sources', url: 'https://github.com/CaffeineMC/lithium' },
        ],
        dependencies: [
          { id: 'fabricloader', version: '>=0.16.0', kind: 'required' },
          { id: 'minecraft', version: '1.21.1 || 1.21.2', kind: 'required' },
          { id: 'recommended', version: '*', kind: 'recommended' },
          { id: 'optional', version: '*', kind: 'suggested' },
          { id: 'broken', version: '<2', kind: 'incompatible' },
          { id: 'discouraged', version: '*', kind: 'discouraged' },
        ],
      }),
    ]);
    expect(files.read.mock.calls.map(([path]) => path)).toEqual(['fabric.mod.json']);
  });

  it('reads Fabric schema 0 without inventing a separate Babric loader identity', async () => {
    const files = fixture({
      'fabric.mod.json': json({
        id: 'example',
        version: '1.0.0',
        side: 'client',
        authors: [{ name: 'Author' }],
        links: 'https://example.invalid/',
        requires: { fabricloader: '>=0.14', minecraft: '1.0.0-beta.7.3' },
        conflicts: { other: '*' },
      }),
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods[0]).toMatchObject({
      loader: 'fabric',
      environment: 'client',
      iconPath: 'assets/example/icon.png',
      dependencies: [
        { id: 'fabricloader', kind: 'required' },
        { id: 'minecraft', kind: 'required' },
        { id: 'other', kind: 'incompatible' },
      ],
    });
  });

  it('preserves Quilt any-of/all-of and conditional dependencies', async () => {
    const files = fixture({
      'quilt.mod.json': json({
        schema_version: 1,
        quilt_loader: {
          id: 'quilt_example',
          group: 'example',
          version: '2.3.4',
          metadata: {
            name: 'Quilt example',
            description: 'A Quilt mod.',
            contributors: {
              'One author': 'Owner',
              'Another author': ['Maintainer', 'Contributor'],
            },
            license: [{ id: 'MIT', name: 'MIT License' }, 'Apache-2.0'],
            icon: 'assets/logo.png',
            contact: { issues: 'https://example.invalid/issues' },
          },
          depends: [
            'quilt_loader',
            [
              { id: 'one', versions: '>=1' },
              { id: 'two', versions: ['>=2', '<3'] },
            ],
            {
              id: 'conditional',
              versions: '*',
              optional: true,
              unless: { id: 'replacement', versions: '>=1' },
            },
          ],
          breaks: [[{ id: 'bad_one' }, { id: 'bad_two' }]],
        },
        minecraft: { environment: 'dedicated_server' },
      }),
    });
    const result = await readModArchive(files.archive, signal());
    const mod = result.mods[0];
    expect(mod).toMatchObject({
      id: 'quilt_example',
      loader: 'quilt',
      environment: 'server',
      authors: ['One author', 'Another author'],
      licenses: ['MIT', 'Apache-2.0'],
    });
    expect(mod?.dependencies).toEqual([
      { id: 'quilt_loader', version: '*', kind: 'required' },
      {
        id: '',
        version: '',
        kind: 'required',
        combination: 'any',
        alternatives: [
          { id: 'one', version: '>=1', kind: 'required' },
          { id: 'two', version: '>=2 || <3', kind: 'required' },
        ],
      },
      {
        id: 'conditional',
        version: '*',
        kind: 'optional',
        unless: { id: 'replacement', version: '>=1', kind: 'required' },
      },
      {
        id: '',
        version: '',
        kind: 'incompatible',
        combination: 'all',
        alternatives: [
          { id: 'bad_one', version: '*', kind: 'incompatible' },
          { id: 'bad_two', version: '*', kind: 'incompatible' },
        ],
      },
    ]);
  });

  it('reads multiple Forge mods and only substitutes documented version properties', async () => {
    const files = fixture({
      'META-INF/mods.toml': `modLoader="javafml"
loaderVersion="[47,)"
license="MIT"
issueTrackerURL="https://example.invalid/issues"
[properties]
modVersion="2.4.0"
[[mods]]
modId="example"
version="\${file.jarVersion}"
displayName="Example"
description="Example mod"
authors="Author One, Author Two"
displayURL="https://example.invalid/"
logoFile="logo.png"
displayTest="IGNORE_ALL_VERSION"
[[dependencies.example]]
modId="forge"
mandatory=true
versionRange="[47,)"
side="BOTH"
[[mods]]
modId="second"
version="\${file.modVersion}"
[[dependencies.second]]
modId="first"
mandatory=false
versionRange="[1,2)"
side="SERVER"
`,
      'META-INF/MANIFEST.MF':
        'Manifest-Version: 1.0\r\nImplementation-Version: 1.2.\r\n 3\r\n\r\nName: unrelated\r\nImplementation-Version: wrong\r\n',
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.issues).toEqual([]);
    expect(result.mods).toMatchObject([
      {
        id: 'example',
        loader: 'forge',
        version: '1.2.3',
        environment: undefined,
        authors: ['Author One, Author Two'],
        licenses: ['MIT'],
        dependencies: [{ id: 'forge', kind: 'required', environment: 'both' }],
      },
      {
        id: 'second',
        loader: 'forge-neoforge',
        version: '2.4.0',
        environment: undefined,
        dependencies: [{ id: 'first', kind: 'optional', environment: 'server' }],
      },
    ]);
    expect(files.read.mock.calls.map(([path]) => path)).toEqual([
      'META-INF/mods.toml',
      'META-INF/MANIFEST.MF',
    ]);
  });

  it('reads modern and earlier NeoForge metadata without guessing mod environment from dependencies', async () => {
    const files = fixture({
      'META-INF/neoforge.mods.toml': `license="Apache-2.0"
clientSideOnly=true
[[mods]]
modId="clientmod"
version="3"
[[dependencies.clientmod]]
modId="conflict"
type="incompatible"
versionRange="[1,2)"
side="BOTH"
[[dependencies.clientmod]]
modId="softconflict"
type="discouraged"
`,
      'META-INF/mods.toml': `[[mods]]
modId="olderneo"
version="1"
[[dependencies.olderneo]]
modId="neoforge"
mandatory=true
side="SERVER"
`,
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'olderneo', loader: 'neoforge', environment: undefined }),
        expect.objectContaining({
          id: 'clientmod',
          loader: 'neoforge',
          environment: 'client',
          dependencies: [
            { id: 'conflict', version: '[1,2)', kind: 'incompatible', environment: 'both' },
            { id: 'softconflict', version: '*', kind: 'discouraged', environment: undefined },
          ],
        }),
      ]),
    );
    expect(files.list.mock.calls.some(([, , query]) => query === 'MANIFEST.MF')).toBe(false);
  });

  it.each([(mods: unknown[]) => mods, (mods: unknown[]) => ({ modListVersion: 2, modList: mods })])(
    'reads legacy mcmod.info collection shapes and only authoritative descriptor dependencies',
    async (wrap) => {
      const files = fixture({
        'mcmod.info': json(
          wrap([
            {
              modid: 'legacy',
              name: 'Legacy',
              version: '1.7.10',
              authorList: ['Author'],
              logoFile: 'logo.png',
              url: 'https://example.invalid',
              useDependencyInformation: true,
              requiredMods: ['Forge@[10,)'],
              dependencies: ['Helper'],
            },
            {
              modid: 'ignored_dependencies',
              version: '2',
              requiredMods: ['NotAuthoritative'],
              logoFile: '',
            },
          ]),
        ),
      });
      const result = await readModArchive(files.archive, signal());
      expect(result.mods).toMatchObject([
        {
          id: 'legacy',
          loader: 'forge',
          authors: ['Author'],
          dependencies: [
            { id: 'Forge', version: '[10,)', kind: 'required' },
            { id: 'Helper', kind: 'optional' },
          ],
        },
        { id: 'ignored_dependencies', dependencies: [] },
      ]);
      expect(result.issues).toEqual([]);
    },
  );

  it('does not merge multiple loader descriptors or fabricate a mod id from a filename', async () => {
    const files = fixture({
      'fabric.mod.json': json({ schemaVersion: 1, id: 'shared', version: '1' }),
      'META-INF/mods.toml': '[[mods]]\nmodId="shared"\nversion="2"\n',
      'mcmod.info': json([{ name: 'No identifier', version: '3' }]),
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods.map(({ id, loader, version }) => ({ id, loader, version }))).toEqual([
      { id: 'shared', loader: 'fabric', version: '1' },
      { id: 'shared', loader: 'forge-neoforge', version: '2' },
    ]);
    expect(result.issues).toEqual([{ source: 'mcmod.info', code: 'invalid_metadata' }]);
  });

  it('preserves nested Quilt version constraints and flags unsupported structures', async () => {
    const files = fixture({
      'quilt.mod.json': json({
        schema_version: 1,
        quilt_loader: {
          id: 'example',
          version: '1',
          depends: [
            { id: 'range', versions: { any: [{ all: ['>=1', '<2'] }, '>=3'] } },
            { id: 'unknown', versions: { future: ['>=4'] } },
          ],
        },
      }),
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods[0]?.dependencies).toEqual([
      { id: 'range', version: '(>=1 && <2) || >=3', kind: 'required' },
      { id: 'unknown', version: '?', kind: 'required' },
    ]);
    expect(result.issues).toEqual([{ source: 'quilt.mod.json', code: 'invalid_metadata' }]);
  });

  it('preserves descriptor order when parallel reads finish out of order', async () => {
    const files = fixture({
      'fabric.mod.json': json({ schemaVersion: 1, id: 'fabric', version: '1' }),
      'META-INF/mods.toml': '[[mods]]\nmodId="forge"\nversion="1"',
    });
    const originalRead = files.read.getMockImplementation();
    files.read.mockImplementation(async (...args) => {
      if (args[0] === 'fabric.mod.json') await new Promise((resolve) => setTimeout(resolve, 10));
      if (!originalRead) throw new Error('Missing test reader');
      return originalRead(...args);
    });
    expect((await readModArchive(files.archive, signal())).mods.map((mod) => mod.id)).toEqual([
      'fabric',
      'forge',
    ]);
  });

  it.each([
    ['fabric.mod.json', '{}'],
    ['quilt.mod.json', '{"schema_version":1,"quilt_loader":{}}'],
    ['mcmod.info', '{}'],
    ['META-INF/mods.toml', 'license="MIT"'],
  ])('distinguishes malformed %s from an archive without descriptors', async (path, value) => {
    const files = fixture({ [path]: value });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods).toEqual([]);
    expect(result.issues).toContainEqual({ source: path, code: 'invalid_metadata' });
  });

  it('reports absent metadata as a normal unidentified archive', async () => {
    const files = fixture({ 'com/example/Unrelated.class': 'bytes', 'pack.mcmeta': '{}' });
    expect(await readModArchive(files.archive, signal())).toEqual({
      mods: [],
      sources: [],
      issues: [],
    });
    expect(files.read).not.toHaveBeenCalled();
  });

  it('retains valid descriptors when a different descriptor is malformed or unsupported', async () => {
    const files = fixture({
      'fabric.mod.json': '{broken',
      'quilt.mod.json': json({ schema_version: 2 }),
      'quilt.mod.json5': '{ // development only\n}',
      'META-INF/neoforge.mods.toml': '[[mods]]\nmodId="valid"\nversion="1"',
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods.map((mod) => mod.id)).toEqual(['valid']);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { source: 'fabric.mod.json', code: 'invalid_metadata' },
        { source: 'quilt.mod.json', code: 'unsupported_schema' },
        { source: 'quilt.mod.json5', code: 'unsupported_schema' },
      ]),
    );
    expect(files.read.mock.calls.some(([path]) => path.endsWith('.json5'))).toBe(false);
  });

  it('leaves unresolved Forge version placeholders visible and reports their uncertainty', async () => {
    const files = fixture({
      'META-INF/mods.toml': `[[mods]]\nmodId="example"\nversion="\${file.jarVersion}-\${secret}-@(version)"`,
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods[0]?.version).toBe(`\${file.jarVersion}-\${secret}-@(version)`);
    expect(result.issues).toEqual([{ source: 'META-INF/mods.toml', code: 'unresolved_version' }]);
  });

  it('finds descriptors beyond the first root / META-INF page using bounded filtered listings', async () => {
    const files = fixture({
      ...Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [`a${index}.class`, 'not read']),
      ),
      ...Object.fromEntries(
        Array.from({ length: 201 }, (_, index) => [`META-INF/a${index}.class`, 'not read']),
      ),
      'fabric.mod.json': json({ schemaVersion: 1, id: 'fabric', version: '1' }),
      'META-INF/mods.toml': '[[mods]]\nmodId="forge"\nversion="2"',
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods.map((mod) => mod.id)).toEqual(['fabric', 'forge']);
    expect(files.list.mock.calls).toEqual(
      expect.arrayContaining([
        ['', expect.any(AbortSignal), 'fabric.mod.json'],
        ['', expect.any(AbortSignal), 'META-INF'],
        ['META-INF', expect.any(AbortSignal), 'mods.toml'],
      ]),
    );
    expect(files.read).toHaveBeenCalledTimes(2);
  });

  it('does not mistake a nested or similarly named descriptor for a root descriptor', async () => {
    const files = fixture({
      'nested/fabric.mod.json': json({ id: 'wrong' }),
      'fabric.mod.json.backup': json({ id: 'wrong' }),
      'META-INF/mods.toml.backup': '[[mods]]\nmodId="wrong"',
    });
    expect((await readModArchive(files.archive, signal())).mods).toEqual([]);
    expect(files.read).not.toHaveBeenCalled();
  });

  it('bounds descriptor and total data before reads and rejects invalid UTF-8', async () => {
    const files = fixture({
      'fabric.mod.json': ' '.repeat(256 * 1024 + 1),
      'quilt.mod.json': new Uint8Array([0xff, 0xfe, 0x00]),
      'mcmod.info': json([{ modid: 'valid', version: '1' }]),
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods.map((mod) => mod.id)).toEqual(['valid']);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { source: 'fabric.mod.json', code: 'too_large' },
        { source: 'quilt.mod.json', code: 'invalid_metadata' },
      ]),
    );
    expect(files.read.mock.calls.some(([path]) => path === 'fabric.mod.json')).toBe(false);
  });

  it('rejects oversized provider responses even if entry size understated them', async () => {
    const files = fixture({ 'fabric.mod.json': '{}' });
    files.read.mockResolvedValue(new Uint8Array(256 * 1024 + 1));
    const result = await readModArchive(files.archive, signal());
    expect(result.mods).toEqual([]);
    expect(result.issues).toEqual([{ source: 'fabric.mod.json', code: 'too_large' }]);
  });

  it('caps total descriptor data while preserving already identified mods', async () => {
    const padded = (value: string) => value.padEnd(256 * 1024, ' ');
    const files = fixture({
      'fabric.mod.json': padded(json({ schemaVersion: 1, id: 'fabric', version: '1' })),
      'quilt.mod.json': padded(
        json({ schema_version: 1, quilt_loader: { id: 'quilt', version: '1' } }),
      ),
      'mcmod.info': padded(json([{ modid: 'legacy', version: '1' }])),
      'META-INF/mods.toml': padded('[[mods]]\nmodId="forge"\nversion="1"\n'),
      'META-INF/neoforge.mods.toml': padded('[[mods]]\nmodId="neo"\nversion="1"\n'),
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods.map((mod) => mod.id)).toEqual(['fabric', 'quilt', 'legacy', 'forge']);
    expect(result.issues).toEqual([{ source: 'META-INF/neoforge.mods.toml', code: 'too_large' }]);
    expect(files.read).toHaveBeenCalledTimes(4);
  });

  it('reports truncation of a large mod collection instead of silently dropping records', async () => {
    const files = fixture({
      'META-INF/mods.toml': Array.from(
        { length: 300 },
        (_, index) => `[[mods]]\nmodId="mod_${index}"\nversion="1"\n`,
      ).join(''),
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods).toHaveLength(256);
    expect(result.issues).toEqual([{ source: 'META-INF/mods.toml', code: 'too_large' }]);
  });

  it('reports dependency truncation and unsupported Fabric constraint types', async () => {
    const files = fixture({
      'fabric.mod.json': json({
        schemaVersion: 1,
        id: 'example',
        version: '1',
        depends: {
          unknown: { future: '>=1' },
          ...Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`mod_${index}`, '*'])),
        },
      }),
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods[0]?.dependencies).toHaveLength(256);
    expect(result.mods[0]?.dependencies[0]).toEqual({
      id: 'unknown',
      version: '?',
      kind: 'required',
    });
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { source: 'fabric.mod.json', code: 'too_large' },
        { source: 'fabric.mod.json', code: 'invalid_metadata' },
      ]),
    );
  });

  it('reports a truncated filtered listing instead of silently claiming metadata is absent', async () => {
    const files = fixture({});
    files.list.mockResolvedValue({ entries: [], total: 201 });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods).toEqual([]);
    expect(result.issues).toContainEqual({ source: 'fabric.mod.json', code: 'too_large' });
    expect(files.list).toHaveBeenCalledTimes(6);
    expect(files.read).not.toHaveBeenCalled();
  });

  it('does not follow untrusted resource paths or links', async () => {
    const files = fixture({
      'fabric.mod.json': json({
        schemaVersion: 1,
        id: 'example',
        version: '1',
        icon: '../../credentials',
        contact: {
          homepage: 'javascript:alert(1)',
          sources: 'https://user:password@example.invalid',
          issues: 'https://example.invalid/issues',
        },
      }),
    });
    const result = await readModArchive(files.archive, signal());
    expect(result.mods[0]).toMatchObject({
      iconPath: undefined,
      links: [{ label: 'issues', url: 'https://example.invalid/issues' }],
    });
    expect(result.issues).toEqual([{ source: 'fabric.mod.json', code: 'unsafe_path' }]);
    for (const path of [
      '../logo.png',
      '/logo.png',
      'http://example.invalid/logo.png',
      'folder\\logo.png',
      'folder/./logo.png',
      'a\0.png',
      'logo.png?x',
      'logo.png#x',
    ])
      expect(modArchiveResourcePath(path)).toBeUndefined();
    expect(modArchiveResourcePath('assets/example/logo.png')).toBe('assets/example/logo.png');
  });

  it('propagates cancellation and transport failures instead of displaying missing metadata', async () => {
    const files = fixture({ 'fabric.mod.json': json({ schemaVersion: 1, id: 'example' }) });
    const aborted = new AbortController();
    aborted.abort();
    await expect(readModArchive(files.archive, aborted.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(files.list).not.toHaveBeenCalled();
    const error = new Error('Unauthorized');
    files.read.mockRejectedValue(error);
    await expect(readModArchive(files.archive, signal())).rejects.toBe(error);
  });
});
