import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argumentsList = process.argv.slice(2);
const m2 = argumentsList[0] === '--m2';
if (m2) argumentsList.shift();
const project = m2 ? 'nickhosting-m2-tests' : 'nickhosting-m1-tests';
const composeFile = m2 ? 'compose.m2-test.yaml' : 'compose.test.yaml';
const envFile = m2 ? '.env.m2-test.local' : '.env.test.local';

// Reads only this project's already-approved services; never starts containers.
const values = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
function endpoint(service: string, containerPort: string) {
  const args = ['compose', '--env-file', envFile, '-f', composeFile];
  const found = spawnSync('docker', [...args, 'ps', '-q', service], { encoding: 'utf8' });
  if (found.status !== 0 || !found.stdout.trim())
    throw new Error('Approved test service is unavailable');
  const inspected = spawnSync('docker', ['inspect', found.stdout.trim()], { encoding: 'utf8' });
  if (inspected.status !== 0) throw new Error('Cannot prove test resource ownership');
  const info = JSON.parse(inspected.stdout)[0];
  if (
    info.Config.Labels['com.docker.compose.project'] !== project ||
    info.Config.Labels['com.docker.compose.service'] !== service ||
    info.Config.Labels['com.docker.compose.project.working_dir'] !== process.cwd() ||
    info.Config.Labels['com.docker.compose.project.config_files'] !==
      `${process.cwd()}/${composeFile}` ||
    Object.keys(info.NetworkSettings.Networks).join() !== `${project}_default`
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
  const address = info.NetworkSettings.Networks[`${project}_default`].IPAddress;
  if (!address || !/^[0-9.]+$/.test(address)) throw new Error('Missing isolated test address');
  return `${address}:${containerPort}`;
}
const pgPassword = values.NH_TEST_POSTGRES_PASSWORD;
const redisPassword = values.NH_TEST_REDIS_PASSWORD;
if (!pgPassword || !redisPassword) throw new Error('Missing isolated test credentials');
const postgresEndpoint = endpoint('postgres', '5432');
const redisEndpoint = endpoint('redis', '6379');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  NH_TEST_VERIFIED_DATABASE_HOST: postgresEndpoint.split(':')[0],
  NH_TEST_VERIFIED_REDIS_HOST: redisEndpoint.split(':')[0],
  NH_TEST_DATABASE_URL: `postgresql://nickhosting_test:${encodeURIComponent(pgPassword)}@${postgresEndpoint}/nickhosting_test`,
  NH_TEST_REDIS_URL: `redis://:${encodeURIComponent(redisPassword)}@${redisEndpoint}`,
};
if (m2) {
  const sftpHttp = endpoint('sftpgo', '8080');
  const sftpSsh = endpoint('sftpgo', '2022');
  Object.assign(env, {
    NH_TEST_SFTPGO_URL: `http://${sftpHttp}`,
    NH_TEST_SFTPGO_HOST: sftpSsh.split(':')[0],
    NH_TEST_SFTPGO_PORT: sftpSsh.split(':')[1],
    NH_TEST_SFTPGO_ADMIN_USERNAME: values.NH_TEST_SFTPGO_ADMIN,
    NH_TEST_SFTPGO_ADMIN_PASSWORD: values.NH_TEST_SFTPGO_PASSWORD,
    NH_TEST_SFTPGO_DATA_ROOT: '/srv/sftpgo/data',
    NH_TEST_SFTPGO_LOCAL_DATA_ROOT: resolve('mountdata/m2-tests/sftpgo/data'),
  });
}
const [command, ...args] = argumentsList;
if (!command) throw new Error('Pass a test command; credentials are never printed');
const child = spawnSync(command, args, { env, stdio: 'inherit' });
process.exit(child.status ?? 1);
