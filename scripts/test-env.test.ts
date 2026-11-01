import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

it.each(['development fallback', 'test environment', 'process environment'])(
  'shares the %s storage root between Compose lookup and the test child',
  async (source) => {
    const root = await mkdtemp(join(tmpdir(), 'nh-test-env-'));
    directories.push(root);
    const bin = join(root, 'bin');
    await mkdir(bin);
    const development = join(root, 'development data');
    const test = join(root, 'test data');
    const explicit = join(root, 'explicit data');
    for (const directory of [development, test, explicit]) await mkdir(directory);
    await writeFile(join(root, '.env.dev.local'), `NH_MOUNTDATA_ROOT='${development}'\n`);
    await writeFile(
      join(root, '.env.m2-test.local'),
      [
        'NH_TEST_POSTGRES_PASSWORD=fixture',
        'NH_TEST_REDIS_PASSWORD=fixture',
        'NH_TEST_SFTPGO_ADMIN=fixture',
        'NH_TEST_SFTPGO_PASSWORD=fixture',
        ...(source !== 'development fallback' ? [`NH_MOUNTDATA_ROOT='${test}'`] : []),
      ].join('\n'),
    );
    await writeFile(
      join(root, 'docker.mjs'),
      `import {appendFileSync} from 'node:fs';
const args=process.argv.slice(2);
appendFileSync('compose-roots.jsonl', JSON.stringify(process.env.NH_MOUNTDATA_ROOT??null)+'\\n');
if(args[0]==='compose') process.stdout.write(args.at(-1));
else if(args[0]==='inspect') process.stdout.write(JSON.stringify([{
Config:{Labels:{'com.docker.compose.project':'nickhosting-m2-tests',
'com.docker.compose.service':args[1],'com.docker.compose.project.working_dir':process.cwd(),
'com.docker.compose.project.config_files':process.cwd()+'/compose.m2-test.yaml'}},
NetworkSettings:{Networks:{'nickhosting-m2-tests_default':{IPAddress:'127.0.0.1'}},Ports:{}}
}])); else process.exit(2);`,
    );
    await writeFile(
      join(bin, 'docker'),
      '#!/bin/sh\nexec "$NH_TEST_NODE" "$NH_TEST_DOCKER_SCRIPT" "$@"\n',
      { mode: 0o700 },
    );
    await writeFile(
      join(root, 'child.mjs'),
      `import {writeFileSync} from 'node:fs';writeFileSync('child-root.json',JSON.stringify({
root:process.env.NH_MOUNTDATA_ROOT,data:process.env.NH_TEST_SFTPGO_LOCAL_DATA_ROOT}));`,
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      NH_TEST_NODE: process.execPath,
      NH_TEST_DOCKER_SCRIPT: join(root, 'docker.mjs'),
    };
    delete env.NH_MOUNTDATA_ROOT;
    if (source === 'process environment') env.NH_MOUNTDATA_ROOT = explicit;
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        resolve('scripts/test-env.ts'),
        '--m2',
        process.execPath,
        join(root, 'child.mjs'),
      ],
      { cwd: root, env, encoding: 'utf8' },
    );
    expect(result.status, result.stderr).toBe(0);
    const selected =
      source === 'process environment'
        ? explicit
        : source === 'test environment'
          ? test
          : development;
    expect(JSON.parse(await readFile(join(root, 'child-root.json'), 'utf8'))).toEqual({
      root: selected,
      data: join(selected, 'm2-tests/sftpgo/data'),
    });
    const roots = (await readFile(join(root, 'compose-roots.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    // docker inspect is read-only and needs no interpolation; only Compose gets the root.
    expect(roots.filter((_, index) => index % 2 === 0)).toEqual(Array(4).fill(selected));
  },
);
