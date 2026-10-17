import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Only generated build output is replaced; never touches environment/persistence.
const output = resolve('build/runtime');
await rm(output, { recursive: true, force: true });
const compiled = spawnSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.runtime.json'], {
  stdio: 'inherit',
});
if (compiled.status !== 0) process.exit(compiled.status ?? 1);
for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
  await cp(file, `${output}/${file}`);
function compiledExports(value) {
  if (typeof value === 'string') return value.replace(/\.ts$/, '.js');
  if (Array.isArray(value)) return value.map(compiledExports);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compiledExports(v)]));
  return value;
}
for (const parent of ['apps', 'packages', 'games']) {
  for (const item of await readdir(parent, { withFileTypes: true })) {
    if (!item.isDirectory()) continue;
    const directory = `${parent}/${item.name}`;
    const manifest = JSON.parse(await readFile(`${directory}/package.json`, 'utf8'));
    manifest.exports = compiledExports(manifest.exports);
    if (manifest.exports && typeof manifest.exports === 'object')
      delete manifest.exports['./testing'];
    await mkdir(`${output}/${directory}`, { recursive: true });
    await writeFile(
      `${output}/${directory}/package.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
}
await cp('packages/database/migrations', `${output}/packages/database/migrations`, {
  recursive: true,
});
await mkdir(`${output}/deploy`, { recursive: true });
for (const file of ['container-entry.mjs', 'container-env.mjs', 'container-health.mjs'])
  await cp(`deploy/${file}`, `${output}/deploy/${file}`);
console.info('Compiled API/worker workspace and SQL assets; no migrations or processes started.');
