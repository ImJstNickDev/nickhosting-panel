import { serveHostObserver } from '../packages/pterodactyl-adapter/src/host-observer.js';

try {
  if (process.argv.slice(2).some((argument) => argument !== '--recover-stale-socket'))
    throw new Error();
  const helper = await serveHostObserver({
    recoverStaleSocket: process.argv.includes('--recover-stale-socket'),
    socket: process.env.NH_HOST_OBSERVER_SOCKET ?? '',
    dockerSocket: process.env.NH_HOST_DOCKER_SOCKET ?? '',
    observerId: process.env.NH_HOST_OBSERVER_ID ?? '',
    allowedDiskPaths: JSON.parse(process.env.NH_HOST_OBSERVER_DISK_PATHS ?? 'null'),
  });
  console.log('Development host observer ready');
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.once(signal, () => {
      void helper.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
} catch {
  console.error('Development host observer unavailable');
  process.exitCode = 1;
}
