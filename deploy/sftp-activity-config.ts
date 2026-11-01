import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { storagePath } from './storage-root.mjs';

/** Offline preparation only. Never contacts SFTPGo or changes existing users. */
export function sftpActivityConfiguration(input: {
  callbackUrl: string;
  instanceId: string;
  secret: string;
}) {
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      input.instanceId,
    ) ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(input.secret)
  )
    throw new Error('Invalid event configuration');
  const parsed = input;
  const url = new URL(parsed.callbackUrl);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1/provider-events/sftpgo'
  )
    throw new Error('Invalid callback URL');
  const body = JSON.stringify({
    schemaVersion: 1,
    instanceId: parsed.instanceId,
    eventId: '{{.UID}}',
    timestamp: '{{.Timestamp}}',
    username: '{{.Name}}',
    event: '{{.Event}}',
    status: '__STATUS__',
    virtualPath: '{{.VirtualPath}}',
    virtualTargetPath: '{{.VirtualTargetPath}}',
    fileSize: '__SIZE__',
    protocol: '{{.Protocol}}',
  })
    .replace('"__STATUS__"', '{{.Status}}')
    .replace('"__SIZE__"', '{{.FileSize}}');
  const names = ['nickhosting-activity-http-v1', 'nickhosting-activity-retry-v1'];
  const actions = names.map((name) => ({
    name,
    type: 1,
    options: {
      http_config: {
        endpoint: parsed.callbackUrl,
        method: 'POST',
        timeout: 10,
        skip_tls_verify: false,
        headers: [
          { key: 'Content-Type', value: 'application/json' },
          { key: 'Authorization', value: `Bearer ${parsed.secret}` },
        ],
        body,
      },
    },
  }));
  const rule = {
    name: 'nickhosting-activity-v1',
    status: 1,
    trigger: 1,
    conditions: {
      fs_events: ['upload', 'download', 'delete', 'rename', 'mkdir', 'rmdir', 'copy'],
      options: { protocols: ['SFTP'], event_statuses: [1, 2, 3] },
    },
    actions: names.map((name, index) => ({
      name,
      order: index + 1,
      relation_options: {
        execute_sync: false,
        stop_on_failure: false,
        is_failure_action: index === 1,
      },
    })),
  };
  return { actions, rule };
}

async function prepare() {
  const config = sftpActivityConfiguration({
    callbackUrl: process.env.NH_SFTPGO_EVENT_CALLBACK ?? '',
    instanceId: process.env.NH_SFTPGO_INSTANCE_ID ?? '',
    secret: process.env.NH_SFTPGO_EVENT_SECRET ?? '',
  });
  const directory = storagePath('sftp-activity-config');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // wx refuses to replace earlier proposals or accidentally follow an existing file.
  for (const action of config.actions)
    await writeFile(
      resolve(directory, `${action.name}.json`),
      `${JSON.stringify(action, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  await writeFile(
    resolve(directory, `${config.rule.name}.json`),
    `${JSON.stringify(config.rule, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  process.stdout.write(`Prepared three private JSON files under ${directory}. No requests sent.\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  prepare().catch(() => {
    process.stderr.write(
      'SFTP activity preparation failed; verify inputs and that output files do not already exist.\n',
    );
    process.exitCode = 1;
  });
