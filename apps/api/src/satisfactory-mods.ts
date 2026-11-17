import { createHash, randomUUID } from 'node:crypto';
import { DomainError } from '@nickhosting/core';
import { authorizeServer, enqueueServerOperation } from '@nickhosting/server-management';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
  satisfactoryModLockSchema,
  satisfactoryModSelectionSchema,
  satisfiesSatisfactoryModVersion,
} from '../../../games/satisfactory/src/mods.js';
import {
  satisfactoryModCompatibility,
  satisfactoryModDetails,
  satisfactoryModRecommendations,
  satisfactoryModSearchSchema,
  satisfactoryModVersions,
  searchSatisfactoryMods,
} from '../../../games/satisfactory/src/mods-catalog.js';
import { resolveSatisfactoryModLimits } from '../../../games/satisfactory/src/mods-limits.js';
import {
  exportSatisfactoryProfile,
  importSatisfactoryProfile,
} from '../../../games/satisfactory/src/mods-profile.js';
import { lockResources } from '../../../packages/server-management/src/admission.js';
import { currentInteractiveContext } from '../../../packages/server-management/src/interactive-context.js';
import {
  enqueueLockedServerOperation,
  replaySatisfactoryContentOperation,
} from '../../../packages/server-management/src/registry.js';
import {
  emptySatisfactoryLock,
  ensureSatisfactoryModState,
  inspectSatisfactoryModInventory,
  readSatisfactoryGameBuild,
  reconcileSatisfactoryMods,
  sameSatisfactorySelection,
} from '../../../packages/server-management/src/satisfactory-mod-manager.js';
import type { Variables } from './app.js';
import { registerSatisfactoryModExternalRoutes } from './satisfactory-mod-external.js';
import type { ServerRouteOptions } from './servers.js';

const key = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const revision = z.number().int().nonnegative();
const profileInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  selection: satisfactoryModSelectionSchema,
  vanilla: z.boolean().default(false),
  revision,
  idempotencyKey: key.optional(),
  requiredTargets: z
    .array(z.enum(['LinuxServer', 'Windows', 'WindowsServer']))
    .max(3)
    .optional(),
});
function deterministicId(value: string) {
  const h = createHash('sha256').update(value).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function registerSatisfactoryModRoutes(
  app: Hono<{ Variables: Variables }>,
  options: Pick<ServerRouteOptions, 'db' | 'principal' | 'env' | 'management'>,
) {
  const base = '/v1/servers/:id/satisfactory/mods';
  registerSatisfactoryModExternalRoutes(app, options);
  async function access(
    context: Awaited<ReturnType<typeof options.principal>>,
    id: string,
    manage = false,
  ) {
    const server = await authorizeServer(
      options.db,
      context,
      id,
      manage ? 'server:manage' : 'server:read',
    );
    const mapping = await options.db
      .selectFrom('runtime_egg_mappings')
      .select('game_id')
      .where('id', '=', server.mapping_id)
      .executeTakeFirst();
    if (mapping?.game_id !== 'satisfactory') throw new DomainError('not_found');
    return server;
  }

  async function withFiles<T>(
    actor: Awaited<ReturnType<typeof options.principal>>,
    id: string,
    work: (
      service: Awaited<ReturnType<typeof options.management>>,
      server: Awaited<ReturnType<typeof access>>,
      authorize: () => Promise<void>,
      connection: typeof options.db,
    ) => Promise<T>,
  ) {
    const service = await options.management();
    return service.access(actor, id, false, async (_identifier, connection, current, server) =>
      work(
        service,
        server,
        async () => {
          await service.authorizeTransfer(current, id, false, connection, undefined, server);
        },
        connection,
      ),
    );
  }
  const builds = new WeakMap<object, Map<string, ReturnType<typeof readSatisfactoryGameBuild>>>();
  async function gameBuild(actor: Awaited<ReturnType<typeof options.principal>>, id: string) {
    return withFiles(actor, id, async (service, server, authorize) => {
      await authorize();
      const identifier = server.pterodactyl_identifier!;
      let pending = builds.get(service.adapter);
      if (!pending) {
        pending = new Map();
        builds.set(service.adapter, pending);
      }
      const binding = `${server.id}:${server.pterodactyl_uuid}:${identifier}`;
      let read = pending.get(binding);
      if (!read) {
        read = readSatisfactoryGameBuild(service.adapter, identifier);
        if (pending.size < 128) {
          pending.set(binding, read);
          const current = read;
          void read
            .finally(() => {
              if (pending.get(binding) === current) pending.delete(binding);
            })
            .catch(() => {});
        }
      }
      const build = await read;
      await authorize();
      return build;
    });
  }
  app.get(base, async (c) => {
    c.header('cache-control', 'no-store');
    const server = await access(await options.principal(c), c.req.param('id'));
    const row = await options.db
      .selectFrom('satisfactory_mod_states')
      .selectAll()
      .where('server_id', '=', c.req.param('id'))
      .executeTakeFirst();
    const profiles = await options.db
      .selectFrom('satisfactory_mod_profiles')
      .select(['id', 'name', 'selection', 'vanilla', 'required_targets'])
      .where('server_id', '=', c.req.param('id'))
      .orderBy('name')
      .execute();
    const activePreview = server.active_operation_id
      ? await options.db
          .selectFrom('server_operations as operation')
          .innerJoin('operation_jobs as job', 'job.id', 'operation.job_id')
          .select(['operation.action', 'operation.plan', 'job.state'])
          .where('operation.job_id', '=', server.active_operation_id)
          .where('operation.server_id', '=', server.id)
          .executeTakeFirst()
      : undefined;
    const activeCommand = activePreview?.plan.satisfactoryContent as
      | { kind?: string; mode?: string }
      | undefined;
    return c.json({
      activePreviewJobId:
        activePreview?.action === 'satisfactory-content' &&
        ['queued', 'running'].includes(activePreview.state) &&
        activeCommand?.kind === 'mods' &&
        activeCommand.mode === 'preview'
          ? server.active_operation_id
          : null,
      selection: row?.selection ?? [],
      lock: row?.lock ?? emptySatisfactoryLock,
      revision: row?.revision ?? 0,
      vanilla: row?.vanilla ?? false,
      activeProfileId: row?.active_profile_id ?? null,
      externalMode: row?.external_mode ?? false,
      inventoryFingerprint: row?.inventory_fingerprint ?? null,
      rollbackAvailable: !!row?.recovery && !(row.recovery as { obsolete?: boolean }).obsolete,
      profiles: profiles.map((profile) => ({
        ...profile,
        requiredTargets: profile.required_targets,
      })),
    });
  });
  app.get(`${base}/inventory`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id'),
      server = await access(actor, id);
    await authorizeServer(options.db, actor, id, 'files.read');
    return c.json(
      await withFiles(actor, id, (service, verified, authorize, connection) =>
        inspectSatisfactoryModInventory(connection, service.adapter, verified, authorize, {
          limits: resolveSatisfactoryModLimits(options.env),
        }),
      ),
    );
  });
  app.get(`${base}/catalog`, async (c) => {
    await access(await options.principal(c), c.req.param('id'));
    const input = z
      .object({
        query: satisfactoryModSearchSchema.default(''),
        offset: z.coerce.number().int().min(0).max(100000).default(0),
      })
      .safeParse(c.req.query());
    if (!input.success) throw new DomainError('validation_failed');
    try {
      return c.json(await searchSatisfactoryMods(input.data));
    } catch {
      throw new DomainError('integration_unavailable');
    }
  });
  app.get(`${base}/versions/:reference`, async (c) => {
    c.header('cache-control', 'no-store');
    const actor = await options.principal(c),
      id = c.req.param('id');
    await access(actor, id);
    try {
      const [build, versions] = await Promise.allSettled([
        gameBuild(actor, id),
        c.req.query('recommendation') === 'true'
          ? satisfactoryModRecommendations(c.req.param('reference'))
          : satisfactoryModVersions(c.req.param('reference')),
      ]);
      if (build.status === 'rejected') throw build.reason;
      if (versions.status === 'rejected') throw versions.reason;
      return c.json(
        versions.value.map((version) => ({
          ...version,
          compatibility: version.targets.includes('LinuxServer')
            ? satisfactoryModCompatibility(version.gameVersion, build.value ?? undefined)
            : 'incompatible',
        })),
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('integration_unavailable');
    }
  });
  app.get(`${base}/catalog/:reference`, async (c) => {
    await access(await options.principal(c), c.req.param('id'));
    try {
      const result = await satisfactoryModDetails(c.req.param('reference'));
      if (!result) throw new DomainError('not_found');
      return c.json(result);
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('integration_unavailable');
    }
  });
  app.get(`${base}/updates`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id'),
      server = await access(actor, id);
    const state = await ensureSatisfactoryModState(options.db, id);
    const selection = satisfactoryModSelectionSchema.parse(state.selection),
      lock = satisfactoryModLockSchema.parse(state.lock);
    const build = await gameBuild(actor, id);
    if (!build) throw new DomainError('configuration_invalid');
    const { latestSatisfactoryModVersion } = await import(
      '../../../games/satisfactory/src/mods-catalog.js'
    );
    const items: { reference: string; currentVersion: string; version: string }[] = [];
    const deadline = AbortSignal.timeout(30000);
    let cursor = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, selection.length) }, async () => {
          while (cursor < selection.length) {
            const mod = selection[cursor++]!;
            const currentVersion = lock.mods[mod.reference]?.version;
            if (!currentVersion) continue;
            const candidate = latestSatisfactoryModVersion(
              await satisfactoryModVersions(mod.reference, deadline, {
                gameBuild: build ?? undefined,
              }),
            );
            if (
              candidate &&
              satisfiesSatisfactoryModVersion(candidate.version, `>${currentVersion}`)
            )
              items.push({ reference: mod.reference, currentVersion, version: candidate.version });
          }
        }),
      );
    } catch {
      throw new DomainError('integration_unavailable');
    }
    items.sort((a, b) => a.reference.localeCompare(b.reference));
    return c.json({ items });
  });
  app.post(`${base}/preview`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id')!;
    await access(actor, id, true);
    const input = z
      .strictObject({
        selection: satisfactoryModSelectionSchema,
        vanilla: z.boolean().default(false),
        revision,
        profileId: z.uuid().optional(),
        idempotencyKey: key,
        refreshMetadata: z.boolean().default(false),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    const value = input.data,
      planId = deterministicId(`${id}:${actor.actorUserId}:${value.idempotencyKey}`);
    const replay = await replaySatisfactoryContentOperation(
      options.db,
      actor,
      id,
      {
        action: 'satisfactory-content',
        idempotencyKey: value.idempotencyKey,
        command: {
          kind: 'mods',
          mode: 'preview',
          ...(value.refreshMetadata ? { refreshMetadata: true } : {}),
          selection: value.selection,
          vanilla: value.vanilla,
          revision: value.revision,
          planId,
          profileId: value.profileId,
        },
      },
      options.env,
    );
    if (replay) {
      if (
        !(await options.db
          .selectFrom('satisfactory_mod_plans')
          .select('id')
          .where('id', '=', planId)
          .where('server_id', '=', id)
          .executeTakeFirst())
      )
        throw new DomainError('conflict');
      return c.json({ planId, jobId: replay.jobId }, 202);
    }
    await ensureSatisfactoryModState(options.db, id);
    const result = await options.db.transaction().execute(async (tx) => {
      await lockResources(tx);
      const current = await currentInteractiveContext(tx, actor, options.env);
      await authorizeServer(tx, current, id, 'server:manage');
      const existing = await tx
        .selectFrom('satisfactory_mod_plans')
        .selectAll()
        .where('id', '=', planId)
        .executeTakeFirst();
      if (
        existing &&
        (existing.revision !== value.revision ||
          !sameSatisfactorySelection(existing.selection, value.selection) ||
          existing.vanilla !== value.vanilla ||
          existing.profile_id !== (value.profileId ?? null))
      )
        throw new DomainError('conflict');
      if (existing?.job_id) return { planId, jobId: existing.job_id };
      const state = await tx
        .selectFrom('satisfactory_mod_states')
        .selectAll()
        .where('server_id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (state.revision !== value.revision || state.external_mode)
        throw new DomainError('conflict');
      if (
        value.profileId &&
        !(await tx
          .selectFrom('satisfactory_mod_profiles')
          .select('id')
          .where('id', '=', value.profileId)
          .where('server_id', '=', id)
          .executeTakeFirst())
      )
        throw new DomainError('not_found');
      await tx
        .insertInto('satisfactory_mod_plans')
        .values({
          id: planId,
          server_id: id,
          job_id: null,
          revision: value.revision,
          selection: JSON.stringify(value.selection),
          vanilla: value.vanilla,
          profile_id: value.profileId ?? null,
          lock: null,
          files: null,
          changes: null,
          inventory_fingerprint: null,
          game_version: null,
        })
        .onConflict((oc) => oc.column('id').doNothing())
        .execute();
      const job = await enqueueLockedServerOperation(
        tx,
        current,
        id,
        {
          action: 'satisfactory-content',
          idempotencyKey: value.idempotencyKey,
          command: {
            kind: 'mods',
            mode: 'preview',
            ...(value.refreshMetadata ? { refreshMetadata: true } : {}),
            selection: value.selection,
            vanilla: value.vanilla,
            revision: value.revision,
            planId,
            profileId: value.profileId,
          },
        },
        options.env,
        undefined,
        { satisfactoryContent: true },
      );
      await tx
        .updateTable('satisfactory_mod_plans')
        .set({ job_id: job.jobId })
        .where('id', '=', planId)
        .execute();
      return { planId, jobId: job.jobId };
    });
    return c.json(result, 202);
  });
  app.get(`${base}/plans/:planId`, async (c) => {
    await access(await options.principal(c), c.req.param('id'));
    const plan = await options.db
      .selectFrom('satisfactory_mod_plans')
      .selectAll()
      .where('id', '=', c.req.param('planId'))
      .where('server_id', '=', c.req.param('id'))
      .executeTakeFirst();
    if (!plan) throw new DomainError('not_found');
    const job = plan.job_id
      ? await options.db
          .selectFrom('operation_jobs')
          .select(['state', 'error_code'])
          .where('id', '=', plan.job_id)
          .executeTakeFirst()
      : null;
    const operation = plan.job_id
      ? await options.db
          .selectFrom('server_operations')
          .select('plan')
          .where('job_id', '=', plan.job_id)
          .executeTakeFirst()
      : undefined;
    const status =
      plan.status !== 'applied' && job && ['failed', 'cancelled', 'uncertain'].includes(job.state)
        ? 'failed'
        : plan.status === 'ready' && job?.state !== 'succeeded'
          ? 'pending'
          : plan.status;
    const phase = operation?.plan.satisfactoryPreviewPhase;
    return c.json({
      id: plan.id,
      expiresAt: plan.expires_at.toISOString(),
      status,
      phase:
        status === 'ready' || status === 'applied'
          ? 'ready'
          : status === 'failed'
            ? 'failed'
            : phase === 'preparing' || phase === 'inventory'
              ? phase
              : 'queued',
      revision: plan.revision,
      selection: plan.selection,
      vanilla: plan.vanilla,
      lock: plan.lock,
      changes: plan.changes ?? [],
      filesBytes: Array.isArray(plan.files)
        ? plan.files.reduce((sum: number, file: { size: number }) => sum + file.size, 0)
        : 0,
      errorCode: job?.error_code ?? undefined,
    });
  });
  app.post(`${base}/apply`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id')!;
    await access(actor, id, true);
    const input = z
      .strictObject({ planId: z.uuid(), revision, idempotencyKey: key })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    const command = {
      action: 'satisfactory-content' as const,
      idempotencyKey: input.data.idempotencyKey,
      command: {
        kind: 'mods',
        mode: 'apply',
        planId: input.data.planId,
        revision: input.data.revision,
      },
    };
    const replay = await replaySatisfactoryContentOperation(
      options.db,
      actor,
      id,
      command,
      options.env,
    );
    if (replay) return c.json(replay, 202);
    const plan = await options.db
      .selectFrom('satisfactory_mod_plans')
      .selectAll()
      .where('id', '=', input.data.planId)
      .where('server_id', '=', id)
      .executeTakeFirst();
    if (
      !plan ||
      plan.status !== 'ready' ||
      plan.revision !== input.data.revision ||
      plan.expires_at.getTime() < Date.now()
    )
      throw new DomainError('conflict');
    return c.json(
      await enqueueServerOperation(options.db, actor, id, command, options.env, {
        satisfactoryContent: true,
      }),
      202,
    );
  });
  app.post(`${base}/rollback`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id')!;
    await access(actor, id, true);
    const input = z
      .strictObject({ revision, idempotencyKey: key })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    const command = {
      action: 'satisfactory-content' as const,
      idempotencyKey: input.data.idempotencyKey,
      command: { kind: 'mods', mode: 'rollback', revision: input.data.revision },
    };
    const replay = await replaySatisfactoryContentOperation(
      options.db,
      actor,
      id,
      command,
      options.env,
    );
    if (replay) return c.json(replay, 202);
    const state = await ensureSatisfactoryModState(options.db, id);
    if (
      !state.recovery ||
      (state.recovery as { obsolete?: boolean }).obsolete ||
      state.revision !== input.data.revision ||
      state.external_mode
    )
      throw new DomainError('conflict');
    return c.json(
      await enqueueServerOperation(options.db, actor, id, command, options.env, {
        satisfactoryContent: true,
      }),
      202,
    );
  });
  const saveProfile = async (c: Context<{ Variables: Variables }>, profileId?: string) => {
    const actor = await options.principal(c),
      id = c.req.param('id')!;
    await access(actor, id, true);
    const parsed = profileInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new DomainError('validation_failed');
    const value = parsed.data;
    const profile =
      profileId ??
      (value.idempotencyKey
        ? deterministicId(`profile:${id}:${value.idempotencyKey}`)
        : randomUUID());
    await ensureSatisfactoryModState(options.db, id);
    await options.db.transaction().execute(async (tx) => {
      await lockResources(tx);
      const current = await currentInteractiveContext(tx, actor, options.env);
      const server = await authorizeServer(tx, current, id, 'server:manage');
      if (server.active_operation_id) throw new DomainError('conflict');
      const existing = await tx
        .selectFrom('satisfactory_mod_profiles')
        .selectAll()
        .where('id', '=', profile)
        .where('server_id', '=', id)
        .executeTakeFirst();
      const targets = [...new Set(['LinuxServer', ...(value.requiredTargets ?? [])])];
      if (
        existing &&
        existing.name === value.name &&
        sameSatisfactorySelection(existing.selection, value.selection) &&
        existing.vanilla === value.vanilla &&
        JSON.stringify(existing.required_targets) === JSON.stringify(targets)
      )
        return;
      if (existing && !profileId) throw new DomainError('conflict');
      const state = await tx
        .selectFrom('satisfactory_mod_states')
        .selectAll()
        .where('server_id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (state.revision !== value.revision) throw new DomainError('conflict');
      const duplicate = await tx
        .selectFrom('satisfactory_mod_profiles')
        .select('id')
        .where('server_id', '=', id)
        .where('name', '=', value.name)
        .where('id', '!=', profile)
        .executeTakeFirst();
      if (duplicate) throw new DomainError('conflict');
      if (profileId) {
        const result = await tx
          .updateTable('satisfactory_mod_profiles')
          .set({
            name: value.name,
            selection: JSON.stringify(value.selection),
            vanilla: value.vanilla,
            required_targets: JSON.stringify([
              ...new Set(['LinuxServer', ...(value.requiredTargets ?? [])]),
            ]),
            updated_at: new Date(),
          })
          .where('id', '=', profile)
          .where('server_id', '=', id)
          .executeTakeFirst();
        if (!result.numUpdatedRows) throw new DomainError('not_found');
      } else
        await tx
          .insertInto('satisfactory_mod_profiles')
          .values({
            id: profile,
            server_id: id,
            name: value.name,
            selection: JSON.stringify(value.selection),
            vanilla: value.vanilla,
            required_targets: JSON.stringify([
              ...new Set(['LinuxServer', ...(value.requiredTargets ?? [])]),
            ]),
          })
          .execute();
      await tx
        .updateTable('satisfactory_mod_states')
        .set({ revision: state.revision + 1 })
        .where('server_id', '=', id)
        .execute();
    });
    return c.json({
      id: profile,
      name: value.name,
      selection: value.selection,
      vanilla: value.vanilla,
      requiredTargets: [...new Set(['LinuxServer', ...(value.requiredTargets ?? [])])],
    });
  };
  app.post(`${base}/profiles`, (c) => saveProfile(c));
  app.put(`${base}/profiles/:profileId`, (c) => saveProfile(c, c.req.param('profileId')));
  app.delete(`${base}/profiles/:profileId`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id')!;
    await access(actor, id, true);
    const input = z.strictObject({ revision }).safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    await options.db.transaction().execute(async (tx) => {
      await lockResources(tx);
      const current = await currentInteractiveContext(tx, actor, options.env);
      const server = await authorizeServer(tx, current, id, 'server:manage');
      if (server.active_operation_id) throw new DomainError('conflict');
      const state = await tx
        .selectFrom('satisfactory_mod_states')
        .selectAll()
        .where('server_id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (state.revision !== input.data.revision) throw new DomainError('conflict');
      await tx
        .deleteFrom('satisfactory_mod_profiles')
        .where('server_id', '=', id)
        .where('id', '=', c.req.param('profileId'))
        .execute();
      await tx
        .updateTable('satisfactory_mod_states')
        .set({
          revision: state.revision + 1,
          ...(state.active_profile_id === c.req.param('profileId')
            ? { active_profile_id: null }
            : {}),
        })
        .where('server_id', '=', id)
        .execute();
    });
    return c.body(null, 204);
  });
  app.post(`${base}/profiles/import`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id')!;
    await access(actor, id, true);
    const input = z
      .strictObject({ document: z.unknown(), revision, idempotencyKey: key.optional() })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    let imported: ReturnType<typeof importSatisfactoryProfile>;
    try {
      imported = importSatisfactoryProfile(input.data.document);
    } catch {
      throw new DomainError('validation_failed');
    }
    const profileId = input.data.idempotencyKey
      ? deterministicId(`import:${id}:${input.data.idempotencyKey}`)
      : randomUUID();
    await ensureSatisfactoryModState(options.db, id);
    await options.db.transaction().execute(async (tx) => {
      await lockResources(tx);
      const current = await currentInteractiveContext(tx, actor, options.env);
      const server = await authorizeServer(tx, current, id, 'server:manage');
      if (server.active_operation_id) throw new DomainError('conflict');
      const existing = await tx
        .selectFrom('satisfactory_mod_profiles')
        .selectAll()
        .where('id', '=', profileId)
        .where('server_id', '=', id)
        .executeTakeFirst();
      if (existing) {
        if (
          existing.name !== imported.name ||
          !sameSatisfactorySelection(existing.selection, imported.selection) ||
          JSON.stringify(existing.required_targets) !==
            JSON.stringify([...new Set(['LinuxServer', ...imported.requiredTargets])])
        )
          throw new DomainError('conflict');
        return;
      }
      const state = await tx
        .selectFrom('satisfactory_mod_states')
        .selectAll()
        .where('server_id', '=', id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (state.revision !== input.data.revision) throw new DomainError('conflict');
      if (
        await tx
          .selectFrom('satisfactory_mod_profiles')
          .select('id')
          .where('server_id', '=', id)
          .where('name', '=', imported.name)
          .executeTakeFirst()
      )
        throw new DomainError('conflict');
      await tx
        .insertInto('satisfactory_mod_profiles')
        .values({
          id: profileId,
          server_id: id,
          name: imported.name,
          selection: JSON.stringify(imported.selection),
          vanilla: false,
          required_targets: JSON.stringify([
            ...new Set(['LinuxServer', ...imported.requiredTargets]),
          ]),
        })
        .execute();
      await tx
        .updateTable('satisfactory_mod_states')
        .set({ revision: state.revision + 1 })
        .where('server_id', '=', id)
        .execute();
    });
    return c.json({
      id: profileId,
      name: imported.name,
      selection: imported.selection,
      vanilla: false,
      requiredTargets: [...new Set(['LinuxServer', ...imported.requiredTargets])],
    });
  });
  app.get(`${base}/profiles/:profileId/export`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id'),
      server = await access(actor, id);
    const profile = await options.db
      .selectFrom('satisfactory_mod_profiles')
      .selectAll()
      .where('server_id', '=', id)
      .where('id', '=', c.req.param('profileId'))
      .executeTakeFirst();
    if (!profile) throw new DomainError('not_found');
    const build = await gameBuild(actor, id);
    if (!build) throw new DomainError('configuration_invalid');
    const candidates = await options.db
      .selectFrom('satisfactory_mod_plans as plan')
      .innerJoin('server_operations as operation', 'operation.job_id', 'plan.job_id')
      .select(['plan.selection', 'plan.vanilla', 'plan.lock', 'operation.plan as preparation'])
      .where('plan.server_id', '=', id)
      .where('plan.profile_id', '=', profile.id)
      .where('plan.game_version', '=', build)
      .where('plan.status', 'in', ['ready', 'applied'])
      .orderBy('plan.created_at', 'desc')
      .limit(20)
      .execute();
    const targets = z
      .array(z.enum(['LinuxServer', 'Windows', 'WindowsServer']))
      .parse(profile.required_targets)
      .sort();
    const trusted = candidates.find(
      (plan) =>
        plan.vanilla === profile.vanilla &&
        sameSatisfactorySelection(plan.selection, profile.selection) &&
        JSON.stringify(
          z
            .array(z.string())
            .parse(plan.preparation.satisfactoryModsRequiredTargets ?? ['LinuxServer'])
            .sort(),
        ) === JSON.stringify(targets),
    );
    return c.json(
      exportSatisfactoryProfile({
        name: profile.name,
        selection: satisfactoryModSelectionSchema.parse(profile.selection),
        requiredTargets: z
          .array(z.enum(['Windows', 'WindowsServer', 'LinuxServer']))
          .parse(profile.required_targets),
        gameVersion: build,
        lock: trusted?.lock ? satisfactoryModLockSchema.parse(trusted.lock) : emptySatisfactoryLock,
      }),
    );
  });
  app.post(`${base}/reconcile`, async (c) => {
    const actor = await options.principal(c),
      id = c.req.param('id'),
      server = await access(actor, id, true);
    const input = z
      .strictObject({
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        revision,
        selection: satisfactoryModSelectionSchema,
        profileId: z.uuid().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!input.success) throw new DomainError('validation_failed');
    return c.json(
      await withFiles(actor, id, (service, verified, authorize, connection) =>
        reconcileSatisfactoryMods(
          connection,
          service.adapter,
          verified,
          input.data,
          async () => {
            await authorize();
            await authorizeServer(
              connection,
              await currentInteractiveContext(connection, actor, options.env),
              id,
              'server:manage',
            );
          },
          { limits: resolveSatisfactoryModLimits(options.env) },
        ),
      ),
    );
  });
}
