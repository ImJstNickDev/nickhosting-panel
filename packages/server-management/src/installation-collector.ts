import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { Database } from '@nickhosting/database';
import type { PrivateTransferCache, PterodactylAdapter } from '@nickhosting/pterodactyl-adapter';
import type { Kysely } from 'kysely';
import { type InstallationTranscript, installationLogKey } from './provisioning.js';

/** One worker-owned stream per operation. Browsers read the shared transcript,
 * never mint their own privileged Wings socket. Redis leases also fence replicas. */
export function createInstallationCollector(options: {
  db: Kysely<Database>;
  cache: PrivateTransferCache;
  adapter: () => Promise<PterodactylAdapter>;
  prepare: (serverId: string) => Promise<void>;
  wake: (jobId: string) => Promise<void>;
  leaseKey: (jobId: string) => string;
  lease: (
    jobId: string,
    token: string,
    operation: 'claim' | 'renew' | 'release',
  ) => Promise<boolean>;
}) {
  const active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  let stopped = false;
  async function collect(jobId: string, serverId: string, signal: AbortSignal) {
    const token = randomUUID();
    if (!(await options.lease(jobId, token, 'claim'))) return;
    let transcript: InstallationTranscript = { logs: [], available: false };
    let bytes = 0;
    let dirty = false;
    let writing: Promise<void> | undefined;
    const flush = (): Promise<void> => {
      if (!dirty) return writing ?? Promise.resolve();
      if (writing) return writing.then(flush);
      dirty = false;
      writing = options.cache
        .put(installationLogKey(jobId), JSON.stringify(transcript), 900_000, {
          key: options.leaseKey(jobId),
          token,
        })
        .catch(() => {
          /* Logs are diagnostic; installer authority stays durable. */
        })
        .finally(() => {
          writing = undefined;
        });
      return writing;
    };
    let binding: string | undefined;
    const authorized = async () => {
      if (signal.aborted) return false;
      const row = await options.db
        .selectFrom('managed_servers as s')
        .innerJoin('server_operations as o', 'o.server_id', 's.id')
        .innerJoin('operation_jobs as j', 'j.id', 'o.job_id')
        .select([
          's.pterodactyl_id',
          's.pterodactyl_identifier',
          's.pterodactyl_uuid',
          's.provider_user_id',
          's.external_id',
          's.node_id',
          'o.plan',
          'j.state',
        ])
        .where('s.id', '=', serverId)
        .where('s.deleted_at', 'is', null)
        .where('s.active_operation_id', '=', jobId)
        .where('o.job_id', '=', jobId)
        .where('o.action', 'in', ['provision', 'reinstall'])
        .executeTakeFirst();
      const identity = row
        ? JSON.stringify([
            row.pterodactyl_id,
            row.pterodactyl_identifier,
            row.pterodactyl_uuid,
            row.provider_user_id,
            row.external_id,
            row.node_id,
          ])
        : undefined;
      if (binding && binding !== identity) return false;
      if (identity) binding ??= identity;
      return row &&
        !row.plan.modpackOperationId &&
        !row.plan.installConfirmed &&
        ['queued', 'running'].includes(row.state) &&
        row.pterodactyl_identifier &&
        row.pterodactyl_uuid
        ? row
        : false;
    };
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
        if (signal.aborted) done();
      });
    try {
      const existing = await options.cache.get(installationLogKey(jobId)).catch(() => undefined);
      if (existing) transcript = JSON.parse(existing) as InstallationTranscript;
      bytes = transcript.logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0);
      const deadline = Date.now() + 60 * 60_000;
      while (!signal.aborted && Date.now() < deadline) {
        const row = await authorized();
        if (!row || !(await options.lease(jobId, token, 'renew'))) break;
        let relay: Awaited<ReturnType<PterodactylAdapter['relayInstallation']>> | undefined;
        let finished!: () => void;
        const end = new Promise<void>((resolve) => {
          finished = resolve;
        });
        const endStream = () => finished();
        signal.addEventListener('abort', endStream, { once: true });
        let checking = false;
        const logTimer = setInterval(() => {
          void flush();
        }, 250);
        logTimer.unref();
        const timer = setInterval(() => {
          if (checking) return;
          checking = true;
          void Promise.all([authorized(), options.lease(jobId, token, 'renew')])
            .then(([current, leased]) => {
              if (!current || !leased) finished();
            })
            .catch(finished)
            .finally(() => {
              checking = false;
            });
        }, 5000);
        timer.unref();
        try {
          await options.prepare(serverId);
          if (signal.aborted) break;
          const adapter = await options.adapter();
          relay = await adapter.relayInstallation(row.pterodactyl_identifier as string, {
            serverUUID: row.pterodactyl_uuid as string,
            signal,
            canSendCommands: false,
            maxDurationMs: 3600_000,
            authorize: async () => Boolean(await authorized()),
            onEvent(event) {
              if (signal.aborted) return;
              if (event.type === 'console' && event.source === 'installation') {
                const text = stripVTControlCharacters(event.data.slice(0, 8192));
                transcript.logs.push({ id: randomUUID(), at: new Date().toISOString(), text });
                bytes += Buffer.byteLength(text);
                while (transcript.logs.length > 1000 || bytes > 256 * 1024) {
                  bytes -= Buffer.byteLength(transcript.logs.shift()?.text ?? '');
                }
                dirty = true;
              }
              if (event.type === 'installation' && event.phase === 'completed') {
                // Only a wake hint. The lifecycle still verifies its own terminal proof.
                void options.wake(jobId).catch(() => undefined);
                finished();
              }
              if (event.type === 'closed' || event.type === 'error') finished();
            },
          });
          transcript.available = true;
          dirty = true;
          await end;
        } catch {
          /* Bounded retry recovers startup races and short provider outages. */
        } finally {
          clearInterval(timer);
          clearInterval(logTimer);
          signal.removeEventListener('abort', endStream);
          relay?.close();
          await flush();
        }
        if (!signal.aborted) await sleep(2000);
      }
    } finally {
      await flush();
      await options.lease(jobId, token, 'release').catch(() => false);
    }
  }
  return {
    ensure(jobId: string, serverId: string) {
      if (stopped || active.has(jobId) || active.size >= 32) return;
      const controller = new AbortController();
      const done = collect(jobId, serverId, controller.signal)
        .catch(() => undefined)
        .finally(() => {
          active.delete(jobId);
        });
      active.set(jobId, { controller, done });
    },
    async close() {
      stopped = true;
      for (const item of active.values()) item.controller.abort();
      await Promise.all([...active.values()].map((item) => item.done));
    },
  };
}
