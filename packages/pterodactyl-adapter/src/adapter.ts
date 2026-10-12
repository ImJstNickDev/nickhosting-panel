import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { allocationInventory } from './allocations.js';
import { type ConsoleRelayOptions, createConsoleRelay } from './console.js';
import {
  allowedOrigin,
  createDownloadProxy,
  type DownloadProxyOptions,
  signedTarget,
} from './downloads.js';
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
}
export interface PreparedUploadBatch {
  expiresAt: number;
  uploads: Array<(input: UploadProxyOptions) => Promise<void>>;
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
      return confirmInstallation(
        adapter,
        applicationId,
        identifier,
        input,
        true,
        300000,
        options.containerObserver,
      );
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
    reinstall: (identifier: string) =>
      transport.empty('client', `${clientServer(identifier)}/settings/reinstall`, 'POST'),
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
    async readFile(identifier: string, path: string, maxBytes = 1048576): Promise<Uint8Array> {
      parseInput(z.number().int().min(1).max(1048576), maxBytes);
      const response = await transport.request(
        'client',
        `${clientServer(identifier)}/files/contents?file=${filePath(path)}`,
      );
      try {
        return await readBounded(response, maxBytes);
      } catch (error) {
        if (error instanceof ResponseTooLargeError) throw new DomainError('validation_failed', 413);
        throw new PterodactylError('invalid_response', 'client', 'rejected');
      }
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
      return transport.empty('client', `${clientServer(identifier)}/files/delete`, 'POST', {
        root: rootPath,
        files: names,
      });
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
      return transport.empty('client', `${clientServer(identifier)}/files/rename`, 'PUT', {
        root: relativePath(root, true),
        files: moves,
      });
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
    restoreBackup(identifier: string, backupId: string, truncate: boolean) {
      return transport.empty('client', `${backupPath(identifier, backupId)}/restore`, 'POST', {
        truncate: parseInput(z.boolean(), truncate),
      });
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
      const result = await transport.entity(
        'client',
        `${clientServer(identifier)}/files/download?file=${filePath(path)}`,
        z.object({ url: z.string() }),
      );
      return download(result.url, input);
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
        const startedAt = Date.now();
        let result: { expiresAt: string; urls: string[] };
        try {
          await guard.run(() => guard.authorize(true));
          try {
            result = await guard.run(() =>
              transport.json(
                'client',
                endpoint,
                z
                  .object({
                    expiresAt: z.string().datetime({ offset: true }),
                    urls: z.array(z.string().min(1).max(8192)).length(normalized.length),
                  })
                  .strict(),
                'POST',
                { count: normalized.length },
              ),
            );
          } catch (error) {
            // Missing old extension endpoint only. Access, throttling and broken
            // responses are failures, not permission to bypass extension policy.
            if (error instanceof PterodactylError && error.reason === 'not_found') return null;
            throw error;
          }
        } finally {
          guard.close();
        }
        const expiresAt = Date.parse(result.expiresAt);
        if (expiresAt <= Date.now() || expiresAt > startedAt + 16 * 60_000)
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
