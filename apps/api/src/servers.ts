import { type AuthContext, DomainError } from '@nickhosting/core';
import { type createDatabase, recordAudit } from '@nickhosting/database';
import { relativePath } from '@nickhosting/pterodactyl-adapter';
import {
  assignServerDns,
  authorizeServer,
  backendAllocationPoolOverrides,
  createManagedServer,
  createProject,
  createSftpCredential,
  deleteServerDns,
  effectiveBackendAllocationPool,
  effectiveNodeOverhead,
  effectiveUploadPolicy,
  enqueueServerOperation,
  listServerDns,
  listServers,
  listSftpCredentials,
  type ManagementRuntime,
  ownerOnly,
  parse,
  previewServerDns,
  publicServer,
  recoverUploadIngestion,
  reserveUploadIngestion,
  resolveHostOverride,
  resolveUncertainOperation,
  revokeSftpCredential,
  rotateSftpCredential,
  setManagedNode,
  setPhysicalHost,
  setProjectMember,
  setRuntimeMapping,
  setUserLimits,
  updateServerDns,
  uploadPolicyOverrides,
} from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Variables } from './app.js';
import { boundedEventWriter } from './stream-buffer.js';

type C = Context<{ Variables: Variables }>;
export interface ServerRouteOptions {
  db: ReturnType<typeof createDatabase>['db'];
  env: Readonly<Record<string, string | undefined>>;
  principal: (c: C, regularOnly?: boolean) => Promise<AuthContext>;
  management: () => Promise<ManagementRuntime>;
  acquireUploadSlot: () => () => void;
}
async function body(c: C): Promise<unknown> {
  if (!c.req.header('content-type')?.startsWith('application/json'))
    throw new DomainError('validation_failed');
  try {
    return await c.req.json();
  } catch {
    throw new DomainError('validation_failed');
  }
}
export function registerServerRoutes(
  app: Hono<{ Variables: Variables }>,
  options: ServerRouteOptions,
) {
  const { db, env, principal, management } = options;
  const owner = async (c: C) => {
    const context = await principal(c, true);
    ownerOnly(context);
    return context;
  };
  app.get('/v1/owner/infrastructure', async (c) => {
    await owner(c);
    const service = await management();
    const [nodes, nests, capabilities] = await Promise.all([
      service.adapter.listNodes(),
      service.adapter.listNests(),
      service.adapter.discoverCapabilities(),
    ]);
    return c.json({ nodes, nests, capabilities });
  });
  app.get('/v1/owner/nests/:id/eggs', async (c) => {
    await owner(c);
    return c.json(
      await (await management()).adapter.listEggs(
        parse(z.coerce.number().int().positive(), c.req.param('id')),
      ),
    );
  });
  app.get('/v1/owner/nodes/:id/allocations', async (c) => {
    await owner(c);
    return c.json(
      await (await management()).adapter.listAllocations(
        parse(z.coerce.number().int().positive(), c.req.param('id')),
      ),
    );
  });
  app.get('/v1/owner/resource-hosts', async (c) => {
    await owner(c);
    const hosts = await db.selectFrom('physical_hosts').selectAll().execute();
    return c.json(
      hosts.map((host) => ({
        stored: host,
        effective: resolveHostOverride(host, env),
        effectiveUploadPolicy: effectiveUploadPolicy(host, env),
        uploadPolicyLocked: Object.hasOwn(uploadPolicyOverrides(env), host.id),
        locked:
          env.NH_HOST_POLICIES !== undefined &&
          Object.hasOwn(JSON.parse(env.NH_HOST_POLICIES), host.id),
      })),
    );
  });
  app.get('/v1/owner/uploads', async (c) => {
    await owner(c);
    return c.json(
      await db
        .selectFrom('upload_ingestion_claims')
        .selectAll()
        .orderBy('created_at', 'asc')
        .execute(),
    );
  });
  app.post('/v1/owner/uploads/:claimId/recover', async (c) => {
    await recoverUploadIngestion(db, await owner(c), c.req.param('claimId'), await body(c), env);
    return c.body(null, 204);
  });
  app.put('/v1/owner/resource-hosts', async (c) =>
    c.json(await setPhysicalHost(db, await owner(c), await body(c), env)),
  );
  app.get('/v1/owner/nodes', async (c) => {
    await owner(c);
    const nodes = await db.selectFrom('managed_nodes').selectAll().execute();
    return c.json(
      nodes.map((node) => ({
        ...node,
        effectiveBackendAllocationPool: effectiveBackendAllocationPool(node, env),
        backendAllocationPoolLocked: Object.hasOwn(backendAllocationPoolOverrides(env), node.id),
        effectiveMemoryOverheadPercent: effectiveNodeOverhead(node, env),
        memoryOverheadLocked: env.NH_NODE_MEMORY_OVERHEAD_PERCENT !== undefined,
      })),
    );
  });
  app.put('/v1/owner/nodes', async (c) => {
    const context = await owner(c);
    return c.json(
      await setManagedNode(db, (await management()).adapter, context, await body(c), env),
    );
  });
  app.get('/v1/owner/runtime-mappings', async (c) => {
    await owner(c);
    return c.json(await db.selectFrom('runtime_egg_mappings').selectAll().execute());
  });
  app.put('/v1/owner/runtime-mappings', async (c) => {
    const context = await owner(c);
    return c.json(
      await setRuntimeMapping(db, (await management()).adapter, context, await body(c)),
    );
  });
  app.put('/v1/owner/user-limits', async (c) => {
    await setUserLimits(db, await owner(c), await body(c));
    return c.body(null, 204);
  });
  app.post('/v1/owner/reconcile', async (c) => {
    await owner(c);
    parse(z.object({}).strict(), await body(c));
    return c.json(await (await management()).reconcile());
  });
  app.get('/v1/projects', async (c) => {
    const context = await principal(c);
    const rows = await db.selectFrom('projects').selectAll().execute();
    const members = await db
      .selectFrom('project_members')
      .select('project_id')
      .where('user_id', '=', context.subjectUserId)
      .execute();
    return c.json(
      rows.filter(
        (p) =>
          p.owner_id === context.subjectUserId ||
          context.role === 'owner' ||
          members.some((m) => m.project_id === p.id),
      ),
    );
  });
  app.post('/v1/projects', async (c) =>
    c.json(await createProject(db, await principal(c), await body(c)), 201),
  );
  app.put('/v1/projects/:id/members', async (c) => {
    await setProjectMember(db, await principal(c), c.req.param('id'), await body(c));
    return c.body(null, 204);
  });
  app.get('/v1/servers', async (c) => c.json(await listServers(db, await principal(c))));
  app.post('/v1/servers', async (c) => {
    const context = await principal(c),
      service = await management();
    await service.refreshObservations();
    return c.json(await createManagedServer(db, service.adapter, context, await body(c), env), 202);
  });
  app.get('/v1/servers/:id', async (c) => {
    const server = await authorizeServer(db, await principal(c), c.req.param('id'));
    const ports = await db
      .selectFrom('server_allocations')
      .select(['role', 'port', 'protocols', 'is_primary'])
      .where('server_id', '=', server.id)
      .execute();
    return c.json({ ...publicServer(server), ports });
  });
  app.post('/v1/servers/:id/operations', async (c) => {
    const context = await principal(c);
    const input = await body(c);
    await authorizeServer(db, context, c.req.param('id'), 'server:operate');
    await (await management()).refreshObservations();
    return c.json(await enqueueServerOperation(db, context, c.req.param('id'), input, env), 202);
  });
  app.post('/v1/owner/servers/:id/resolve', async (c) => {
    const context = await owner(c),
      service = await management();
    return c.json(
      await resolveUncertainOperation(
        db,
        service.adapter,
        context,
        c.req.param('id'),
        await body(c),
        env,
      ),
    );
  });
  app.get('/v1/servers/:id/operations', async (c) => {
    const server = await authorizeServer(db, await principal(c), c.req.param('id'));
    const rows = await db
      .selectFrom('server_operations as s')
      .innerJoin('operation_jobs as j', 'j.id', 's.job_id')
      .select([
        'j.id',
        's.action',
        's.phase',
        's.effect_state',
        'j.state',
        'j.error_code',
        'j.attempts',
        'j.created_at',
        'j.updated_at',
        'j.completed_at',
      ])
      .where('s.server_id', '=', server.id)
      .orderBy('j.created_at', 'desc')
      .limit(100)
      .execute();
    return c.json(rows.map((row) => ({ ...row, messageKey: `jobs.${row.state}` })));
  });
  app.get('/v1/servers/:id/events', async (c) => {
    const server = await authorizeServer(db, await principal(c), c.req.param('id'));
    const after = parse(z.string().regex(/^\d{1,18}$/), c.req.query('after') ?? '0');
    return c.json(
      await db
        .selectFrom('server_events')
        .selectAll()
        .where('server_id', '=', server.id)
        .where('id', '>', after)
        .orderBy('id')
        .limit(200)
        .execute(),
    );
  });
  app.get('/v1/servers/:id/events/stream', async (c) => {
    const server = await authorizeServer(db, await principal(c), c.req.param('id'));
    let after = parse(z.string().regex(/^\d{1,18}$/), c.req.query('after') ?? '0');
    return streamSSE(c, async (stream) => {
      const end = Date.now() + 900000;
      while (!stream.aborted && Date.now() < end) {
        try {
          await authorizeServer(db, await principal(c), server.id);
        } catch {
          return;
        }
        const events = await db
          .selectFrom('server_events')
          .selectAll()
          .where('server_id', '=', server.id)
          .where('id', '>', after)
          .orderBy('id')
          .limit(100)
          .execute();
        for (const event of events) {
          await stream.writeSSE({ id: event.id, event: 'activity', data: JSON.stringify(event) });
          after = event.id;
        }
        await stream.sleep(2000);
      }
    });
  });
  app.get('/v1/servers/:id/metrics', async (c) => {
    const server = await authorizeServer(db, await principal(c), c.req.param('id'));
    return c.json(
      await db
        .selectFrom('server_metrics')
        .selectAll()
        .where('server_id', '=', server.id)
        .orderBy('observed_at', 'desc')
        .limit(500)
        .execute(),
    );
  });
  app.get('/v1/servers/:id/resources', async (c) => {
    const context = await principal(c),
      service = await management();
    return c.json(
      await service.access(context, c.req.param('id'), false, (id) =>
        service.adapter.getResources(id),
      ),
    );
  });
  app.get('/v1/servers/:id/files', async (c) => {
    const context = await principal(c),
      service = await management();
    return c.json(
      await service.access(context, c.req.param('id'), false, (id) =>
        service.adapter.listFiles(id, c.req.query('path') ?? ''),
      ),
    );
  });
  app.get('/v1/servers/:id/files/content', async (c) => {
    const context = await principal(c),
      service = await management();
    const serverId = c.req.param('id');
    const id = await service.access(context, serverId, false, async (identifier) => identifier);
    const download = await service.adapter.downloadFile(id, c.req.query('path') ?? '', {
      signal: c.req.raw.signal,
      authorize: () => service.authorizeTransfer(context, serverId, false),
    });
    return new Response(download.body, {
      headers: {
        'content-type': download.contentType,
        ...(download.contentLength === undefined
          ? {}
          : { 'content-length': String(download.contentLength) }),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-disposition': 'attachment',
      },
    });
  });
  app.put('/v1/servers/:id/files/upload', async (c) => {
    const context = await principal(c),
      service = await management();
    const declared = c.req.header('x-nh-upload-length');
    const rawLength = c.req.header('content-length');
    if (
      c.req.header('content-type') !== 'application/octet-stream' ||
      (c.req.header('content-encoding') && c.req.header('content-encoding') !== 'identity') ||
      declared === undefined ||
      !/^\d+$/.test(declared) ||
      !Number.isSafeInteger(Number(declared)) ||
      (rawLength !== undefined &&
        (!/^\d+$/.test(rawLength) || Number(rawLength) !== Number(declared)))
    )
      throw new DomainError('validation_failed');
    const contentLength = Number(declared);
    const path = c.req.query('path') ?? '';
    relativePath(path);
    const slash = path.lastIndexOf('/');
    const directory = slash === -1 ? '' : path.slice(0, slash);
    const name = path.slice(slash + 1);
    const serverId = c.req.param('id');
    const release = options.acquireUploadSlot();
    try {
      await service.access(context, serverId, true, async (id, connection, current) => {
        await service.assertFileMutation(serverId, [path], connection);
        const server = await authorizeServer(connection, current, serverId, 'server:manage');
        const maxBytes = server.limits.disk * 1024 * 1024;
        if (!Number.isSafeInteger(maxBytes) || contentLength > maxBytes)
          throw new DomainError('validation_failed', 413);
        const [resources, files] = await Promise.all([
          service.adapter.getResources(id),
          service.adapter.listFiles(id, directory),
        ]);
        const existing = files.find((file) => file.name === name);
        if (existing && (!existing.is_file || existing.is_symlink))
          throw new DomainError('conflict');
        // Native Wings filesystem quotas remain authoritative against concurrent
        // game/provider writes. This conservative preflight never invents storage.
        if (resources.resources.disk_bytes - (existing?.size ?? 0) + contentLength > maxBytes)
          throw new DomainError('validation_failed', 413);
        await service.authorizeTransfer(current, serverId, true, connection);
        await recordAudit(connection, current, 'server.files.requested', {
          serverId,
          action: 'upload',
          bytes: contentLength,
        });
        const claim = await reserveUploadIngestion(
          connection,
          current,
          serverId,
          contentLength,
          env,
        );
        try {
          await service.adapter.uploadFile(id, path, {
            body:
              c.req.raw.body ??
              new ReadableStream({
                start(controller) {
                  controller.close();
                },
              }),
            contentLength,
            maxBytes,
            signal: c.req.raw.signal,
            authorize: () => service.authorizeTransfer(current, serverId, true, connection),
          });
          await claim.complete();
        } finally {
          await claim.unlock();
        }
        await recordAudit(connection, current, 'server.files.uploaded', {
          serverId,
          bytes: contentLength,
        });
      });
    } finally {
      release();
    }
    return c.body(null, 204);
  });
  app.post('/v1/servers/:id/files', async (c) => {
    const context = await principal(c),
      service = await management();
    const input = parse(
      z.discriminatedUnion('action', [
        z
          .object({ action: z.literal('write'), path: z.string(), content: z.string().max(60000) })
          .strict(),
        z.object({ action: z.literal('mkdir'), root: z.string(), name: z.string() }).strict(),
        z
          .object({
            action: z.literal('delete'),
            root: z.string(),
            files: z.array(z.string()).min(1).max(100),
            confirm: z.literal(true),
          })
          .strict(),
        z
          .object({
            action: z.literal('rename'),
            root: z.string(),
            files: z
              .array(z.object({ from: z.string(), to: z.string() }).strict())
              .min(1)
              .max(100),
          })
          .strict(),
      ]),
      await body(c),
    );
    await service.access(context, c.req.param('id'), true, async (id, connection, current) => {
      const paths: string[] = [];
      if (input.action === 'write') {
        relativePath(input.path);
        paths.push(input.path);
      } else {
        relativePath(input.root, true);
        const names =
          input.action === 'mkdir'
            ? [input.name]
            : input.action === 'delete'
              ? input.files
              : input.files.flatMap((file) => [file.from, file.to]);
        for (const name of names) {
          relativePath(name);
          paths.push([input.root, name].filter(Boolean).join('/'));
        }
      }
      await service.assertFileMutation(c.req.param('id'), paths, connection);
      await recordAudit(connection, current, 'server.files.requested', {
        serverId: c.req.param('id'),
        action: input.action,
      });
      if (input.action === 'write') await service.adapter.writeFile(id, input.path, input.content);
      else if (input.action === 'mkdir')
        await service.adapter.createDirectory(id, input.root, input.name);
      else if (input.action === 'delete')
        await service.adapter.deleteFiles(id, input.root, input.files);
      else await service.adapter.renameFiles(id, input.root, input.files);
    });
    return c.body(null, 204);
  });
  app.get('/v1/servers/:id/backups', async (c) => {
    const context = await principal(c),
      service = await management();
    return c.json(
      await service.access(context, c.req.param('id'), false, (id) =>
        service.adapter.listBackups(id),
      ),
    );
  });
  app.delete('/v1/servers/:id/backups/:backupId', async (c) => {
    const context = await principal(c),
      service = await management();
    parse(z.object({ confirm: z.literal(true) }).strict(), await body(c));
    await service.access(context, c.req.param('id'), true, async (id, connection, current) => {
      await recordAudit(connection, current, 'server.backup.delete_requested', {
        serverId: c.req.param('id'),
        backupId: c.req.param('backupId'),
      });
      await service.adapter.deleteBackup(id, c.req.param('backupId'));
    });
    return c.body(null, 204);
  });
  app.get('/v1/servers/:id/backups/:backupId/download', async (c) => {
    const context = await principal(c),
      service = await management();
    const serverId = c.req.param('id');
    const id = await service.access(context, serverId, false, async (identifier) => identifier);
    const download = await service.adapter.downloadBackup(id, c.req.param('backupId'), {
      signal: c.req.raw.signal,
      authorize: () => service.authorizeTransfer(context, serverId, false),
    });
    return new Response(download.body, {
      headers: {
        'content-type': download.contentType,
        ...(download.contentLength === undefined
          ? {}
          : { 'content-length': String(download.contentLength) }),
        'cache-control': 'no-store',
        'content-disposition': 'attachment',
        'x-content-type-options': 'nosniff',
      },
    });
  });
  app.post('/v1/servers/:id/console', async (c) => {
    const context = await principal(c),
      service = await management();
    const input = parse(z.object({ command: z.string().min(1).max(4096) }).strict(), await body(c));
    await service.access(context, c.req.param('id'), true, async (id, connection, current) => {
      await recordAudit(connection, current, 'server.console.command', {
        serverId: c.req.param('id'),
      });
      await service.adapter.sendCommand(id, input.command);
    });
    return c.body(null, 204);
  });
  app.get('/v1/servers/:id/console', async (c) => {
    const context = await principal(c),
      service = await management();
    const identifier = await service.access(context, c.req.param('id'), false, async (id) => id);
    return streamSSE(c, async (stream) => {
      let done!: () => void;
      const closed = new Promise<void>((resolve) => {
        done = resolve;
      });
      const controller = new AbortController();
      stream.onAbort(() => {
        controller.abort();
        done();
      });
      const output = boundedEventWriter(
        (event) => stream.writeSSE(event),
        () => {
          controller.abort();
          stream.abort();
          done();
        },
      );
      try {
        const relay = await service.adapter.relayConsole(identifier, {
          signal: controller.signal,
          authorize: async () => {
            try {
              await authorizeServer(db, await principal(c), c.req.param('id'));
              return true;
            } catch {
              return false;
            }
          },
          onEvent: (event) => {
            output.send({ event: event.type, data: JSON.stringify(event) });
            if (event.type === 'closed') void output.drain().then(done);
          },
        });
        try {
          await closed;
        } finally {
          relay.close();
        }
      } catch {
        // No upstream exception details or credentials in an already-open stream.
        output.send({ event: 'error', data: JSON.stringify({ code: 'integration_unavailable' }) });
        await output.drain();
      } finally {
        output.close();
        controller.abort();
      }
    });
  });
  app.get('/v1/servers/:id/sftp', async (c) =>
    c.json(await listSftpCredentials(db, await principal(c), c.req.param('id'))),
  );
  app.post('/v1/servers/:id/sftp', async (c) => {
    const context = await principal(c, true),
      service = await management();
    return c.json(
      await createSftpCredential(
        db,
        context,
        c.req.param('id'),
        await body(c),
        service.externalOptions,
      ),
      201,
    );
  });
  app.post('/v1/servers/:id/sftp/:credentialId/rotate', async (c) => {
    const context = await principal(c, true),
      service = await management();
    return c.json(
      await rotateSftpCredential(
        db,
        context,
        c.req.param('id'),
        c.req.param('credentialId'),
        await body(c),
        service.externalOptions,
      ),
    );
  });
  app.delete('/v1/servers/:id/sftp/:credentialId', async (c) => {
    const context = await principal(c),
      service = await management();
    parse(z.object({}).strict(), await body(c));
    return c.json(
      await revokeSftpCredential(
        db,
        context,
        c.req.param('id'),
        c.req.param('credentialId'),
        service.externalOptions,
      ),
    );
  });
  app.get('/v1/servers/:id/dns', async (c) =>
    c.json(await listServerDns(db, await principal(c), c.req.param('id'))),
  );
  app.post('/v1/servers/:id/dns/preview', async (c) => {
    const context = await principal(c),
      service = await management();
    return c.json(
      await previewServerDns(
        db,
        context,
        c.req.param('id'),
        await body(c),
        service.externalOptions,
      ),
    );
  });
  app.post('/v1/servers/:id/dns', async (c) => {
    const context = await principal(c, true),
      service = await management();
    return c.json(
      await assignServerDns(db, context, c.req.param('id'), await body(c), service.externalOptions),
      201,
    );
  });
  app.put('/v1/servers/:id/dns/:assignmentId', async (c) => {
    const context = await principal(c, true),
      service = await management();
    return c.json(
      await updateServerDns(
        db,
        context,
        c.req.param('id'),
        c.req.param('assignmentId'),
        await body(c),
        service.externalOptions,
      ),
    );
  });
  app.delete('/v1/servers/:id/dns/:assignmentId', async (c) => {
    const context = await principal(c),
      service = await management();
    parse(z.object({ confirm: z.literal(true) }).strict(), await body(c));
    return c.json(
      await deleteServerDns(
        db,
        context,
        c.req.param('id'),
        c.req.param('assignmentId'),
        service.externalOptions,
      ),
    );
  });
}
