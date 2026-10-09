import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('worker executable boundary', () => {
  it('does not attach signal handlers on import and rejects missing configuration', async () => {
    const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
    const { main } = await import('./main.js');
    expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual(before);
    await expect(main({})).rejects.toThrow('configuration_invalid');
  });

  it('exits with a safe startup error without printing credential-bearing input', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/worker/src/main.ts'], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        DATABASE_URL: 'postgres://user:private-fixture@example.com/db',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    expect(code).toBe(1);
    expect(output).toContain('worker.start_failed');
    expect(output).not.toContain('private-fixture');
    expect(output).not.toContain('postgres://');
  });
});
