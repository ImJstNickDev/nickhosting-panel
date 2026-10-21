import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { inspectJarMetadata, visitArchive } from './archive.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function jar(entries: [string, string][]) {
  const root = await mkdtemp(join(tmpdir(), 'nh-jar-metadata-'));
  roots.push(root);
  const zip = new ZipFile();
  const chunks: Buffer[] = [];
  zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
  const data = new Promise<Buffer>((resolve, reject) => {
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.on('error', reject);
  });
  for (const [name, content] of entries)
    zip.addBuffer(Buffer.from(content), name, { compress: false });
  zip.end();
  const path = join(root, 'mod.jar');
  await writeFile(path, await data);
  return path;
}
const resources: [string, string][] = [
  ['META-INF/fml_cache_annotation.json', 'first'],
  ['META-INF/fml_cache_annotation.json', 'second'],
  ['license.txt', 'lowercase'],
  ['LICENSE.txt', 'uppercase'],
];

describe('JAR metadata inspection', () => {
  it('ignores duplicate opaque resources without treating JARs as extracted directories', async () => {
    const path = await jar(resources);
    expect(await inspectJarMetadata(path)).toEqual({ environment: 'unknown' });
    // The same archive must still be rejected when its entries are extracted to disk.
    await expect(visitArchive(path, async () => {})).rejects.toMatchObject({
      details: { contentReason: 'archive_duplicate' },
    });
  });
  it('still classifies client-only Fabric mods alongside opaque duplicate resources', async () => {
    const path = await jar([
      ...resources,
      [
        'fabric.mod.json',
        JSON.stringify({ id: 'clientmod', version: '1.2', environment: 'client' }),
      ],
    ]);
    expect(await inspectJarMetadata(path)).toEqual({
      environment: 'client',
      fabric: { id: 'clientmod', version: '1.2' },
    });
  });
  it('rejects ambiguous duplicate metadata records', async () => {
    const path = await jar([
      ['fabric.mod.json', JSON.stringify({ id: 'testmod', environment: 'server' })],
      ['fabric.mod.json', JSON.stringify({ id: 'testmod', environment: 'client' })],
    ]);
    await expect(inspectJarMetadata(path)).rejects.toMatchObject({
      details: { contentReason: 'archive_duplicate' },
    });
  });
  it('scans large JAR inventories without increasing the extraction entry limit', async () => {
    const path = await jar([
      ...Array.from({ length: 20001 }, (_, index): [string, string] => [
        `assets/resource-${index}.json`,
        '{}',
      ]),
      ['fabric.mod.json', JSON.stringify({ id: 'largemod', environment: '*' })],
    ]);
    expect(await inspectJarMetadata(path)).toEqual({
      environment: 'both',
      fabric: { id: 'largemod' },
    });
    let visited = false;
    await expect(
      visitArchive(path, async () => {
        visited = true;
      }),
    ).rejects.toMatchObject({ details: { contentReason: 'archive_budget' } });
    expect(visited).toBe(false);
  });
  it('rejects a JAR over its separate entry cap before reading selected metadata', async () => {
    const path = await jar([
      ['fabric.mod.json', 'malformed JSON must never be read'],
      ['opaque/a.txt', 'a'],
      ['opaque/b.txt', 'b'],
    ]);
    await expect(inspectJarMetadata(path, { maxJarEntries: 2 })).rejects.toMatchObject({
      details: { contentReason: 'archive_budget' },
    });
  });
  it('bounds skipped entry count and the metadata actually read', async () => {
    await expect(
      inspectJarMetadata(await jar(resources), { maxJarEntries: 2 }),
    ).rejects.toMatchObject({ details: { contentReason: 'archive_budget' } });
    const path = await jar([
      ['fabric.mod.json', JSON.stringify({ id: 'testmod', version: 'x'.repeat(2000) })],
    ]);
    await expect(inspectJarMetadata(path, { maxMetadataBytes: 1024 })).rejects.toMatchObject({
      details: { contentReason: 'metadata_size' },
    });
  });
});
