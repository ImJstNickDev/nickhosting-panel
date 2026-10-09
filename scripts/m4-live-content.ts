/** Opt-in real management checks, invoked only by the reviewed live runner.
 * Every provider effect uses its provenance guard and existing M2/M4 jobs. */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ZipFile } from 'yazl';
import { parseMinecraftProperties } from '../games/minecraft/src/management.js';
import { probeMinecraftStatus } from '../games/minecraft/src/protocol.js';
import { ModrinthProvider } from '../packages/content-providers/src/index.js';
import {
  createMinecraftSourceStore,
  enqueueServerOperation,
  listMinecraftWorlds,
  minecraftContentWipePreview,
  prepareMinecraftContentPlan,
} from '../packages/server-management/src/index.js';
import type { MinecraftContentCommand } from '../packages/server-management/src/minecraft-content-contracts.js';
import type { MinecraftLiveScenarioContext } from './m4-live-scenario.js';

export async function checkMinecraftLiveContent(c: MinecraftLiveScenarioContext) {
  const { db, context, env, adapter, asset, runtime, prepared } = c;
  const serverId = asset.managedServerId;
  assert(
    asset.identifier && asset.uuid && asset.route,
    'A real completed protocol scenario is required',
  );
  const identifier = asset.identifier,
    route = asset.route;
  await c.prove(asset);
  await c.operation(serverId, { action: 'stop' });
  const store = createMinecraftSourceStore(db, context, env);
  const options = {
    ...(await runtime.minecraftOptions()),
    adapter,
    archiveResolver: store.archiveResolver,
    worldArchiveResolver: store.worldArchiveResolver,
  };
  const scratch = await mkdtemp(resolve('mountdata/test-assets', `m4-content-${c.ledger.runId}-`));
  await c.event('minecraft.content.local-fixture-created', { scratch });
  const text = async (path: string) =>
    Buffer.from(await adapter.readFile(identifier, path)).toString();
  async function command(input: MinecraftContentCommand) {
    await c.prove(asset);
    const plan = await prepareMinecraftContentPlan(db, serverId, input, options);
    const result = await enqueueServerOperation(
      db,
      context,
      serverId,
      {
        action: 'minecraft-content',
        idempotencyKey: randomUUID(),
        command: plan.command,
      },
      env,
      { minecraftPlan: plan },
    );
    await c.event(`minecraft.content.${input.kind}.queued`, { jobId: result.jobId });
    await c.pump(result.jobId);
    const profile = await db
      .selectFrom('minecraft_server_profiles')
      .selectAll()
      .where('server_id', '=', serverId)
      .executeTakeFirstOrThrow();
    assert(profile.installed, 'Completed content operation must restore installation proof');
    return result;
  }
  async function bootAndStop() {
    await c.operation(serverId, { action: 'start' });
    const deadline = Date.now() + 600000;
    let ready = false;
    while (Date.now() < deadline) {
      await c.prove(asset);
      const result = await probeMinecraftStatus(
        { route: route, signal: AbortSignal.timeout(5000) },
        prepared.protocol,
      );
      if (result.ready) {
        ready = true;
        break;
      }
      await delay(1500);
    }
    assert(ready, 'Installed content did not reach actual Minecraft status/ping readiness');
    await c.operation(serverId, { action: 'stop' });
  }
  async function source(path: string, kind: 'world' | 'modpack') {
    const size = (await stat(path)).size,
      hash = createHash('sha256');
    for await (const bytes of createReadStream(path)) hash.update(bytes);
    const entry = await store.reserveUpload({
      kind,
      serverId,
      bytes: size,
      sha256: hash.digest('hex'),
      idempotencyKey: randomUUID(),
    });
    await store.upload(
      entry.id,
      Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>,
      size,
    );
    assert.equal((await store.inspect(entry.id)).state, 'ready');
    return entry.id;
  }
  async function zip(path: string, files: { local: string; name: string }[]) {
    const archive = new ZipFile();
    const writing = pipeline(
      archive.outputStream,
      createWriteStream(path, { flags: 'wx', mode: 0o600 }),
    );
    for (const file of files) archive.addFile(file.local, file.name);
    archive.end();
    await writing;
  }

  const original = parseMinecraftProperties(await text('server.properties'));
  assert(original.motd !== undefined, 'Actual runtime property support missing');
  await command({ kind: 'properties', changes: { motd: 'NickHosting controlled M4 test' } });
  assert.equal(
    parseMinecraftProperties(await text('server.properties')).motd,
    'NickHosting controlled M4 test',
  );
  await command({ kind: 'properties', changes: { motd: original.motd } });
  for (const list of ['operators', 'whitelist'] as const) {
    await command({
      kind: 'player',
      list,
      action: 'add',
      name: 'Notch',
      ...(list === 'operators' ? { operatorLevel: 2, bypassesPlayerLimit: false } : {}),
    });
    const file = list === 'operators' ? 'ops.json' : 'whitelist.json';
    const row = (
      JSON.parse(await text(file)) as { name: string; uuid: string; level?: number }[]
    ).find((entry) => entry.name === 'Notch');
    assert(row && /^[a-f0-9-]{36}$/.test(row.uuid));
    if (list === 'operators') assert.equal(row.level, 2);
    await command({ kind: 'player', list, action: 'remove', name: 'Notch' });
    assert(
      !(JSON.parse(await text(file)) as { uuid: string }[]).some(
        (entry) => entry.uuid === row.uuid,
      ),
    );
  }
  await c.event('minecraft.properties-player-management.verified', {
    independentMojangIdentity: true,
  });

  // Capture the actual generated fixture world, preserving terrain files. No unrelated volume is read.
  const world = original['level-name'] ?? '';
  assert(world && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(world));
  const files: { local: string; name: string }[] = [];
  let total = 0;
  const scratchDisk = await statfs(scratch, { bigint: true });
  assert(
    scratchDisk.bavail * scratchDisk.bsize >= 16n * 1024n ** 3n + 512n * 1024n ** 2n,
    'Retain backing-filesystem headroom for bounded capture and ZIP',
  );
  async function capture(directory: string, depth = 0) {
    assert(depth <= 12);
    await c.prove(asset);
    for (const entry of await adapter.listFiles(identifier, directory)) {
      assert(
        /^[A-Za-z0-9._-]+$/.test(entry.name) &&
          !['.', '..'].includes(entry.name) &&
          !entry.is_symlink,
      );
      const remote = `${directory}/${entry.name}`;
      if (!entry.is_file) {
        await capture(remote, depth + 1);
        continue;
      }
      if (entry.name === 'session.lock') continue;
      total += entry.size;
      assert(
        total <= 256 * 1048576 && files.length < 5000,
        'Fixture world exceeds reviewed capture envelope',
      );
      const local = join(scratch, 'world', remote.slice(world.length + 1));
      await mkdir(dirname(local), { recursive: true, mode: 0o700 });
      const download = await adapter.downloadFile(identifier, remote, {
        maxBytes: entry.size,
        authorize: async () => {
          await c.prove(asset);
        },
      });
      await pipeline(download.body, createWriteStream(local, { flags: 'wx', mode: 0o600 }));
      assert.equal((await stat(local)).size, entry.size);
      files.push({ local, name: remote });
    }
  }
  await capture(world);
  assert(files.some((file) => file.name === `${world}/level.dat`));
  const archive = join(scratch, 'world.zip');
  await zip(archive, files);
  const archiveRef = await source(archive, 'world');
  const imported = 'm4-imported';
  await command({ kind: 'world-import', archiveRef, targetWorld: imported });
  const worlds = await listMinecraftWorlds(
    db,
    adapter,
    serverId,
    async () => {
      await c.prove(asset);
    },
    env,
  );
  assert(worlds.some((entry) => entry.name === imported));
  await command({ kind: 'world-select', world: imported });
  assert.equal(parseMinecraftProperties(await text('server.properties'))['level-name'], imported);
  await bootAndStop();
  await command({ kind: 'world-select', world });
  await command({ kind: 'world-remove', world: imported, confirm: true, backupBefore: false });
  assert(!(await adapter.listFiles(identifier)).some((entry) => entry.name === imported));
  await c.event('minecraft.world.import-select-ready-remove.verified', {
    archiveRef,
    files: files.length,
    bytes: total,
  });

  if (['fabric', 'paper', 'folia'].includes(prepared.runtime.profile)) {
    const projectId = prepared.runtime.profile === 'fabric' ? 'fabric-api' : 'luckperms';
    const provider = new ModrinthProvider(options.http);
    const versions = await provider.versions(projectId, {
      minecraftVersion: prepared.runtime.release,
      loader: prepared.runtime.profile,
      ...(prepared.runtime.loaderVersion ? { loaderVersion: prepared.runtime.loaderVersion } : {}),
    });
    const selected = versions[0];
    assert(
      selected,
      'No exact compatible real catalog artifact; do not substitute another runtime',
    );
    await command({ kind: 'install', provider: 'modrinth', projectId, versionId: selected.id });
    const items = await db
      .selectFrom('minecraft_content_items')
      .selectAll()
      .where('server_id', '=', serverId)
      .execute();
    assert(items.length > 0, 'Provider installation needs durable file identities');
    await bootAndStop();
    await command({ kind: 'remove', provider: 'modrinth', projectId: selected.project_id });
    await c.event('minecraft.modrinth.install-ready-remove.verified', {
      projectId: selected.project_id,
      versionId: selected.id,
    });
  }

  // A self-authored server-only mrpack exercises actual override layering and consent/backup.
  // It is identified as a format fixture; never presented as a third-party downloaded modpack.
  if (['vanilla', 'fabric', 'forge'].includes(prepared.runtime.profile)) {
    const pack = new ZipFile(),
      packPath = join(scratch, 'controlled.mrpack');
    const writing = pipeline(
      pack.outputStream,
      createWriteStream(packPath, { flags: 'wx', mode: 0o600 }),
    );
    pack.addBuffer(
      Buffer.from(
        JSON.stringify({
          formatVersion: 1,
          game: 'minecraft',
          versionId: 'm4-controlled',
          name: 'NickHosting controlled server fixture',
          files: [],
          dependencies: {
            minecraft: prepared.runtime.release,
            ...(prepared.runtime.loaderVersion
              ? {
                  [prepared.runtime.profile === 'fabric' ? 'fabric-loader' : 'forge']:
                    prepared.runtime.loaderVersion,
                }
              : {}),
          },
        }),
      ),
      'modrinth.index.json',
    );
    pack.addBuffer(Buffer.from('side=common\n'), 'overrides/config/nickhosting-m4.properties');
    pack.addBuffer(
      Buffer.from('side=server\n'),
      'server-overrides/config/nickhosting-m4.properties',
    );
    pack.addBuffer(Buffer.from('must-not-install\n'), 'client-overrides/client-only.txt');
    pack.end();
    await writing;
    const packRef = await source(packPath, 'modpack');
    const preview = await minecraftContentWipePreview(adapter, identifier);
    assert(preview.length > 0);
    const replacement = await command({
      kind: 'modpack-upload',
      archiveRef: packRef,
      replace: { wipeConsent: true, expectedDeletePaths: preview, backupBefore: true },
    });
    const operation = await db
      .selectFrom('server_operations')
      .select('plan')
      .where('job_id', '=', replacement.jobId)
      .executeTakeFirstOrThrow();
    assert.equal(operation.plan.backupComplete, true);
    assert.equal(typeof operation.plan.backupId, 'string');
    const backup = await adapter.getBackup(identifier, operation.plan.backupId as string);
    assert(backup.is_successful && backup.completed_at && backup.bytes > 0);
    assert.equal(await text('config/nickhosting-m4.properties'), 'side=server\n');
    assert(
      !(await adapter.listFiles(identifier)).some((entry) => entry.name === 'client-only.txt'),
    );
    await bootAndStop();
    await c.event('minecraft.mrpack.replacement-backup-and-readiness.verified', {
      sourceKind: 'self-authored-format-fixture',
      packRef,
      backupId: operation.plan.backupId,
      backupBytes: backup.bytes,
      backupRestorationVerified: false,
    });
  }
  // Keep exact fixture/source paths and their durable claims available for reviewed cleanup.
  await c.event('minecraft.content-management.completed', {
    scratch,
    runtime: prepared.runtime.profile,
  });
}
