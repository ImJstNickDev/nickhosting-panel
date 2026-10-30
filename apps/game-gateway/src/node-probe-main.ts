import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeNodeEndpoint, startNodeProbe } from './node-probe.js';

/** Explicit deployment only. No listener opens merely by importing this module. */
export function nodeProbeConfiguration(env: Readonly<Record<string, string | undefined>>) {
  const address = env.NH_NODE_PROBE_ADDRESS ?? '';
  const parts = address.split('.').map(Number);
  const privateAddress =
    (isIP(address) === 4 &&
      (parts[0] === 10 ||
        (parts[0] === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) ||
        (parts[0] === 192 && parts[1] === 168))) ||
    (isIP(address) === 6 && /^(fc|fd)/i.test(address) && !address.includes('%'));
  const port = Number(env.NH_NODE_PROBE_PORT);
  if (!privateAddress || !Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('Private node probe address and unprivileged port required');
  return { address, port, transport: 'tcp' as const };
}

async function main() {
  const options = nodeProbeConfiguration(process.env);
  if (process.argv[2] === '--health') {
    process.exitCode = (await probeNodeEndpoint(options.address, options.port, 'tcp', 2000))
      ? 0
      : 1;
    return;
  }
  if (process.argv.length !== 2) throw new Error('Unsupported node probe command');
  const server = await startNodeProbe({ ...options, maxConnections: 32, timeoutMs: 1000 });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      void server.close().catch(() => {
        process.exitCode = 1;
      });
    });
  console.info('Private node probe ready');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('Private node probe failed');
    process.exitCode = 1;
  });
}
