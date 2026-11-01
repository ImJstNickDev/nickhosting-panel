import { describe, expect, it, vi } from 'vitest';
import type { JarArchiveReader } from './jar-descriptors.js';
import { readPluginArchive } from './plugin-metadata.js';

function fixture(files: Record<string, string | Uint8Array>, pageSize = 200) {
  const bytes = Object.fromEntries(
    Object.entries(files).map(([path, value]) => [
      path,
      typeof value === 'string' ? new TextEncoder().encode(value) : value,
    ]),
  );
  const list = vi.fn<JarArchiveReader['list']>(async (directory, signal, query) => {
    signal.throwIfAborted();
    const prefix = directory ? `${directory}/` : '';
    const entries = Object.entries(bytes)
      .filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(([path, value]) => ({
        name: path.slice(prefix.length),
        path,
        directory: false,
        size: value.byteLength,
      }))
      .filter((entry) => !query || entry.name.includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { entries: entries.slice(0, pageSize), total: entries.length };
  });
  const read = vi.fn<JarArchiveReader['read']>(async (path, maxBytes, signal) => {
    signal.throwIfAborted();
    const data = bytes[path];
    if (!data || data.byteLength > maxBytes) throw new Error(`Unexpected read ${path}`);
    return data;
  });
  return { archive: { list, read }, list, read };
}
const signal = () => new AbortController().signal;
const minimal = 'name: Example\nversion: 1.0\nmain: example.Plugin\n';

describe('Minecraft plugin JAR metadata', () => {
  it('reads Bukkit fields, declared commands, permissions and dependencies without reading code or guessed icons', async () => {
    const files = fixture({
      'plugin.yml': `${minimal}
description: |
  First line.
  Second line.
author: Author One
authors: [Author Two, Author One]
contributors: [Translator]
website: https://example.invalid/plugin
api-version: 1.20
load: STARTUP
prefix: Example
folia-supported: true
provides: [OldExample]
libraries: [org.example:library:1.2.3]
depend: [Vault]
softdepend: [PlaceholderAPI]
loadbefore: [OtherPlugin]
default-permission: false
commands:
  example:
    description: Example command
    usage: /<command> [name]
    aliases: ex
    permission: example.use
    permission-message: Not permitted
permissions:
  example.use:
    description: Use example
    default: op
    children:
      example.read: true
      example.write: false
  example.admin:
    children: [example.use]
icon: icon.png
`,
      'icon.png': 'not a real icon',
      'example/Plugin.class': 'do not execute',
    });
    const result = await readPluginArchive(files.archive, signal());
    expect(result.issues).toEqual([]);
    expect(result.plugins).toEqual([
      expect.objectContaining({
        id: 'Example',
        name: 'Example',
        platform: 'bukkit',
        source: 'plugin.yml',
        version: '1.0',
        apiVersion: '1.20',
        main: 'example.Plugin',
        authors: ['Author One', 'Author Two'],
        contributors: ['Translator'],
        description: 'First line.\nSecond line.',
        load: 'STARTUP',
        prefix: 'Example',
        foliaSupported: true,
        provides: ['OldExample'],
        libraries: ['org.example:library:1.2.3'],
        links: [{ label: 'homepage', url: 'https://example.invalid/plugin' }],
        dependencies: [
          { id: 'Vault', kind: 'required' },
          { id: 'PlaceholderAPI', kind: 'optional' },
          { id: 'OtherPlugin', kind: 'loadbefore' },
        ],
        commands: [
          {
            name: 'example',
            description: 'Example command',
            usage: '/<command> [name]',
            aliases: ['ex'],
            permission: 'example.use',
            permissionMessage: 'Not permitted',
          },
        ],
        permissions: [
          {
            name: 'example.use',
            description: 'Use example',
            default: 'op',
            children: [
              { name: 'example.read', value: true },
              { name: 'example.write', value: false },
            ],
          },
          {
            name: 'example.admin',
            description: undefined,
            default: 'false',
            children: [{ name: 'example.use', value: true }],
          },
        ],
      }),
    ]);
    expect(result.plugins[0]).not.toHaveProperty('iconPath');
    expect(files.list).toHaveBeenCalledTimes(1);
    expect(files.read.mock.calls.map(([path]) => path)).toEqual(['plugin.yml']);
  });

  it('keeps Paper and Bukkit descriptors distinct, with Paper precedence and phase-specific dependencies', async () => {
    const files = fixture({
      'plugin.yml': minimal,
      'paper-plugin.yml': `${minimal}
api-version: '1.21.11'
authors: [Paper Author]
bootstrapper: example.Bootstrap
loader: example.Loader
folia-supported: false
dependencies:
  bootstrap:
    RegistryPlugin: {}
  server:
    ProtocolLib:
      required: false
      load: BEFORE
      join-classpath: false
    LaterPlugin:
      load: AFTER
commands:
  ignored: {description: Not registered by Paper}
libraries: [not.used:by.paper:1]
defaultPerm: true
permissions:
  example.read: {}
`,
    });
    const result = await readPluginArchive(files.archive, signal());
    expect(result.issues).toEqual([]);
    expect(result.sources).toEqual(['paper-plugin.yml', 'plugin.yml']);
    expect(result.plugins.map((entry) => entry.platform)).toEqual(['paper', 'bukkit']);
    expect(result.plugins[0]).toMatchObject({
      apiVersion: '1.21.11',
      bootstrapper: 'example.Bootstrap',
      loader: 'example.Loader',
      foliaSupported: false,
      authors: ['Paper Author'],
      commands: [],
      libraries: [],
      dependencies: [
        {
          id: 'RegistryPlugin',
          kind: 'required',
          stage: 'bootstrap',
          load: 'OMIT',
          joinClasspath: true,
        },
        {
          id: 'ProtocolLib',
          kind: 'optional',
          stage: 'server',
          load: 'BEFORE',
          joinClasspath: false,
        },
        {
          id: 'LaterPlugin',
          kind: 'required',
          stage: 'server',
          load: 'AFTER',
          joinClasspath: true,
        },
      ],
      permissions: [{ name: 'example.read', default: 'true', children: [] }],
    });
    expect(files.list).toHaveBeenCalledTimes(1);
  });

  it('reads Bungee-specific dependency names without inventing Bukkit commands or permissions', async () => {
    const files = fixture({
      'bungee.yml': `${minimal}
author: Proxy Author
depends: [RedisBungee]
softDepends: [LuckPerms]
softdepend: [NotABungeeField]
commands: {ignored: {}}
permissions: {ignored: {}}
libraries: [org.example:proxy:2]
`,
    });
    const result = await readPluginArchive(files.archive, signal());
    expect(result.issues).toEqual([]);
    expect(result.plugins[0]).toMatchObject({
      platform: 'bungeecord',
      authors: ['Proxy Author'],
      dependencies: [
        { id: 'RedisBungee', kind: 'required' },
        { id: 'LuckPerms', kind: 'optional' },
      ],
      libraries: ['org.example:proxy:2'],
      commands: [],
      permissions: [],
    });
  });

  it('supports Paper singular author alone and appended to the authors list', async () => {
    for (const [fields, authors] of [
      ['author: Solo Author', ['Solo Author']],
      [
        'authors: [First Author, Second Author]\nauthor: Third Author',
        ['First Author', 'Second Author', 'Third Author'],
      ],
    ] as const) {
      const result = await readPluginArchive(
        fixture({ 'paper-plugin.yml': `${minimal}\napi-version: '1.21'\n${fields}` }).archive,
        signal(),
      );
      expect(result.issues).toEqual([]);
      expect(result.plugins[0]?.authors).toEqual(authors);
    }
  });

  it('reads generated Velocity JSON, including optional dependencies and name fallback', async () => {
    const files = fixture({
      'velocity-plugin.json': JSON.stringify({
        id: 'proxy-example',
        main: 'example.Proxy',
        version: '2.0',
        authors: ['Author'],
        url: 'https://example.invalid',
        dependencies: [
          { id: 'luckperms', optional: false },
          { id: 'redis', optional: true },
          { id: 'required' },
        ],
      }),
    });
    const result = await readPluginArchive(files.archive, signal());
    expect(result.issues).toEqual([]);
    expect(result.plugins[0]).toMatchObject({
      id: 'proxy-example',
      name: 'proxy-example',
      platform: 'velocity',
      authors: ['Author'],
      links: [{ label: 'homepage', url: 'https://example.invalid/' }],
      dependencies: [
        { id: 'luckperms', kind: 'required' },
        { id: 'redis', kind: 'optional' },
        { id: 'required', kind: 'required' },
      ],
    });
  });

  it('preserves quoted and plain version text including trailing zeroes', async () => {
    for (const version of ['1.20', '0010', '2026-01-01', '"1.20"']) {
      const files = fixture({
        'plugin.yml': `name: Example\nmain: example.Main\nversion: ${version}`,
      });
      const result = await readPluginArchive(files.archive, signal());
      expect(result.plugins[0]?.version).toBe(version.replaceAll('"', ''));
    }
  });

  it('does not invent a version or API version from null or boolean YAML scalars', async () => {
    for (const value of ['null', '~', 'false', 'true']) {
      const result = await readPluginArchive(
        fixture({
          'plugin.yml': `name: Example\nmain: example.Plugin\nversion: ${value}\napi-version: ${value}`,
        }).archive,
        signal(),
      );
      expect(result.plugins[0]?.version).toBeUndefined();
      expect(result.plugins[0]?.apiVersion).toBeUndefined();
      expect(result.issues).toEqual([{ source: 'plugin.yml', code: 'invalid_metadata' }]);
    }
  });

  it('bounds displayed dependency and permission names', async () => {
    const name = 'x'.repeat(512);
    const result = await readPluginArchive(
      fixture({
        'plugin.yml': `${minimal}
depend: [${name}]
permissions:
  ${name}:
    children:
      ${name}: true
`,
      }).archive,
      signal(),
    );
    expect(result.plugins[0]?.dependencies[0]?.id).toHaveLength(256);
    expect(result.plugins[0]?.permissions[0]?.name).toHaveLength(256);
    expect(result.plugins[0]?.permissions[0]?.children[0]?.name).toHaveLength(256);
    expect(result.issues).toContainEqual({ source: 'plugin.yml', code: 'too_large' });
  });

  it('supports bounded YAML anchors and merge keys', async () => {
    const files = fixture({
      'plugin.yml': `${minimal}
template: &permission
  description: Read the data
  default: true
permissions:
  example.read:
    <<: *permission
  example.other: *permission
`,
    });
    const result = await readPluginArchive(files.archive, signal());
    expect(result.issues).toEqual([]);
    expect(result.plugins[0]?.permissions).toEqual([
      { name: 'example.read', description: 'Read the data', default: 'true', children: [] },
      { name: 'example.other', description: 'Read the data', default: 'true', children: [] },
    ]);
  });

  it('flattens nested permission declarations while preserving explicit false children', async () => {
    const files = fixture({
      'plugin.yml': `${minimal}
permissions:
  example.admin:
    default: not op
    children:
      example.edit:
        description: Editing
        children: [example.read]
      example.delete: false
`,
    });
    const result = await readPluginArchive(files.archive, signal());
    expect(result.issues).toEqual([]);
    expect(result.plugins[0]?.permissions).toMatchObject([
      {
        name: 'example.admin',
        default: 'notop',
        children: [
          { name: 'example.edit', value: true },
          { name: 'example.delete', value: false },
        ],
      },
      {
        name: 'example.edit',
        default: 'notop',
        description: 'Editing',
        children: [{ name: 'example.read', value: true }],
      },
    ]);
  });

  it('rejects duplicate keys and unsafe YAML tags without hiding another valid platform', async () => {
    for (const invalid of [
      `${minimal}\nname: Replaced`,
      '!!js/function function(){return 1}',
      `${minimal}\nextra: !custom data`,
    ]) {
      const files = fixture({ 'plugin.yml': invalid, 'bungee.yml': minimal });
      const result = await readPluginArchive(files.archive, signal());
      expect(result.plugins.map((entry) => entry.platform)).toEqual(['bungeecord']);
      expect(result.issues).toContainEqual({ source: 'plugin.yml', code: 'invalid_metadata' });
    }
  });

  it('bounds alias expansion and recursion', async () => {
    const files = fixture({
      'plugin.yml': `${minimal}
a: &a [one, two, three, four, five, six, seven, eight]
b: &b [*a, *a, *a, *a, *a, *a, *a, *a]
c: [*b, *b, *b, *b, *b, *b, *b, *b]
`,
    });
    const result = await readPluginArchive(files.archive, signal());
    expect(result.plugins).toEqual([]);
    expect(result.issues).toEqual([{ source: 'plugin.yml', code: 'invalid_metadata' }]);
    const cyclic = fixture({
      'plugin.yml': `${minimal}\npermissions:\n  loop: &loop\n    children:\n      child: *loop`,
    });
    const cycle = await readPluginArchive(cyclic.archive, signal());
    expect(cycle.issues).toContainEqual({ source: 'plugin.yml', code: 'invalid_metadata' });
  });

  it('bounds individual descriptors before reading them', async () => {
    const files = fixture({ 'plugin.yml': 'x'.repeat(256 * 1024 + 1), 'bungee.yml': minimal });
    const result = await readPluginArchive(files.archive, signal());
    expect(result.issues).toContainEqual({ source: 'plugin.yml', code: 'too_large' });
    expect(files.read.mock.calls.map(([path]) => path)).toEqual(['bungee.yml']);
    expect(result.plugins).toHaveLength(1);
  });

  it('finds exact descriptors outside the first cached root page without recursive scans', async () => {
    const files = fixture({ 'aaa.txt': '', 'bbb.txt': '', 'plugin.yml': minimal }, 2);
    const result = await readPluginArchive(files.archive, signal());
    expect(result.plugins[0]?.name).toBe('Example');
    expect(files.list.mock.calls.every(([directory]) => directory === '')).toBe(true);
    expect(files.list).toHaveBeenCalledWith('', expect.any(AbortSignal), 'plugin.yml');
  });

  it('reports no metadata for ordinary JARs without scanning assets or class files', async () => {
    const files = fixture({ 'readme.txt': 'ordinary library', 'META-INF/plugin.yml': minimal });
    const result = await readPluginArchive(files.archive, signal());
    expect(result).toEqual({ plugins: [], sources: [], issues: [] });
    expect(files.read).not.toHaveBeenCalled();
    expect(files.list).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed identities, UTF-8 and data roots independently', async () => {
    for (const raw of ['[]', 'name: Name', new Uint8Array([0xc0, 0xaf])]) {
      const result = await readPluginArchive(fixture({ 'plugin.yml': raw }).archive, signal());
      expect(result.plugins).toHaveLength(0);
      expect(result.issues).toContainEqual({ source: 'plugin.yml', code: 'invalid_metadata' });
    }
    const result = await readPluginArchive(
      fixture({ 'velocity-plugin.json': '{"id":"INVALID!","main":"example.Main"}' }).archive,
      signal(),
    );
    expect(result.plugins).toHaveLength(0);
    expect(result.issues).toContainEqual({
      source: 'velocity-plugin.json',
      code: 'invalid_metadata',
    });
  });

  it('keeps only HTTP(S) links without embedded credentials', async () => {
    for (const website of [
      'javascript:alert(1)',
      'file:///private',
      'https://user:password@example.invalid/',
    ]) {
      const result = await readPluginArchive(
        fixture({ 'plugin.yml': `${minimal}\nwebsite: ${website}` }).archive,
        signal(),
      );
      expect(result.plugins[0]?.links).toEqual([]);
    }
  });

  it('limits displayed collections and flags truncation instead of fabricating missing entries', async () => {
    const dependencies = Array.from({ length: 300 }, (_, i) => `Plugin${i}`).join(', ');
    const result = await readPluginArchive(
      fixture({ 'plugin.yml': `${minimal}\ndepend: [${dependencies}]` }).archive,
      signal(),
    );
    expect(result.plugins[0]?.dependencies).toHaveLength(256);
    expect(result.issues).toContainEqual({ source: 'plugin.yml', code: 'too_large' });
  });

  it('propagates cancellation rather than showing invalid metadata', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readPluginArchive(fixture({ 'plugin.yml': minimal }).archive, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
