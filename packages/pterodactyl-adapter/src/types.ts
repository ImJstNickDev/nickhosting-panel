import { z } from 'zod';

const id = z.number().int().positive();
const nonnegative = z.number().finite().nonnegative();
export const limitsSchema = z.object({
  memory: nonnegative,
  swap: z.number().min(-1),
  disk: nonnegative,
  io: z.number().int().min(10).max(1000),
  cpu: nonnegative,
  threads: z.string().max(255).nullable().optional(),
});
export type ServerLimits = z.infer<typeof limitsSchema>;
export const featureLimitsSchema = z.object({
  databases: z.number().int().nonnegative(),
  allocations: z.number().int().nonnegative(),
  backups: z.number().int().nonnegative(),
});
export const nodeSchema = z.object({
  id,
  uuid: z.string(),
  name: z.string(),
  fqdn: z.string(),
  scheme: z.enum(['http', 'https']),
  memory: nonnegative,
  memory_overallocate: z.number(),
  disk: nonnegative,
  disk_overallocate: z.number(),
  daemon_listen: id,
  daemon_sftp: id.optional(),
  maintenance_mode: z.boolean().optional(),
  location_id: id,
  allocated_resources: z.object({ memory: nonnegative, disk: nonnegative }).optional(),
});
export const nestSchema = z.object({
  id,
  uuid: z.string(),
  name: z.string(),
  description: z.string().nullable(),
});
const variableSchema = z.object({
  id,
  name: z.string(),
  description: z.string(),
  env_variable: z.string(),
  default_value: z.string().nullable(),
  user_viewable: z.boolean(),
  user_editable: z.boolean(),
  rules: z.string(),
});
export const eggSchema = z.object({
  id,
  uuid: z.string(),
  name: z.string(),
  nest: id,
  description: z.string().nullable(),
  docker_image: z.string(),
  docker_images: z.record(z.string(), z.string()).optional(),
  startup: z.string(),
  config: z
    .object({ stop: z.string().nullable(), extends: z.number().nullable().optional() })
    .optional(),
  relationships: z
    .object({
      config: z
        .object({ attributes: z.object({ stop: z.string().nullable() }).nullable() })
        .optional(),
      variables: z
        .object({
          object: z.literal('list'),
          data: z.array(z.object({ attributes: variableSchema })),
        })
        .optional(),
    })
    .optional(),
});
export const allocationSchema = z.object({
  id,
  ip: z.string(),
  alias: z.string().nullable().optional(),
  port: z.number().int().min(1).max(65535),
  assigned: z.boolean(),
});
export const applicationServerSchema = z.object({
  id,
  external_id: z.string().nullable(),
  uuid: z.string().uuid(),
  identifier: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  suspended: z.boolean(),
  limits: limitsSchema,
  feature_limits: featureLimitsSchema,
  user: id,
  node: id,
  allocation: id,
  nest: id,
  egg: id,
  status: z.string().nullable().optional(),
  container: z.object({
    startup_command: z.string(),
    image: z.string(),
    installed: z.union([z.boolean(), z.number()]),
  }),
  relationships: z
    .object({
      allocations: z
        .object({
          object: z.literal('list'),
          data: z.array(z.object({ attributes: allocationSchema })),
        })
        .optional(),
    })
    .optional(),
  created_at: z.string(),
  updated_at: z.string(),
});
export const clientServerSchema = z.object({
  server_owner: z.boolean(),
  identifier: z.string(),
  uuid: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  limits: limitsSchema,
  feature_limits: featureLimitsSchema,
  is_suspended: z.boolean(),
  is_installing: z.boolean(),
  is_transferring: z.boolean().optional(),
  status: z.string().nullable().optional(),
});
export const resourcesSchema = z.object({
  current_state: z.enum(['offline', 'starting', 'running', 'stopping']),
  is_suspended: z.boolean(),
  resources: z.object({
    memory_bytes: nonnegative,
    cpu_absolute: nonnegative,
    disk_bytes: nonnegative,
    network_rx_bytes: nonnegative,
    network_tx_bytes: nonnegative,
    uptime: nonnegative.optional(),
  }),
});
export const fileSchema = z.object({
  name: z.string().max(4096),
  mode: z.string(),
  mode_bits: z.string().optional(),
  size: nonnegative,
  is_file: z.boolean(),
  is_symlink: z.boolean(),
  mimetype: z.string(),
  created_at: z.string(),
  modified_at: z.string(),
});
export const backupSchema = z.object({
  uuid: z.string().uuid(),
  is_successful: z.boolean(),
  is_locked: z.boolean(),
  name: z.string(),
  ignored_files: z.array(z.string()),
  checksum: z.string().nullable(),
  bytes: nonnegative,
  created_at: z.string(),
  completed_at: z.string().nullable(),
});
/** Deliberately excludes email and names: discovery needs only an existing owner ID. */
export const userSchema = z.object({
  id,
  external_id: z.string().nullable(),
  uuid: z.string(),
  username: z.string(),
  root_admin: z.boolean(),
});
export type Node = z.infer<typeof nodeSchema>;
export type Nest = z.infer<typeof nestSchema>;
export type Egg = z.infer<typeof eggSchema>;
export type Allocation = z.infer<typeof allocationSchema>;
export type ApplicationServer = z.infer<typeof applicationServerSchema>;
export type ClientServer = z.infer<typeof clientServerSchema>;
export type Resources = z.infer<typeof resourcesSchema>;
export type ServerFile = z.infer<typeof fileSchema>;
export type Backup = z.infer<typeof backupSchema>;
/** Safe restore evidence; upstream IPs, actor metadata and unrelated properties are stripped. */
export const backupActivitySchema = z.object({
  id: z.string().regex(/^[a-f0-9]{40}$/),
  event: z.string(),
  timestamp: z.string().datetime({ offset: true }),
  properties: z.object({ name: z.string().optional() }).catch({}),
});
export type BackupActivity = z.infer<typeof backupActivitySchema>;
export type ApplicationUser = z.infer<typeof userSchema>;

export const provisionPlanSchema = z.strictObject({
  name: z.string().trim().min(1).max(191),
  externalId: z
    .string()
    .min(1)
    .max(191)
    .regex(/^[A-Za-z0-9_.:-]+$/),
  description: z.string().max(4000).optional(),
  userId: id,
  eggId: id,
  dockerImage: z.string().min(1).max(1024),
  startup: z.string().min(1).max(16384),
  environment: z.record(
    z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.union([z.string().max(65536), z.number(), z.boolean()]),
  ),
  limits: limitsSchema,
  featureLimits: featureLimitsSchema,
  allocation: z.strictObject({ default: id, additional: z.array(id).max(100).optional() }),
});
export type ProvisionPlan = z.infer<typeof provisionPlanSchema>;
export type BuildUpdate = ServerLimits & {
  allocation: number;
  feature_limits: z.infer<typeof featureLimitsSchema>;
  add_allocations?: number[];
  remove_allocations?: number[];
};
export type StartupUpdate = {
  startup: string;
  environment: Record<string, string | number | boolean>;
  egg: number;
  image: string;
  skip_scripts?: boolean;
};
export type PowerAction = 'start' | 'stop' | 'restart' | 'kill';
