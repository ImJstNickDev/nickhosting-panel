import { DomainError } from '@nickhosting/core';
import { z } from 'zod';
import { type ConsoleRelayOptions, createConsoleRelay } from './console.js';
import { createDownloadProxy, type DownloadProxyOptions } from './downloads.js';
import {
  createTransport,
  numericId,
  PterodactylError,
  parseInput,
  readBounded,
  relativePath,
  segment,
  type TransportOptions,
} from './transport.js';
import {
  allocationSchema,
  applicationServerSchema,
  type BuildUpdate,
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
  provisionPlanSchema,
  resourcesSchema,
  type StartupUpdate,
  userSchema,
} from './types.js';

export interface PterodactylOptions extends TransportOptions {
  /** Exact trusted Wings origins; never supplied by a browser. */
  webSocketOrigins?: string[];
  /** Exact trusted Wings/S3 origins used only by the backend download proxy. */
  downloadOrigins?: string[];
}
export function createPterodactylAdapter(options: PterodactylOptions) {
  const transport = createTransport(options);
  const appServer = (id: number) => `servers/${numericId(id)}`;
  const clientServer = (identifier: string) => `servers/${segment(identifier)}`;
  const filePath = (path: string, root = false) => encodeURIComponent(relativePath(path, root));
  const backupPath = (identifier: string, backupId: string) =>
    `${clientServer(identifier)}/backups/${parseInput(z.string().uuid(), backupId)}`;
  const download = createDownloadProxy(options);
  const adapter = {
    listNodes: () => transport.list('application', 'nodes', nodeSchema),
    getNode: (id: number) => transport.entity('application', `nodes/${numericId(id)}`, nodeSchema),
    listNests: () => transport.list('application', 'nests', nestSchema),
    listEggs: (nestId: number) =>
      transport.list('application', `nests/${numericId(nestId)}/eggs?include=variables`, eggSchema),
    getEgg: (nestId: number, eggId: number) =>
      transport.entity(
        'application',
        `nests/${numericId(nestId)}/eggs/${numericId(eggId)}?include=variables`,
        eggSchema,
      ),
    listAllocations: (nodeId: number) =>
      transport.list('application', `nodes/${numericId(nodeId)}/allocations`, allocationSchema),
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
      } catch {
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
      const result = await transport.entity(
        'client',
        `${backupPath(identifier, backupId)}/download`,
        z.object({ url: z.string() }),
      );
      return download(result.url, input);
    },
    async downloadFile(identifier: string, path: string, input: DownloadProxyOptions) {
      const result = await transport.entity(
        'client',
        `${clientServer(identifier)}/files/download?file=${filePath(path)}`,
        z.object({ url: z.string() }),
      );
      return download(result.url, input);
    },
    async relayConsole(identifier: string, input: ConsoleRelayOptions) {
      const server = await adapter.getClientServer(identifier);
      return createConsoleRelay(transport, options, identifier, server.uuid, input);
    },
    /** Read scopes only. Write permissions cannot be proven by these probes. */
    async discoverCapabilities() {
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
        Object.entries(checks).map(async ([name, probe]) => {
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
