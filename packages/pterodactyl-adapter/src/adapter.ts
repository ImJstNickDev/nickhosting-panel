import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { allocationInventory } from './allocations.js';
import { type ConsoleRelayOptions, createConsoleRelay } from './console.js';
import { getDirectoryBatchSettings, listDirectoriesBatch } from './directory-batch.js';
import { createDownloadPool } from './download-pool.js';
import {
  allowedOrigin,
  createDownloadProxy,
  type DownloadProxyOptions,
  signedTarget,
} from './downloads.js';
import { readEditorDownload } from './editor-download.js';
import {
  commitFileArchive,
  type FileArchiveCommit,
  type GuardedDirectoryDelete,
  getFileOperationCapabilities,
  guardedDeleteDirectory,
  inspectFileOperation,
} from './file-operations.js';
import { confirmInstallation } from './installation.js';
import { type StopConfirmationOptions, stopWithConfirmation } from './power.js';
import { createTransferGuard, type TransferOptions } from './transfer-guard.js';
import {
  createTransport,
  numericId,
  PterodactylError,
  parseInput,
  ResponseTooLargeError,
  readBounded,
  relativePath,
  segment,
  type TransportOptions,
} from './transport.js';
import {
  type ApplicationServer,
  applicationServerSchema,
  type BuildUpdate,
  backupActivitySchema,
  backupSchema,
  clientServerSchema,
  eggSchema,
  featureLimitsSchema,
  fileSchema,
  limitsSchema,
  nestSchema,
  nodeSchema,
  type PowerAction,
  type ProvisionPlan,
  powerActivitySchema,
  provisionPlanSchema,
  resourcesSchema,
  type StartupUpdate,
  userSchema,
} from './types.js';
import { uploadNotDispatched } from './upload-dispatch.js';
import { createUploadProxy, type UploadProxyOptions } from './uploads.js';

export interface PterodactylOptions extends TransportOptions {
  /** Exact trusted Wings origins; never supplied by a browser. */
  webSocketOrigins?: string[];
  /** Exact trusted Wings/S3 origins used only by the backend download proxy. */
  downloadOrigins?: string[];
  /** Separately approved exact Wings upload origins; never backup/S3 origins. */
  uploadOrigins?: string[];
  /** Changes whenever the managed provider identity/node or credential revision changes. */
  fileDownloadBinding?: string;
}
export interface PreparedUploadBatch {
  expiresAt: number;
  uploads: Array<(input: UploadProxyOptions) => Promise<void>>;
}
/** Optional caller-owned debug timing; the adapter never logs or starts its own clock. */
export interface FileReadTiming {
  measure<T>(name: string, work: () => Promise<T>): Promise<T>;
  measureSync<T>(name: string, work: () => T): T;
}
export function createPterodactylAdapter(options: PterodactylOptions) {
  const transport = createTransport(options);
  const appServer = (id: number) => `servers/${numericId(id)}`;
  const clientServer = (identifier: string) => `servers/${segment(identifier)}`;
  const filePath = (path: string, root = false) => encodeURIComponent(relativePath(path, root));
  const backupPath = (identifier: string, backupId: string) =>
    `${clientServer(identifier)}/backups/${parseInput(z.string().uuid(), backupId)}`;
  const download = createDownloadProxy(options);
  const upload = createUploadProxy(options);
  const fileDownloads = createDownloadPool(options, transport);
  const uploadOrigins = new Set(
    (options.uploadOrigins ?? []).map((origin) => allowedOrigin(origin, ['http:', 'https:'])),
  );
  const uploadTarget = (url: string) => {
    const target = signedTarget(url, uploadOrigins);
    if (!target.pathname.endsWith('/upload/file'))
      throw new PterodactylError('invalid_response', 'client', 'rejected');
    return target;
  };
  const uploadHandoff = (url: string, path: string, expiresAt?: number) => {
    uploadTarget(url);
    let used = false;
    return async (body: UploadProxyOptions) => {
      if (used || (expiresAt !== undefined && Date.now() >= expiresAt)) {
        void body.body.cancel().catch(() => {});
        throw uploadNotDispatched(new DomainError('conflict'));
      }
      used = true;
      return upload(url, path, body);
    };
  };
  const adapter = {
    getAccount: () =>
      transport.entity(
        'client',
        'account',
        z.object({ id: z.number().int().positive(), admin: z.boolean().optional() }),
      ),
    listNodes: () => transport.list('application', 'nodes', nodeSchema),
    getNode: (id: number) => transport.entity('application', `nodes/${numericId(id)}`, nodeSchema),
    listNests: () => transport.list('application', 'nests', nestSchema),
    listEggs: (nestId: number) =>
      transport.list(
        'application',
        `nests/${numericId(nestId)}/eggs?include=variables,config`,
        eggSchema,
      ),
    getEgg: (nestId: number, eggId: number) =>
      transport.entity(
        'application',
        `nests/${numericId(nestId)}/eggs/${numericId(eggId)}?include=variables,config`,
        eggSchema,
      ),
    listAllocations: (nodeId: number) => allocationInventory(transport, nodeId),
    listUsers: () => transport.list('application', 'users', userSchema),
    listApplicationServers: () => transport.list('application', 'servers', applicationServerSchema),
    getApplicationServer: (id: number) =>
      transport.entity(
        'application',
        `${appServer(id)}?include=allocations`,
        applicationServerSchema,
      ),
    async getApplicationServers(uuids: string[]): Promise<ApplicationServer[]> {
      const selected = [...new Set(parseInput(z.array(z.uuid()).max(1000), uuids))];
      const servers: ApplicationServer[] = [];
      const seen = new Set<string>();
      const seenIds = new Set<number>();
      // Standard Panel UUID filtering accepts comma-separated exact values.
      // Bound URL length and keep all pagination inside the existing transport.
      for (let offset = 0; offset < selected.length; offset += 48) {
        const chunk = new Set(selected.slice(offset, offset + 48));
        const query = new URLSearchParams({
          'filter[uuid]': [...chunk].join(','),
          include: 'allocations',
        });
        const found = await transport.list(
          'application',
          `servers?${query}`,
          applicationServerSchema,
        );
        for (const server of found) {
          if (!chunk.has(server.uuid) || seen.has(server.uuid) || seenIds.has(server.id))
            throw new PterodactylError('invalid_response', 'application', 'rejected');
          seen.add(server.uuid);
          seenIds.add(server.id);
          servers.push(server);
        }
      }
      // Missing members remain visible to the caller's managed-identity check;
      // never hide partial inventory behind per-server fallback requests.
      return servers;
    },
    async findServerByExternalId(externalId: string) {
      const key = parseInput(
        z
          .string()
          .min(1)
          .max(191)
          .regex(/^[A-Za-z0-9_.:-]+$/),
        externalId,
      );
      try {
        return await transport.entity(
          'application',
          `servers/external/${encodeURIComponent(key)}?include=allocations`,
          applicationServerSchema,
        );
      } catch (error) {
        if (error instanceof PterodactylError && error.reason === 'not_found') return null;
        throw error;
      }
    },
    async createServer(input: ProvisionPlan) {
      const plan = parseInput(provisionPlanSchema, input);
      const selected = [plan.allocation.default, ...(plan.allocation.additional ?? [])];
      if (new Set(selected).size !== selected.length) throw new DomainError('validation_failed');
      return transport.entity(
        'application',
        'servers?include=allocations',
        applicationServerSchema,
        'POST',
        {
          name: plan.name,
          external_id: plan.externalId,
          description: plan.description ?? '',
          user: plan.userId,
          egg: plan.eggId,
          docker_image: plan.dockerImage,
          startup: plan.startup,
          environment: plan.environment,
          limits: plan.limits,
          feature_limits: plan.featureLimits,
          allocation: plan.allocation,
          start_on_completion: false,
        },
      );
    },
    updateBuild(id: number, input: BuildUpdate) {
      const body = parseInput(
        limitsSchema
          .extend({
            allocation: z.number().int().positive(),
            feature_limits: featureLimitsSchema,
            add_allocations: z.array(z.number().int().positive()).max(100).optional(),
            remove_allocations: z.array(z.number().int().positive()).max(100).optional(),
          })
          .strict(),
        input,
      );
      return transport.entity(
        'application',
        `${appServer(id)}/build`,
        applicationServerSchema,
        'PATCH',
        body,
      );
    },
    updateStartup(id: number, input: StartupUpdate) {
      const body = parseInput(
        z.strictObject({
          startup: z.string().min(1).max(16384),
          environment: provisionPlanSchema.shape.environment,
          egg: z.number().int().positive(),
          image: z.string().min(1).max(1024),
          skip_scripts: z.boolean().optional(),
        }),
        input,
      );
      return transport.entity(
        'application',
        `${appServer(id)}/startup`,
        applicationServerSchema,
        'PATCH',
        body,
      );
    },
    updateDetails(
      id: number,
      input: { name: string; user: number; external_id: string; description?: string },
    ) {
      const body = parseInput(
        z.strictObject({
          name: z.string().min(1).max(191),
          user: z.number().int().positive(),
          external_id: z
            .string()
            .min(1)
            .max(191)
            .regex(/^[A-Za-z0-9_.:-]+$/),
          description: z.string().max(4000).optional(),
        }),
        input,
      );
      return transport.entity(
        'application',
        `${appServer(id)}/details`,
        applicationServerSchema,
        'PATCH',
        body,
      );
    },
    deleteServer: (id: number) => transport.empty('application', appServer(id), 'DELETE'),
    getClientServer: (identifier: string) =>
      transport.entity('client', clientServer(identifier), clientServerSchema),
    listClientServers: (adminAll = false) =>
      transport.list('client', adminAll ? '?type=admin-all' : '', clientServerSchema),
    async getClientPermissions(identifier: string): Promise<string[]> {
      const result = await transport.json(
        'client',
        clientServer(identifier),
        z.object({ meta: z.object({ user_permissions: z.array(z.string()) }) }),
      );
      return result.meta.user_permissions;
    },
    /** Installed Panel caches this snapshot for 20 seconds; it is not immediate stop confirmation. */
    getResources: (identifier: string) =>
      transport.entity('client', `${clientServer(identifier)}/resources`, resourcesSchema),
    confirmInstallation(
      applicationId: number,
      identifier: string,
      input: StopConfirmationOptions,
    ): Promise<{ confirmed: boolean }> {
      return confirmInstallation(
        adapter,
        applicationId,
        identifier,
        input,
        false,
        300000,
        options.containerObserver,
      );
    },
    reinstallWithConfirmation(
      applicationId: number,
      identifier: string,
      input: StopConfirmationOptions,
    ): Promise<{ confirmed: boolean }> {
      fileDownloads.invalidate(identifier);
      return confirmInstallation(
        adapter,
        applicationId,
        identifier,
        input,
        true,
        300000,
        options.containerObserver,
      ).finally(() => fileDownloads.invalidate(identifier));
    },
    stopWithConfirmation(
      applicationId: number,
      identifier: string,
      input: StopConfirmationOptions,
    ): Promise<{ confirmed: boolean }> {
      return stopWithConfirmation(
        {
          ...adapter,
          // Internal stop confirmation already has a freshly verified Application
          // UUID. The browser console retains its independent Client identity read.
          relayConsole: (identifier, relayOptions, serverUUID) =>
            createConsoleRelay(transport, options, identifier, serverUUID, relayOptions),
        },
        applicationId,
        identifier,
        input,
        60000,
        options.containerObserver,
      );
    },
    power(identifier: string, signal: PowerAction) {
      return transport.empty('client', `${clientServer(identifier)}/power`, 'POST', {
        signal: parseInput(z.enum(['start', 'stop', 'restart', 'kill']), signal),
      });
    },
    /** Reinstallation does not imply a wipe; egg installation scripts decide what they replace. */
    reinstall(identifier: string) {
      fileDownloads.invalidate(identifier);
      return transport
        .empty('client', `${clientServer(identifier)}/settings/reinstall`, 'POST')
        .finally(() => fileDownloads.invalidate(identifier));
    },
    reinstallApplication: (id: number) =>
      transport.empty('application', `${appServer(id)}/reinstall`, 'POST'),
    sendCommand(identifier: string, command: string) {
      return transport.empty('client', `${clientServer(identifier)}/command`, 'POST', {
        command: parseInput(
          z
            .string()
            .min(1)
            .max(4096)
            .refine((value) => !value.includes('\0')),
          command,
        ),
      });
    },
    listFiles(identifier: string, directory = '') {
      return transport.list(
        'client',
        `${clientServer(identifier)}/files/list?directory=${filePath(directory, true)}`,
        fileSchema,
      );
    },
    /** Experimental Blueprint batch API; normal listing and downloads remain independent. */
    listDirectoriesBatch: (identifier: string, directories: string[]) =>
      listDirectoriesBatch(transport, identifier, directories),
    getDirectoryBatchSettings: (identifier: string) =>
      getDirectoryBatchSettings(transport, identifier),
    getFileOperationCapabilities: (identifier: string) =>
      getFileOperationCapabilities(transport, identifier),
    inspectFileOperation: (identifier: string, input: { target: string; guardFile: string }) =>
      inspectFileOperation(transport, identifier, input),
    commitFileArchive(identifier: string, input: FileArchiveCommit, trace = false) {
      fileDownloads.invalidate(identifier, [input.destinationRoot]);
      return commitFileArchive(transport, identifier, input, trace).finally(() =>
        fileDownloads.invalidate(identifier, [input.destinationRoot]),
      );
    },
    guardedDeleteDirectory(identifier: string, input: GuardedDirectoryDelete) {
      fileDownloads.invalidate(identifier, [input.target.path]);
      return guardedDeleteDirectory(transport, identifier, input).finally(() =>
        fileDownloads.invalidate(identifier, [input.target.path]),
      );
    },
    /** Native synchronous extraction; caller owns archive validation, staging and recovery. */
    extractArchive(identifier: string, root: string, file: string) {
      const rootPath = relativePath(root, true);
      const archive = relativePath(file).slice(1);
      fileDownloads.invalidate(identifier);
      return transport
        .empty(
          'client',
          `${clientServer(identifier)}/files/decompress`,
          'POST',
          {
            root: rootPath,
            file: archive,
          },
          false,
          { timeoutMs: 90000 },
        )
        .finally(() => fileDownloads.invalidate(identifier));
    },
    async readFile(
      identifier: string,
      path: string,
      maxBytes = 1048576,
      timing?: FileReadTiming,
    ): Promise<Uint8Array> {
      parseInput(z.number().int().min(1).max(1048576), maxBytes);
      // Includes transport preparation/status validation, not only network latency.
      const request = () =>
        transport.request(
          'client',
          `${clientServer(identifier)}/files/contents?file=${filePath(path)}`,
        );
      const response = timing ? await timing.measure('file.httpHeaders', request) : await request();
      try {
        const read = () => readBounded(response, maxBytes);
        return timing ? await timing.measure('file.bodyRead', read) : await read();
      } catch (error) {
        if (error instanceof ResponseTooLargeError) throw new DomainError('validation_failed', 413);
        throw new PterodactylError('invalid_response', 'client', 'rejected');
      }
    },
    prefetchDownloads: fileDownloads.prefetch,
    invalidateFileDownloads: fileDownloads.invalidate,
    async readFileForEditor(
      identifier: string,
      path: string,
      maxBytes = 1048576,
      timing?: FileReadTiming,
    ): Promise<Uint8Array> {
      parseInput(z.number().int().min(1).max(1048576), maxBytes);
      const url = timing
        ? await timing.measure('file.signedUrl', () => fileDownloads.take(identifier, path))
        : await fileDownloads.take(identifier, path);
      return readEditorDownload(options, url, maxBytes, timing);
    },
    writeFile(identifier: string, path: string, contents: string) {
      if (typeof contents !== 'string' || Buffer.byteLength(contents, 'utf8') > 1048576)
        throw new DomainError('validation_failed');
      return transport.empty(
        'client',
        `${clientServer(identifier)}/files/write?file=${filePath(path)}`,
        'POST',
        contents,
        true,
      );
    },
    deleteFiles(identifier: string, root: string, files: string[]) {
      const rootPath = relativePath(root, true);
      const names = parseInput(z.array(z.string()).min(1).max(1000), files).map((path) =>
        relativePath(path).slice(1),
      );
      fileDownloads.invalidate(
        identifier,
        names.map((name) => [root, name].filter(Boolean).join('/')),
      );
      return transport
        .empty('client', `${clientServer(identifier)}/files/delete`, 'POST', {
          root: rootPath,
          files: names,
        })
        .finally(() =>
          fileDownloads.invalidate(
            identifier,
            names.map((name) => [root, name].filter(Boolean).join('/')),
          ),
        );
    },
    createDirectory(identifier: string, root: string, name: string) {
      const child = relativePath(name).slice(1);
      if (child.includes('/')) throw new DomainError('validation_failed');
      return transport.empty('client', `${clientServer(identifier)}/files/create-folder`, 'POST', {
        root: relativePath(root, true),
        name: child,
      });
    },
    renameFiles(identifier: string, root: string, files: { from: string; to: string }[]) {
      const moves = parseInput(
        z
          .array(z.strictObject({ from: z.string(), to: z.string() }))
          .min(1)
          .max(1000),
        files,
      ).map(({ from, to }) => ({
        from: relativePath(from).slice(1),
        to: relativePath(to).slice(1),
      }));
      fileDownloads.invalidate(
        identifier,
        moves.flatMap(({ from, to }) =>
          [from, to].map((name) => [root, name].filter(Boolean).join('/')),
        ),
      );
      return transport
        .empty('client', `${clientServer(identifier)}/files/rename`, 'PUT', {
          root: relativePath(root, true),
          files: moves,
        })
        .finally(() =>
          fileDownloads.invalidate(
            identifier,
            moves.flatMap(({ from, to }) =>
              [from, to].map((name) => [root, name].filter(Boolean).join('/')),
            ),
          ),
        );
    },
    listBackups: (identifier: string) =>
      transport.list('client', `${clientServer(identifier)}/backups`, backupSchema),
    listBackupActivity: (identifier: string) =>
      transport.list(
        'client',
        `${clientServer(identifier)}/activity?filter%5Bevent%5D=backup.restore&sort=-timestamp`,
        backupActivitySchema,
      ),
    async listPowerActivity(identifier: string) {
      // Bounded recent history, not an unbounded audit export. The latest group
      // is all reconciliation may use; never follow provider pagination links.
      const result = await transport.json(
        'client',
        `${clientServer(identifier)}/activity?filter%5Bevent%5D=server%3Apower.&sort=-timestamp&per_page=100&page=1`,
        z.object({
          object: z.literal('list'),
          data: z.array(z.object({ attributes: powerActivitySchema })).max(100),
          meta: z.object({ pagination: z.object({ current_page: z.literal(1) }) }).optional(),
        }),
      );
      const rows = result.data.map(({ attributes }) => attributes);
      // A full page containing only the latest timestamp may hide a conflicting
      // start on the next page. Do not decide intent from a truncated tie group.
      if (
        rows.length === 100 &&
        Date.parse(rows[0]?.timestamp ?? '') === Date.parse(rows[99]?.timestamp ?? '')
      )
        throw new PterodactylError('invalid_response', 'client', 'rejected');

      if (
        rows.some(
          (row, index) =>
            index > 0 && Date.parse(row.timestamp) > Date.parse(rows[index - 1]?.timestamp ?? ''),
        )
      )
        throw new PterodactylError('invalid_response', 'client', 'rejected');
      return rows;
    },
    getBackup: (identifier: string, backupId: string) =>
      transport.entity('client', backupPath(identifier, backupId), backupSchema),
    createBackup(
      identifier: string,
      input: { name: string; ignored?: string; is_locked?: boolean },
    ) {
      const body = parseInput(
        z.strictObject({
          name: z.string().min(1).max(191),
          ignored: z.string().max(16384).optional(),
          is_locked: z.boolean().optional(),
        }),
        input,
      );
      return transport.entity(
        'client',
        `${clientServer(identifier)}/backups`,
        backupSchema,
        'POST',
        body,
      );
    },
    deleteBackup: (identifier: string, backupId: string) =>
      transport.empty('client', backupPath(identifier, backupId), 'DELETE'),
    toggleBackupLock: (identifier: string, backupId: string) =>
      transport.entity('client', `${backupPath(identifier, backupId)}/lock`, backupSchema, 'POST'),
    restoreBackup(identifier: string, backupId: string, truncate: boolean) {
      fileDownloads.invalidate(identifier);
      return transport
        .empty('client', `${backupPath(identifier, backupId)}/restore`, 'POST', {
          truncate: parseInput(z.boolean(), truncate),
        })
        .finally(() => fileDownloads.invalidate(identifier));
    },
    async downloadBackup(identifier: string, backupId: string, input: DownloadProxyOptions) {
      if (input.signal?.aborted) throw new PterodactylError('unavailable', 'client', 'rejected');
      const result = await transport.entity(
        'client',
        `${backupPath(identifier, backupId)}/download`,
        z.object({ url: z.string() }),
      );
      return download(result.url, input);
    },
    async downloadFile(identifier: string, path: string, input: DownloadProxyOptions) {
      if (input.signal?.aborted) throw new PterodactylError('unavailable', 'client', 'rejected');
      await input.authorize?.();
      const url = await fileDownloads.take(identifier, path);
      return download(url, input);
    },
    /** Private, single-use upload handoff. URL lookup may overlap read-only
     * preflight; no Wings mutation occurs until the returned function is called. */
    async prepareUpload(
      identifier: string,
      path: string,
      input: TransferOptions = {},
    ): Promise<(body: UploadProxyOptions) => Promise<void>> {
      let result: { url: string };
      try {
        relativePath(path);
        const guard = createTransferGuard(input, 'rejected');
        try {
          await guard.run(() => guard.authorize(true));
          result = await guard.run(() =>
            transport.entity(
              'client',
              `${clientServer(identifier)}/files/upload`,
              z.object({ url: z.string() }),
              'GET',
              undefined,
              // This GET issues a single-use credential, not a shareable observation.
              false,
            ),
          );
        } finally {
          guard.close();
        }
        return uploadHandoff(result.url, path);
      } catch (error) {
        throw uploadNotDispatched(error);
      }
    },
    /** Optional Blueprint acceleration. One signed credential per file remains
     * private and single-use; native Wings transfers retain their usual guards. */
    async prepareUploadBatch(
      identifier: string,
      paths: string[],
      input: TransferOptions = {},
    ): Promise<PreparedUploadBatch | null> {
      try {
        const normalized = parseInput(z.array(z.string()).min(1).max(500), paths).map((path) =>
          relativePath(path).slice(1),
        );
        if (new Set(normalized).size !== normalized.length)
          throw new DomainError('validation_failed');
        const endpoint = `extensions/nickhosting/servers/${segment(identifier)}/upload-urls`;
        const guard = createTransferGuard(input, 'rejected');
        let result: { expiresAt: string; urls: string[] };
        try {
          await guard.run(() => guard.authorize(true));
          const issue = async (
            refresh = false,
          ): Promise<{ expiresAt: string; urls: string[] } | null> => {
            const settings = await guard.run(() => fileDownloads.settings(identifier, refresh));
            const urls: string[] = [];
            let expiresAt = Number.POSITIVE_INFINITY;
            for (let offset = 0; offset < normalized.length; offset += settings.uploadBatchLimit) {
              const count = Math.min(settings.uploadBatchLimit, normalized.length - offset);
              try {
                const part = await guard.run(() =>
                  transport.json(
                    'client',
                    endpoint,
                    z.strictObject({
                      expiresAt: z.string().datetime({ offset: true }),
                      urls: z.array(z.string().min(1).max(8192)).length(count),
                    }),
                    'POST',
                    { count },
                  ),
                );
                guard.progress();
                const expiry = Date.parse(part.expiresAt);
                if (expiry <= Date.now() || expiry > Date.now() + 900_000 + 60_000)
                  throw new PterodactylError('invalid_response', 'client', 'rejected');
                expiresAt = Math.min(expiresAt, expiry);
                urls.push(...part.urls);
              } catch (error) {
                // Only an absent endpoint permits the native fallback. A lowered
                // configured limit gets one settings refresh; no policy downgrade.
                if (error instanceof PterodactylError && error.reason === 'not_found') return null;
                if (!refresh && error instanceof PterodactylError && error.upstreamStatus === 422)
                  return issue(true);
                throw error;
              }
            }
            return { expiresAt: new Date(expiresAt).toISOString(), urls };
          };
          const issued = await issue();
          if (!issued) return null;
          result = issued;
        } finally {
          guard.close();
        }
        const expiresAt = Date.parse(result.expiresAt);
        if (expiresAt <= Date.now())
          throw new PterodactylError('invalid_response', 'client', 'rejected');
        // Validate the whole response before releasing any usable credential.
        // Detect reuse even when the same token appears with another query/order.
        const tokens = new Set<string>();
        for (const url of result.urls) {
          const target = uploadTarget(url);
          const values = target.searchParams.getAll('token');
          const token = values[0];
          if (values.length !== 1 || !token || tokens.has(token))
            throw new PterodactylError('invalid_response', 'client', 'rejected');
          tokens.add(token);
        }
        return {
          expiresAt,
          uploads: normalized.map((path, index) =>
            uploadHandoff(result.urls[index] as string, path, expiresAt),
          ),
        };
      } catch (error) {
        throw uploadNotDispatched(error);
      }
    },
    async uploadFile(identifier: string, path: string, input: UploadProxyOptions): Promise<void> {
      let prepared: (body: UploadProxyOptions) => Promise<void>;
      try {
        prepared = await adapter.prepareUpload(identifier, path, input);
      } catch (error) {
        void input.body.cancel().catch(() => {});
        throw error;
      }
      return prepared(input);
    },
    async relayConsole(identifier: string, input: ConsoleRelayOptions) {
      const server = await adapter.getClientServer(identifier);
      return createConsoleRelay(transport, options, identifier, server.uuid, input);
    },
    /** Read scopes only. Write permissions cannot be proven by these probes. */
    async discoverCapabilities(includeClient = true) {
      const checks = {
        nodes: () => transport.list('application', 'nodes', nodeSchema),
        nests: () => transport.list('application', 'nests', nestSchema),
        servers: () => transport.list('application', 'servers', applicationServerSchema),
        users: () => transport.list('application', 'users', userSchema),
        client: () =>
          transport.json(
            'client',
            '?per_page=1',
            z.object({ object: z.literal('list'), data: z.array(z.unknown()) }),
          ),
      };
      const result: Record<string, { available: boolean; reason?: string; scope?: string }> = {};
      await Promise.all(
        Object.entries(checks)
          .filter(([name]) => includeClient || name !== 'client')
          .map(async ([name, probe]) => {
            try {
              await probe();
              result[name] = { available: true };
            } catch (error) {
              result[name] = {
                available: false,
                reason: error instanceof PterodactylError ? error.reason : 'unavailable',
                scope: error instanceof PterodactylError ? error.scope : undefined,
              };
            }
          }),
      );
      return result;
    },
  };
  return adapter;
}
export type PterodactylAdapter = ReturnType<typeof createPterodactylAdapter>;
