import { readFile, writeFile } from 'node:fs/promises';
import {
  openworldLauncherFile,
  openworldLauncherSource,
  openworldStartup,
} from '../src/dashboard-launch.js';
import { openworldRuntimeImage } from '../src/manifest.js';

const source = await readFile(new URL('./install.py', import.meta.url), 'utf8');
const install =
  source +
  '\nimport base64\ninstall(' +
  JSON.stringify(openworldLauncherFile) +
  ', base64.b64decode(' +
  JSON.stringify(Buffer.from(openworldLauncherSource).toString('base64')) +
  ').decode("utf-8"))\n';
const variables = [
  ['Game version', 'OW_VERSION', 'latest', 'required|string|max:128'],
  ['Package SHA-256', 'OW_SHA256', '', 'nullable|string|size:64'],
  ['Package size', 'OW_ARCHIVE_SIZE', '', 'nullable|integer|min:1'],
  ['Installer download', 'OW_DOWNLOAD_URL', '', 'nullable|string|max:8192'],
  ['Server name', 'OW_SERVER_NAME', 'Openworld', 'string|max:100'],
  ['Dashboard port', 'OW_WEB_PORT', '24711', 'nullable|integer|min:1|max:65535'],
  ['Dashboard password', 'OW_WEB_PASSWORD', '', 'nullable|string|max:256'],
].map(([name, env_variable, default_value, rules]) => ({
  name,
  env_variable,
  default_value,
  rules,
  description: '',
  field_type: 'text',
  user_viewable: false,
  user_editable: false,
}));
const egg = {
  _comment: 'NickHosting Openworld dedicated server',
  meta: { version: 'PTDL_v2', update_url: null },
  exported_at: '2026-11-21T00:00:00+00:00',
  name: 'Openworld Dedicated',
  author: 'panel@nickhost.ing',
  description: 'Openworld dedicated server for Linux x64.',
  features: null,
  docker_images: { 'Debian Bookworm': openworldRuntimeImage },
  file_denylist: [openworldLauncherFile, '.nickhosting-openworld-config.json'],
  startup: openworldStartup,
  config: {
    files: '{}',
    startup: JSON.stringify({ done: 'network server started -- port=' }),
    logs: '{}',
    stop: 'stop',
  },
  scripts: {
    installation: {
      script: install,
      container: 'python:3.12-slim-bookworm',
      entrypoint: 'python3',
    },
  },
  variables,
};
await writeFile(
  new URL('./egg-openworld.json', import.meta.url),
  JSON.stringify(egg, null, 2) + '\n',
);
