import { expect, it, vi } from 'vitest';
import { ModrinthProvider } from './index.js';
import { pluginCompatibility } from './plugin-metadata.js';

const target = { minecraftVersion: '1.21.1', loader: 'purpur' as const };
const selection = (projectId: string) => ({
  projectId,
  forceIncompatible: false,
  optionalProjectIds: [],
});
it('uses Modrinth plugin facets, Bukkit compatibility on Purpur, plugins paths and the existing dependency graph', async () => {
  const json = vi.fn(async (raw: string) => {
    const url = new URL(raw);
    if (url.pathname === '/v2/search') return { offset: 0, total_hits: 0, hits: [] };
    if (url.pathname === '/v2/project/abc')
      return {
        id: 'abc',
        slug: 'plugin',
        title: 'Plugin',
        description: '',
        body: '',
        project_type: 'mod',
        loaders: ['bukkit'],
        downloads: 10,
        environment: ['server_only'],
      };
    return [
      {
        id: 'v1',
        project_id: 'abc',
        name: '1.0',
        version_number: '1.0',
        game_versions: ['1.21.1'],
        loaders: ['bukkit'],
        date_published: '2026-10-10T00:00:00Z',
        version_type: 'release',
        files: [
          {
            filename: 'example.jar',
            url: 'https://cdn.modrinth.com/example.jar',
            size: 10,
            hashes: { sha1: 'a'.repeat(40) },
          },
        ],
        dependencies: [],
      },
    ];
  });
  const provider = new ModrinthProvider({ json, download: vi.fn() });
  await provider.searchPlugins({ target, query: '' });
  const params = new URL(json.mock.calls[0]?.[0] ?? '').searchParams;
  expect(JSON.parse(params.get('facets') ?? '[]')).toContainEqual(['all_project_types:plugin']);
  expect(JSON.parse(params.get('facets') ?? '[]')).toContainEqual([
    'categories:purpur',
    'categories:paper',
    'categories:spigot',
    'categories:bukkit',
  ]);
  const result = await provider.resolvePlugins([selection('abc')], target);
  expect(result.catalog.blocked).toEqual([]);
  expect(result.plan.artifacts[0]).toMatchObject({ path: 'plugins/example.jar', kind: 'plugin' });
  expect(result.catalog.items[0]?.project.websiteUrl).toBe('https://modrinth.com/plugin/plugin');
});

it.each(['purpur', 'paper', 'spigot', 'bukkit'])(
  'accepts declared %s plugins on Purpur',
  (loader) => {
    expect(
      pluginCompatibility(
        ['1.21.1'],
        [loader],
        { kind: 'server', source: 'modrinth', original: [] },
        target,
      ),
    ).toEqual([]);
  },
);
it('does not interpret Purpur compatibility as Folia, modded, client or other-version support', () => {
  const environment = { kind: 'server' as const, source: 'modrinth' as const, original: [] };
  for (const loader of ['folia', 'fabric', 'forge'])
    expect(pluginCompatibility(['1.21.1'], [loader], environment, target)).toContain('loader');
  expect(pluginCompatibility(['1.21.2'], ['paper'], environment, target)).toContain(
    'minecraft-version',
  );
  expect(
    pluginCompatibility(['1.21.1'], ['paper'], { ...environment, kind: 'client' }, target),
  ).toContain('client-only');
  expect(
    pluginCompatibility(['1.21.1'], ['purpur'], environment, { ...target, loader: 'paper' }),
  ).toContain('loader');
});
