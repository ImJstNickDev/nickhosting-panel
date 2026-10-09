import { createHash, randomUUID } from 'node:crypto';
import { availableParallelism, totalmem } from 'node:os';
import { resolve } from 'node:path';
import type { AuthContext, SecretCodec } from '@nickhosting/core';
import { authSessionId, DomainError } from '@nickhosting/core';
import type { createTestDatabase } from '@nickhosting/database/testing';
import { minecraftManifest } from '@nickhosting/minecraft';
import type {
  Allocation,
  ApplicationServer,
  Backup,
  BackupActivity,
  ConsoleRelayOptions,
  PterodactylAdapter,
  Resources,
  ServerFile,
} from '@nickhosting/pterodactyl-adapter';
import { PterodactylError } from '@nickhosting/pterodactyl-adapter';
import { createManagedServer, createManagementRuntime } from '@nickhosting/server-management';
import {
  browserLevelDat,
  browserMinecraft,
  installMinecraftBrowserChoice,
} from './minecraft-fixture.js';

type Database = Awaited<ReturnType<typeof createTestDatabase>>;
type Remote = {
  server: ApplicationServer;
  state: Resources['current_state'];
  startedAt: string | null;
  files: Map<string, Buffer>;
  directories: Set<string>;
  backups: Map<string, { metadata: Backup; files: Map<string, Buffer> }>;
  activities: BackupActivity[];
  consoles: Set<ConsoleRelayOptions>;
};

/** Test-only external provider. All application auth, jobs, admission, manifests,
 * signatures, identity fences and file handlers remain the actual implementation.
 * No network request, live API identity, Docker resource or game process exists. */
export async function installBrowserFixtures(
  database: Database,
  ownerId: string,
  userId: string,
  env: Record<string, string | undefined>,
  codec: SecretCodec,
) {
  if (!database.schema.startsWith('nh_test_'))
    throw new Error('Browser fixtures require a disposable test schema');
  const { db } = database;
  const owner = await db
    .selectFrom('user')
    .select(['id', 'role'])
    .where('id', '=', ownerId)
    .executeTakeFirst();
  const user = await db
    .selectFrom('user')
    .select(['id', 'role'])
    .where('id', '=', userId)
    .executeTakeFirst();
  if (owner?.role !== 'owner' || !user)
    throw new Error('Real browser setup and registration must precede provider fixtures');
  const hostId = randomUUID(),
    nodeId = randomUUID(),
    mappingId = randomUUID(),
    instanceId = randomUUID();
  const observerId = `browser-fixture-${randomUUID()}`;
  Object.assign(env, {
    NH_OBSERVER_ID: observerId,
    NH_STATIC_GAME_HOSTNAME: 'games.example.test',
    NH_SFTPGO_BASE_URL: 'https://sftp-api.example.test',
    NH_SFTPGO_DATA_ROOT: '/isolated-browser-fixture',
    NH_SFTPGO_INSTANCE_ID: instanceId,
    NH_SFTPGO_API_KEY: 'isolated-browser-provider-key',
    NH_SFTP_PUBLIC_HOSTNAME: 'sftp.example.test',
    NH_SFTP_PUBLIC_PORT: '2022',
    NH_PTERODACTYL_UPLOAD_ORIGINS: '["https://uploads.example.test"]',
  });
  const localPath = resolve('mountdata/m2-tests');
  const memoryLimit = Math.ceil(totalmem() / 1048576);
  const cpuLimit = availableParallelism() * 100;
  await db
    .insertInto('physical_hosts')
    .values({
      id: hostId,
      name: 'Browser test host',
      memory_limit_mib: memoryLimit,
      cpu_limit_percent: cpuLimit,
      storage_pool_mib: '1000000',
      memory_headroom_mib: 128,
      cpu_headroom_percent: 10,
      disk_headroom_mib: '128',
      local_disk_path: localPath,
      observer_id: observerId,
      upload_policy: JSON.stringify({
        providerMaxFileBytes: 64 * 1024 ** 2,
        temporaryDiskPath: localPath,
        temporaryDiskBudgetBytes: 128 * 1024 ** 2,
        temporaryDiskHeadroomBytes: 1024 ** 2,
      }),
    })
    .execute();
  const allocations: Allocation[] = Array.from({ length: 30 }, (_, index) => ({
    id: 1000 + index,
    ip: '10.55.0.2',
    port: 25000 + index,
    assigned: false,
  }));
  await db
    .insertInto('managed_nodes')
    .values({
      id: nodeId,
      physical_host_id: hostId,
      pterodactyl_node_id: 1,
      provision_user_id: 1,
      backend_allocation_pool: JSON.stringify({
        allocations: allocations.map((a) => ({ allocationId: a.id, address: a.ip, port: a.port })),
        gatewayBindAddresses: ['192.0.2.10'],
      }),
    })
    .execute();
  await db
    .insertInto('game_integrations')
    .values({
      id: 'minecraft-java',
      version: minecraftManifest.version,
      manifest: minecraftManifest,
    })
    .execute();
  await db
    .insertInto('runtime_egg_mappings')
    .values({
      id: mappingId,
      game_id: 'minecraft-java',
      runtime_id: 'vanilla',
      node_id: nodeId,
      nest_id: 1,
      egg_id: 1,
      docker_image: browserMinecraft.image,
      startup: 'java -jar server.jar',
      environment: '{}',
      port_roles: JSON.stringify([{ role: 'game', protocols: ['tcp'], primary: true }]),
      feature_limits: JSON.stringify({ databases: 0, allocations: 1, backups: 5 }),
    })
    .execute();
  const choiceId = await installMinecraftBrowserChoice(database, mappingId, env);
  const remotes = new Map<number, Remote>();
  let nextId = 1;
  let available = true;
  const activeRelays = new Set<() => void>();
  function check() {
    if (!available) throw new PterodactylError('unavailable', 'client', 'rejected');
  }
  function remote(id: number | string) {
    check();
    const value =
      typeof id === 'number'
        ? remotes.get(id)
        : [...remotes.values()].find((r) => r.server.identifier === id || r.server.uuid === id);
    if (!value) throw new PterodactylError('not_found', 'client', 'rejected');
    return value;
  }
  function path(value: string, root = false) {
    const clean = value.replace(/^\//, '').replace(/\/$/, '');
    if (
      (!root && !clean) ||
      clean.split('/').some((p) => p === '..' || p === '.') ||
      clean.includes('\0')
    )
      throw new DomainError('validation_failed');
    return clean;
  }
  function put(r: Remote, p: string, bytes: Buffer) {
    const name = path(p);
    r.files.set(name, Buffer.from(bytes));
    const parts = name.split('/');
    parts.pop();
    while (parts.length) {
      r.directories.add(parts.join('/'));
      parts.pop();
    }
  }
  function install(r: Remote) {
    put(r, 'server.jar', browserMinecraft.serverJar);
    if (!r.files.has('server.properties'))
      put(r, 'server.properties', Buffer.from(browserMinecraft.properties));
    for (const [name, content] of [
      ['ops.json', '[]'],
      ['whitelist.json', '[]'],
    ] as const)
      if (!r.files.has(name)) put(r, name, Buffer.from(content));
    if (!r.files.has('world/level.dat')) put(r, 'world/level.dat', browserLevelDat());
  }
  function stats(r: Remote): Resources {
    return {
      current_state: r.state,
      is_suspended: false,
      resources: {
        memory_bytes: r.state === 'running' ? 80 * 1024 ** 2 : 0,
        cpu_absolute: r.state === 'running' ? 4 : 0,
        disk_bytes: [...r.files.values()].reduce((a, b) => a + b.length, 0),
        network_rx_bytes: 32768,
        network_tx_bytes: 65536,
        uptime: r.startedAt ? Date.now() - Date.parse(r.startedAt) : 0,
      },
    };
  }
  function emit(r: Remote, event: Parameters<ConsoleRelayOptions['onEvent']>[0]) {
    for (const relay of r.consoles) relay.onEvent(event);
  }
  async function stream(bytes: Buffer, input: Parameters<PterodactylAdapter['downloadFile']>[2]) {
    await input.authorize?.();
    if (bytes.length > (input.maxBytes ?? Number.MAX_SAFE_INTEGER))
      throw new DomainError('validation_failed');
    let offset = 0;
    return {
      contentType: 'application/octet-stream' as const,
      contentLength: bytes.length,
      body: new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              check();
              input.signal?.throwIfAborted();
              await input.authorize?.();
              if (offset === bytes.length) {
                controller.close();
                return;
              }
              const end = Math.min(offset + 65536, bytes.length);
              controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
              offset = end;
            } catch (error) {
              controller.error(error);
            }
          },
        },
        { highWaterMark: 0 },
      ),
    };
  }
  const node = {
    id: 1,
    uuid: randomUUID(),
    name: 'Browser fixture node',
    fqdn: 'node.example.test',
    scheme: 'https' as const,
    memory: 8192,
    memory_overallocate: 0,
    disk: 1000000,
    disk_overallocate: 0,
    daemon_listen: 8080,
    daemon_sftp: 2022,
    location_id: 1,
  };
  const egg = {
    id: 1,
    uuid: randomUUID(),
    name: 'Vanilla browser fixture',
    nest: 1,
    description: 'Synthetic external provider only',
    docker_image: browserMinecraft.image,
    docker_images: { Java25: browserMinecraft.image },
    startup: 'java -jar server.jar',
    config: { stop: 'stop' },
    relationships: {
      variables: {
        object: 'list' as const,
        data: [
          {
            attributes: {
              id: 1,
              name: 'Version',
              description: '',
              env_variable: 'VERSION',
              default_value: browserMinecraft.release,
              user_viewable: true,
              user_editable: true,
              rules: 'required|string',
            },
          },
        ],
      },
    },
  };
  const adapter: PterodactylAdapter = {
    getAccount: async () => {
      check();
      return { id: 1, admin: true };
    },
    listNodes: async () => {
      check();
      return [node];
    },
    getNode: async (id) => {
      check();
      if (id !== 1) throw new DomainError('not_found');
      return node;
    },
    listNests: async () => [{ id: 1, uuid: randomUUID(), name: 'Minecraft', description: null }],
    listEggs: async () => [egg],
    getEgg: async (nest, id) => {
      check();
      if (nest !== 1 || id !== 1) throw new DomainError('not_found');
      return egg;
    },
    listAllocations: async (id) => {
      check();
      if (id !== 1) throw new DomainError('not_found');
      return structuredClone(allocations);
    },
    listUsers: async () => [
      {
        id: 1,
        external_id: 'browser-provider-user',
        uuid: randomUUID(),
        username: 'fixture',
        root_admin: false,
      },
    ],
    listApplicationServers: async () => {
      check();
      return [...remotes.values()].map((r) => structuredClone(r.server));
    },
    getApplicationServer: async (id) => structuredClone(remote(id).server),
    findServerByExternalId: async (id) => {
      check();
      return structuredClone(
        [...remotes.values()].find((r) => r.server.external_id === id)?.server ?? null,
      );
    },
    createServer: async (plan) => {
      check();
      const owned = [plan.allocation.default, ...(plan.allocation.additional ?? [])].map((id) => {
        const a = allocations.find((a) => a.id === id);
        if (!a || a.assigned) throw new DomainError('conflict');
        return a;
      });
      const id = nextId++;
      const uuid = randomUUID();
      const at = new Date().toISOString();
      owned.forEach((a) => {
        a.assigned = true;
      });
      const server: ApplicationServer = {
        id,
        uuid,
        identifier: uuid.slice(0, 8),
        external_id: plan.externalId,
        name: plan.name,
        description: plan.description ?? '',
        suspended: false,
        limits: plan.limits,
        feature_limits: plan.featureLimits,
        user: plan.userId,
        node: 1,
        allocation: plan.allocation.default,
        nest: 1,
        egg: plan.eggId,
        status: null,
        container: {
          startup_command: plan.startup,
          image: plan.dockerImage,
          installed: 1,
          environment: { ...plan.environment },
        },
        created_at: at,
        updated_at: at,
        relationships: {
          allocations: { object: 'list', data: owned.map((a) => ({ attributes: { ...a } })) },
        },
      };
      const r: Remote = {
        server,
        state: 'offline',
        startedAt: null,
        files: new Map(),
        directories: new Set(),
        backups: new Map(),
        activities: [],
        consoles: new Set(),
      };
      install(r);
      remotes.set(id, r);
      return structuredClone(server);
    },
    updateBuild: async (id, input) => {
      const r = remote(id);
      r.server.limits = {
        memory: input.memory,
        cpu: input.cpu,
        disk: input.disk,
        swap: input.swap,
        io: input.io,
      };
      r.server.feature_limits = input.feature_limits;
      return structuredClone(r.server);
    },
    updateStartup: async (id, input) => {
      const r = remote(id);
      r.server.container = {
        ...r.server.container,
        image: input.image,
        startup_command: input.startup,
        environment: input.environment,
      };
      r.server.egg = input.egg;
      return structuredClone(r.server);
    },
    updateDetails: async (id, input) => {
      const r = remote(id);
      Object.assign(r.server, input);
      return structuredClone(r.server);
    },
    deleteServer: async (id) => {
      const r = remote(id);
      for (const allocation of allocations)
        if (
          r.server.relationships?.allocations?.data.some((a) => a.attributes.id === allocation.id)
        )
          allocation.assigned = false;
      emit(r, { type: 'closed' });
      remotes.delete(id);
    },
    getClientServer: async (id) => {
      const r = remote(id);
      return {
        server_owner: true,
        identifier: r.server.identifier,
        uuid: r.server.uuid,
        name: r.server.name,
        description: r.server.description ?? '',
        limits: r.server.limits,
        feature_limits: r.server.feature_limits,
        is_suspended: false,
        is_installing: false,
        is_transferring: false,
        status: r.server.status,
      };
    },
    listClientServers: async () =>
      Promise.all([...remotes.values()].map((r) => adapter.getClientServer(r.server.identifier))),
    getClientPermissions: async (id) => {
      remote(id);
      return ['*'];
    },
    getResources: async (id) => stats(remote(id)),
    confirmInstallation: async (id, identifier, input) => {
      const r = remote(id);
      if (r.server.identifier !== identifier || !(await input.authorize()))
        throw new DomainError('forbidden');
      await input.onConfirmed();
      return { confirmed: true };
    },
    reinstallWithConfirmation: async (id, identifier, input) => {
      const r = remote(id);
      if (r.server.identifier !== identifier || !(await input.authorize()))
        throw new DomainError('forbidden');
      install(r);
      await input.onConfirmed();
      return { confirmed: true };
    },
    stopWithConfirmation: async (id, identifier, input) => {
      const r = remote(id);
      if (r.server.identifier !== identifier || !(await input.authorize()))
        throw new DomainError('forbidden');
      await input.beforePower?.();
      await adapter.power(identifier, 'stop');
      await input.onConfirmed();
      return { confirmed: true };
    },
    power: async (id, action) => {
      const r = remote(id);
      if (action === 'start' || action === 'restart') {
        r.startedAt = new Date().toISOString();
        r.state = 'running';
        emit(r, { type: 'status', data: 'running' });
        emit(r, {
          type: 'console',
          data: '[Server thread/INFO]: Done. Browser provider fixture ready.',
        });
      } else {
        r.state = 'offline';
        r.startedAt = null;
        emit(r, { type: 'status', data: 'stopping' });
        emit(r, { type: 'status', data: 'offline' });
      }
    },
    reinstall: async (id) => install(remote(id)),
    reinstallApplication: async (id) => install(remote(id)),
    sendCommand: async (id, command) =>
      emit(remote(id), {
        type: 'console',
        data: `[Server thread/INFO]: ${command === 'list' ? 'There are 0 of a max of 20 players online' : `Command received: ${command}`}`,
      }),
    listFiles: async (id, directory = '') => {
      const r = remote(id),
        root = path(directory, true),
        prefix = root ? `${root}/` : '';
      const files: ServerFile[] = [];
      const now = new Date().toISOString();
      for (const name of new Set([...r.files.keys(), ...r.directories])) {
        if (!name.startsWith(prefix)) continue;
        const short = name.slice(prefix.length);
        if (!short || short.includes('/')) continue;
        const bytes = r.files.get(name);
        files.push({
          name: short,
          mode: bytes ? '-rw-r--r--' : 'drwxr-xr-x',
          size: bytes?.length ?? 0,
          is_file: !!bytes,
          is_symlink: false,
          mimetype: bytes ? 'application/octet-stream' : 'inode/directory',
          created_at: now,
          modified_at: now,
        });
      }
      return files.sort((a, b) => a.name.localeCompare(b.name));
    },
    readFile: async (id, name, maxBytes) => {
      const value = remote(id).files.get(path(name));
      if (!value) throw new PterodactylError('not_found', 'client', 'rejected');
      if (value.length > (maxBytes ?? 1048576)) throw new DomainError('validation_failed');
      return new Uint8Array(value);
    },
    writeFile: async (id, name, content) => put(remote(id), name, Buffer.from(content)),
    deleteFiles: async (id, directory, names) => {
      const r = remote(id);
      for (const name of names) {
        const key = path([path(directory, true), name].filter(Boolean).join('/'));
        for (const file of r.files.keys())
          if (file === key || file.startsWith(`${key}/`)) r.files.delete(file);
        for (const dir of r.directories)
          if (dir === key || dir.startsWith(`${key}/`)) r.directories.delete(dir);
      }
    },
    createDirectory: async (id, directory, name) => {
      remote(id).directories.add(path([path(directory, true), name].filter(Boolean).join('/')));
    },
    renameFiles: async (id, directory, renames) => {
      const r = remote(id);
      for (const rename of renames) {
        const from = path([path(directory, true), rename.from].filter(Boolean).join('/'));
        const to = path([path(directory, true), rename.to].filter(Boolean).join('/'));
        for (const [name, bytes] of [...r.files])
          if (name === from || name.startsWith(`${from}/`)) {
            put(r, to + name.slice(from.length), bytes);
            r.files.delete(name);
          }
        for (const name of [...r.directories])
          if (name === from || name.startsWith(`${from}/`)) {
            r.directories.add(to + name.slice(from.length));
            r.directories.delete(name);
          }
      }
    },
    listBackups: async (id) => [...remote(id).backups.values()].map((b) => ({ ...b.metadata })),
    listBackupActivity: async (id) => structuredClone(remote(id).activities),
    getBackup: async (id, backupId) => {
      const b = remote(id).backups.get(backupId);
      if (!b) throw new PterodactylError('not_found', 'client', 'rejected');
      return { ...b.metadata };
    },
    createBackup: async (id, input) => {
      const r = remote(id);
      const uuid = randomUUID();
      const snapshot = new Map([...r.files].map(([p, b]) => [p, Buffer.from(b)]));
      const metadata: Backup = {
        uuid,
        name: input.name,
        is_successful: true,
        is_locked: input.is_locked ?? false,
        ignored_files: [],
        checksum: `sha256:${createHash('sha256')
          .update(Buffer.concat([...snapshot.values()]))
          .digest('hex')}`,
        bytes: [...snapshot.values()].reduce((sum, b) => sum + b.length, 0),
        created_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      };
      r.backups.set(uuid, { metadata, files: snapshot });
      return metadata;
    },
    deleteBackup: async (id, backupId) => {
      remote(id).backups.delete(backupId);
    },
    restoreBackup: async (id, backupId, truncate) => {
      const r = remote(id),
        backup = r.backups.get(backupId);
      if (!backup) throw new PterodactylError('not_found', 'client', 'rejected');
      if (truncate) {
        r.files.clear();
        r.directories.clear();
      }
      for (const [p, b] of backup.files) put(r, p, b);
      r.activities.push({
        id: createHash('sha1').update(randomUUID()).digest('hex'),
        event: 'server:backup.restore-complete',
        timestamp: new Date().toISOString(),
        properties: { name: backup.metadata.name },
      });
    },
    downloadBackup: async (id, backupId, input) => {
      const r = remote(id),
        backup = r.backups.get(backupId);
      if (!backup) throw new PterodactylError('not_found', 'client', 'rejected');
      return stream(Buffer.concat([...backup.files.values()]), input);
    },
    downloadFile: async (id, name, input) => {
      const bytes = remote(id).files.get(path(name));
      if (!bytes) throw new PterodactylError('not_found', 'client', 'rejected');
      return stream(bytes, input);
    },
    uploadFile: async (id, name, input) => {
      const r = remote(id);
      let size = 0;
      const chunks: Uint8Array[] = [];
      const reader = input.body.getReader();
      try {
        for (;;) {
          check();
          input.signal?.throwIfAborted();
          await input.authorize?.();
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > input.maxBytes || size > input.contentLength || size > 64 * 1024 ** 2)
            throw new DomainError('validation_failed');
          chunks.push(item.value);
        }
        if (size !== input.contentLength) throw new DomainError('validation_failed');
        await input.authorize?.();
        put(r, name, Buffer.concat(chunks, size));
      } finally {
        reader.releaseLock();
      }
    },
    relayConsole: async (id, input) => {
      const r = remote(id);
      if (!(await input.authorize())) throw new DomainError('forbidden');
      r.consoles.add(input);
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        r.consoles.delete(input);
        activeRelays.delete(close);
        input.onEvent({ type: 'closed' });
      };
      const timer = setInterval(() => {
        void input
          .authorize()
          .then((ok) => {
            if (!ok) close();
          })
          .catch(close);
      }, 1000);
      timer.unref();
      activeRelays.add(close);
      input.signal?.addEventListener('abort', close, { once: true });
      return {
        close,
        sendCommand: async (command) => {
          if (closed || !input.canSendCommands || !(await input.authorize()))
            throw new DomainError('forbidden');
          await adapter.sendCommand(id, command);
        },
        requestLogs: async () => {
          if (closed || !(await input.authorize())) throw new DomainError('forbidden');
          input.onEvent({ type: 'status', data: r.state });
          input.onEvent({
            type: 'console',
            data: '[Server thread/INFO]: Browser provider fixture attached.',
          });
        },
        requestStats: async () => {
          if (closed || !(await input.authorize())) throw new DomainError('forbidden');
          const s = stats(r).resources;
          input.onEvent({
            type: 'stats',
            data: { ...s, network: { rx_bytes: s.network_rx_bytes, tx_bytes: s.network_tx_bytes } },
          });
        },
      };
    },
    discoverCapabilities: async () => {
      check();
      return Object.fromEntries(
        ['nodes', 'nests', 'servers', 'users', 'client'].map((key) => [key, { available: true }]),
      );
    },
  };
  const management = await createManagementRuntime({
    db,
    codec,
    env,
    adapter,
    containerObserver: {
      preflight: async () => {
        check();
      },
      stopped: async (uuid) => remote(uuid).state === 'offline',
      processStartedAt: async (uuid) => remote(uuid).startedAt,
      imageIdentity: async (uuid) => {
        remote(uuid);
        return browserMinecraft.imageDigest;
      },
    },
  });
  // The provider fixture has no 20-second Panel cache. Use the existing isolated
  // lifecycle clock hook, not altered job outcomes or replaced production logic.
  Object.assign(management.lifecycle, { settleMs: 0 });
  type CredentialRef = Awaited<
    ReturnType<
      ReturnType<NonNullable<typeof management.externalOptions.sftpFactory>>['ensureCredential']
    >
  >;
  const credentials = new Map<string, CredentialRef>();
  management.externalOptions.sftpFactory = () => ({
    ensureCredential: async (input) => {
      check();
      const existing = credentials.get(input.credentialId);
      if (existing) return existing;
      const ref = {
        instanceId,
        serverId: input.serverId,
        externalServerUuid: input.externalServerUuid,
        credentialId: input.credentialId,
        username: `nh_${input.credentialId.replaceAll('-', '')}`,
        externalUserId: credentials.size + 1,
        expiresAt: input.expiresAt,
        quotaBytes: input.quotaBytes,
      };
      credentials.set(input.credentialId, ref);
      return ref;
    },
    inspectCredential: async (input) => {
      check();
      return credentials.get(input.credentialId) ?? null;
    },
    rotateCredential: async (ref, input) => {
      check();
      if (!credentials.has(ref.credentialId)) throw new DomainError('not_found');
      const next = { ...ref, expiresAt: input.expiresAt };
      credentials.set(ref.credentialId, next);
      return next;
    },
    revokeCredential: async (ref) => {
      check();
      credentials.delete(ref.credentialId);
    },
  });
  async function processPending() {
    const results: Array<{ jobId: string; state: string; result: string }> = [];
    for (let pass = 0; pass < 12; pass++) {
      const pending = await db
        .selectFrom('operation_jobs as job')
        .innerJoin('server_operations as operation', 'operation.job_id', 'job.id')
        .select(['job.id', 'job.state', 'job.next_attempt_at'])
        .where('job.state', 'in', ['queued', 'running'])
        .execute();
      if (!pending.length) break;
      for (const job of pending) {
        // Advance delivery eligibility only in this disposable schema; effects,
        // confirmations, error classification and terminal states stay real.
        await db
          .updateTable('operation_jobs')
          .set({ next_attempt_at: new Date(0) })
          .where('id', '=', job.id)
          .execute();
        const result = await management.process(job.id);
        const row = await db
          .selectFrom('operation_jobs')
          .select('state')
          .where('id', '=', job.id)
          .executeTakeFirstOrThrow();
        results.push({ jobId: job.id, state: row.state, result });
      }
    }
    return results;
  }
  await management.refreshObservations();
  const session = await db
    .selectFrom('session')
    .select('id')
    .where('userId', '=', userId)
    .where('expiresAt', '>', new Date())
    .executeTakeFirstOrThrow();
  const context: AuthContext = {
    [authSessionId]: session.id,
    actorUserId: userId,
    subjectUserId: userId,
    role: user.role,
    sessionType: 'regular',
    ownerElevation: false,
  };
  const created = await createManagedServer(
    db,
    adapter,
    context,
    {
      idempotencyKey: randomUUID(),
      mappingId,
      name: 'Survival',
      limits: { memory: 128, cpu: 10, disk: 64, swap: 0, io: 500 },
      autoStart: false,
      minecraft: { choiceId, configuration: { eula: true } },
    },
    env,
  );
  await processPending();
  const provision = await db
    .selectFrom('operation_jobs')
    .select(['state', 'error_code'])
    .where('id', '=', created.jobId)
    .executeTakeFirstOrThrow();
  if (provision.state !== 'succeeded')
    throw new Error(`Browser provider provisioning did not succeed: ${JSON.stringify(provision)}`);
  return {
    management,
    adapter,
    ids: {
      hostId,
      nodeId,
      mappingId,
      serverId: created.serverId,
      choiceId,
      provisionJobId: created.jobId,
    },
    processPending,
    async setResourcesAvailable(value: boolean) {
      await db
        .updateTable('physical_hosts')
        .set({ memory_limit_mib: value ? memoryLimit : 129 })
        .where('id', '=', hostId)
        .execute();
    },
    setProviderAvailable(value: boolean) {
      available = value;
    },
    files(serverId = created.serverId) {
      return db
        .selectFrom('managed_servers')
        .select('pterodactyl_identifier')
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow()
        .then((server) => remote(server.pterodactyl_identifier ?? '').files);
    },
    remoteCount() {
      return remotes.size;
    },
    credentials,
    dispose() {
      for (const close of activeRelays) close();
      remotes.clear();
      credentials.clear();
    },
  };
}
