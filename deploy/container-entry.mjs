import { spawn } from 'node:child_process';
import { containerEnvironment } from './container-env.mjs';

const role = process.argv[2];
try {
  if (!['api', 'worker', 'migrate', 'web'].includes(role)) throw new Error('Unknown service role');
  const development = process.env.NH_DEPLOYMENT_ENV === 'development';
  if (role === 'web' && !development) throw new Error('Vite is prohibited in production');
  const env = role === 'web' ? process.env : containerEnvironment(process.env);
  const args =
    role === 'web' || (development && role !== 'migrate')
      ? ['scripts/dev-watch.mjs', role]
      : [
          ...(development ? ['--import', 'tsx'] : []),
          role === 'migrate'
            ? `packages/database/src/migrate-cli.${development ? 'ts' : 'js'}`
            : `apps/${role}/src/main.${development ? 'ts' : 'js'}`,
        ];
  const child = spawn(process.execPath, args, { env, stdio: 'inherit' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', () => {
    console.error('Service child failed to start');
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  // Validation errors contain field names only, never supplied values.
  console.error(error.message);
  process.exitCode = 1;
}
