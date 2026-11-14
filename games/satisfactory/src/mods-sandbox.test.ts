import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'linux')(
  'confines CLI writes and environment or refuses unsupported kernels before execution',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'nh-landlock-'));
    try {
      const stage = join(root, 'stage'),
        outside = join(root, 'outside');
      await mkdir(stage, { mode: 0o700 });
      await writeFile(outside, 'preserve');
      const executable = join(root, 'sandbox');
      await promisify(execFile)('cc', [
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-o',
        executable,
        resolve('deploy/native/content-sandbox.c'),
      ]);
      const script = `import os
assert "NH_TEST_SECRET" not in os.environ
open("inside", "w").write("allowed")
for path, mode in [("../outside", "w"), ("../outside", "r"), ("../new", "w")]:
    try:
        open(path, mode)
        raise AssertionError("escaped sandbox")
    except PermissionError:
        pass
for mutate in [lambda: os.chmod("../outside", 0o666), lambda: os.chown("../outside", os.getuid(), os.getgid()), lambda: os.utime("../outside", (0,0)), lambda: os.setxattr("../outside", "user.escape", b"x")]:
    try:
        mutate()
        raise AssertionError("metadata escaped sandbox")
    except PermissionError:
        pass
try:
    os.truncate("../outside", 0)
    raise AssertionError("path truncate escaped")
except PermissionError:
    pass
try:
    os.open("../outside", os.O_RDONLY | os.O_TRUNC)
    raise AssertionError("read-only truncate escaped")
except PermissionError:
    pass
with open("inside", "r+") as handle:
    os.ftruncate(handle.fileno(), 7)
try:
    os.rename("inside", "../moved")
    raise AssertionError("rename escaped")
except PermissionError:
    pass
print("confined")`;
      const supported = await promisify(execFile)(executable, ['--check']).then(
        () => true,
        () => false,
      );
      if (!supported) {
        await expect(
          promisify(execFile)(executable, [stage, '/usr/bin/python3', '-c', script]),
        ).rejects.toMatchObject({ code: 125 });
        expect(await readFile(outside, 'utf8')).toBe('preserve');
        await expect(readFile(join(stage, 'inside'))).rejects.toMatchObject({ code: 'ENOENT' });
        return;
      }
      const result = await promisify(execFile)(
        executable,
        [stage, '/usr/bin/python3', '-c', script],
        { env: { PATH: process.env.PATH, NH_TEST_SECRET: 'must-not-inherit' } },
      );
      expect(result.stdout.trim()).toBe('confined');
      for (const value of ['0', '-1', '1x', '17179869185']) {
        await expect(
          promisify(execFile)(executable, [stage, '/usr/bin/python3', '-c', 'pass'], {
            env: { PATH: process.env.PATH, NH_CONTENT_MAX_FILE_BYTES: value },
          }),
        ).rejects.toMatchObject({ code: 125 });
      }
      const budget = await promisify(execFile)(
        executable,
        [
          stage,
          '/usr/bin/python3',
          '-c',
          'import resource; print(resource.getrlimit(resource.RLIMIT_FSIZE)[0])',
        ],
        { env: { PATH: process.env.PATH, NH_CONTENT_MAX_FILE_BYTES: '2147483648' } },
      );
      expect(budget.stdout.trim()).toBe('2147483648');

      expect(await readFile(outside, 'utf8')).toBe('preserve');
      expect(await readFile(join(stage, 'inside'), 'utf8')).toBe('allowed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
