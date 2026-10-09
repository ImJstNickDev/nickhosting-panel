import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Reads only this project's already-approved services; never starts containers.
const values = Object.fromEntries(
  readFileSync('.env.test.local', 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
function endpoint(service: string, containerPort: string) {
  const args = ['compose', '--env-file', '.env.test.local', '-f', 'compose.test.yaml'];
  const found = spawnSync('docker', [...args, 'ps', '-q', service], { encoding: 'utf8' });
  if (found.status !== 0 || !found.stdout.trim())
    throw new Error('Approved test service is unavailable');
  const inspected = spawnSync('docker', ['inspect', found.stdout.trim()], { encoding: 'utf8' });
  if (inspected.status !== 0) throw new Error('Cannot prove test resource ownership');
  const info = JSON.parse(inspected.stdout)[0];
  if (
    info.Config.Labels['com.docker.compose.project'] !== 'nickhosting-m1-tests' ||
    info.Config.Labels['com.docker.compose.service'] !== service ||
    info.Config.Labels['com.docker.compose.project.working_dir'] !== process.cwd() ||
    info.Config.Labels['com.docker.compose.project.config_files'] !==
      `${process.cwd()}/compose.test.yaml` ||
    Object.keys(info.NetworkSettings.Networks).join() !== 'nickhosting-m1-tests_default'
  ) {
    throw new Error('Test resource ownership mismatch');
  }
  const published = info.NetworkSettings.Ports[`${containerPort}/tcp`];
  if (published?.length) {
    if (published.length !== 1 || published[0].HostIp !== '127.0.0.1')
      throw new Error('Unexpected test port exposure');
    return `127.0.0.1:${published[0].HostPort}`;
  }
  // Docker internal networks can suppress published ports. Keep the network
  // internal and discover only this proven test container's host-reachable IP.
  const address = info.NetworkSettings.Networks['nickhosting-m1-tests_default'].IPAddress;
  if (!address || !/^[0-9.]+$/.test(address)) throw new Error('Missing isolated test address');
  return `${address}:${containerPort}`;
}
const pgPassword = values.NH_TEST_POSTGRES_PASSWORD;
const redisPassword = values.NH_TEST_REDIS_PASSWORD;
if (!pgPassword || !redisPassword) throw new Error('Missing isolated test credentials');
const postgresEndpoint = endpoint('postgres', '5432');
const redisEndpoint = endpoint('redis', '6379');
const env = {
  ...process.env,
  NH_TEST_VERIFIED_DATABASE_HOST: postgresEndpoint.split(':')[0],
  NH_TEST_VERIFIED_REDIS_HOST: redisEndpoint.split(':')[0],
  NH_TEST_DATABASE_URL: `postgresql://nickhosting_test:${encodeURIComponent(pgPassword)}@${postgresEndpoint}/nickhosting_test`,
  NH_TEST_REDIS_URL: `redis://:${encodeURIComponent(redisPassword)}@${redisEndpoint}`,
};
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Pass a test command; credentials are never printed');
const child = spawnSync(command, args, { env, stdio: 'inherit' });
process.exit(child.status ?? 1);
