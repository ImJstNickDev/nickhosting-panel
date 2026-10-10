/** Browser-safe first-party UI contracts. Do not import the server SDK root here. */
import { z } from 'zod';

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const fieldId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/);
const key = z.string().regex(/^games\.[a-z][a-z0-9-]*\.[a-zA-Z0-9_.-]{1,100}$/);
const scalar = z.union([z.string().max(1024), z.number().finite(), z.boolean()]);
export const uiConditionSchema = z
  .object({
    field: fieldId,
    operator: z.enum(['equals', 'not-equals', 'one-of', 'present']),
    values: z.array(scalar).max(32).default([]),
  })
  .strict()
  .refine((v) =>
    v.operator === 'present'
      ? v.values.length === 0
      : v.operator === 'one-of'
        ? v.values.length > 0
        : v.values.length === 1,
  );
export const uiOptionSchema = z
  .object({
    value: z.string().min(1).max(256),
    label: z.string().min(1).max(256).optional(),
    labelKey: key.optional(),
    disabled: z.boolean().default(false),
    reasonKey: key.optional(),
    releaseType: z.enum(['release', 'snapshot', 'old_alpha', 'old_beta']).optional(),
    capabilities: z.record(fieldId, z.boolean()).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.label) !== Boolean(v.labelKey));
export type UiOption = z.infer<typeof uiOptionSchema>;
const base = {
  id: fieldId,
  labelKey: key,
  helpKey: key.optional(),
  documentation: z
    .object({ url: z.url().refine((value) => value.startsWith('https://')), labelKey: key })
    .strict()
    .optional(),
  required: z.boolean().default(false),
  when: z.array(uiConditionSchema).max(8).default([]),
};
export const uiFieldSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.enum(['text', 'textarea']),
      minLength: z.number().int().min(0).max(65536).default(0),
      maxLength: z.number().int().min(1).max(65536),
      format: z.enum(['plain', 'player-name', 'world-name', 'uuid']).default('plain'),
      lookupHandler: id.optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('number'),
      min: z.number().finite(),
      max: z.number().finite(),
      integer: z.boolean().default(true),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal('boolean'), mustBeTrue: z.boolean().default(false) })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('choice'),
      options: z.array(uiOptionSchema).max(1000).default([]),
      source: z
        .object({ handler: id, dependsOn: z.array(fieldId).max(16).default([]) })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('multi-text'),
      maxItems: z.number().int().min(1).max(1000),
      maxLength: z.number().int().min(1).max(1024),
      format: z.enum(['plain', 'player-name']).default('plain'),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('preview'),
      handler: id,
      maxItems: z.number().int().min(0).max(10000),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('archive'),
      accept: z
        .array(z.string().regex(/^\.[a-z0-9]{1,12}$/))
        .min(1)
        .max(12),
      handler: id,
      catalog: z
        .object({ searchHandler: id, versionsHandler: id, acquireHandler: id })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('file'),
      accept: z
        .array(z.string().regex(/^\.[a-z0-9]{1,12}$/))
        .min(1)
        .max(12),
      purpose: id,
    })
    .strict(),
]);
export type UiField = z.infer<typeof uiFieldSchema>;
export type UiValues = Readonly<Record<string, unknown>>;
export const uiActionSchema = z
  .object({
    id,
    labelKey: key,
    handler: id,
    requiredPermissions: z
      .array(z.enum(['server:read', 'server:operate', 'server:manage', 'platform:manage']))
      .min(1)
      .max(4),
    requiredCapabilities: z.array(id).max(16),
    requiresStopped: z.boolean().default(false),
    confirmationKey: key.optional(),
    destructive: z.boolean().default(false),
  })
  .strict()
  .refine((a) => !a.destructive || Boolean(a.confirmationKey));
export type UiAction = z.infer<typeof uiActionSchema>;
export const uiFormSchema = z
  .object({
    id,
    titleKey: key,
    fields: z.array(uiFieldSchema).max(64),
    action: uiActionSchema.optional(),
  })
  .strict();
export type UiForm = z.infer<typeof uiFormSchema>;
export const gameUiDescriptorSchema = z
  .object({
    gameId: id,
    schemaVersion: z.literal(1),
    nameKey: key,
    artwork: z.object({ assetId: id, altKey: key.optional() }).strict().optional(),
    creation: z
      .object({
        fields: z.array(uiFieldSchema).max(64),
        pages: z
          .array(
            z
              .object({
                id,
                titleKey: key,
                field: fieldId,
                kind: z.enum(['version-list', 'players', 'toggle-players']),
                lookupHandler: id.optional(),
                toggleField: fieldId.optional(),
                seedField: fieldId.optional(),
                requiredCapability: fieldId.optional(),
              })
              .strict(),
          )
          .max(16)
          .default([]),
        agreement: z
          .object({
            field: fieldId,
            textKey: key,
            linkKey: key,
            url: z.url().refine((v) => v.startsWith('https://')),
          })
          .strict()
          .optional(),
        resourcePresets: z
          .array(
            z
              .object({
                id,
                labelKey: key,
                memoryMiB: z.number().int().min(32),
                cpuPercent: z.number().int().min(1),
              })
              .strict(),
          )
          .max(8)
          .default([]),
        choicesHandler: id,
        createHandler: id,
        prepareHandler: id.optional(),
        defaults: z
          .record(fieldId, z.union([scalar, z.array(z.string().max(1024)).max(1000)]))
          .refine((value) => Object.keys(value).length <= 64)
          .default({}),
      })
      .strict(),
    sections: z
      .array(
        z
          .object({
            id,
            titleKey: key,
            loader: id,
            requiredPermissions: z
              .array(z.enum(['server:read', 'server:operate', 'server:manage', 'platform:manage']))
              .min(1)
              .max(4),
            requiredCapabilities: z.array(id).max(16),
            forms: z.array(uiFormSchema).max(32),
            columns: z
              .array(
                z
                  .object({
                    id: fieldId,
                    labelKey: key,
                    format: z.enum(['text', 'message', 'date']).default('text'),
                  })
                  .strict(),
              )
              .max(16)
              .default([]),
          })
          .strict(),
      )
      .max(32),
    ports: z
      .array(
        z
          .object({
            role: id,
            labelKey: key,
            transports: z
              .array(z.enum(['tcp', 'udp']))
              .min(1)
              .max(2),
            required: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    connectionModes: z
      .array(
        z.discriminatedUnion('mode', [
          z.object({ mode: z.literal('static-host-port'), showPort: z.literal(true) }).strict(),
          z
            .object({
              mode: z.literal('custom-subdomain'),
              srv: z
                .object({
                  service: z.string().regex(/^_[a-z0-9-]+$/),
                  transport: z.enum(['tcp', 'udp']),
                })
                .strict()
                .optional(),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(2),
  })
  .strict()
  .superRefine((d, context) => {
    const unique = (values: string[], path: (string | number)[]) => {
      if (new Set(values).size !== values.length)
        context.addIssue({ code: 'custom', path, message: 'duplicate_identifier' });
    };
    unique(
      d.sections.map((s) => s.id),
      ['sections'],
    );
    unique(
      d.ports.map((p) => p.role),
      ['ports'],
    );
    unique(
      d.connectionModes.map((m) => m.mode),
      ['connectionModes'],
    );
    for (const [index, p] of d.ports.entries())
      unique(p.transports, ['ports', index, 'transports']);
    const creationFields = new Set(d.creation.fields.map((f) => f.id));
    unique(
      d.creation.pages.map((p) => p.id),
      ['creation', 'pages'],
    );
    unique(
      d.creation.resourcePresets.map((p) => p.id),
      ['creation', 'resourcePresets'],
    );
    for (const page of d.creation.pages) {
      const field = d.creation.fields.find((f) => f.id === page.field);
      const toggle = d.creation.fields.find((f) => f.id === page.toggleField);
      const seed = d.creation.fields.find((f) => f.id === page.seedField);
      if (
        (page.kind === 'version-list' && field?.type !== 'choice') ||
        (page.kind !== 'version-list' &&
          (field?.type !== 'multi-text' || field.format !== 'player-name')) ||
        (page.kind === 'toggle-players' && toggle?.type !== 'boolean') ||
        (page.seedField && (seed?.type !== 'multi-text' || seed.format !== 'player-name'))
      )
        context.addIssue({ code: 'custom', message: 'invalid_page_field_type' });
      if (
        ![page.field, ...[page.toggleField, page.seedField].filter((v): v is string => !!v)].every(
          (f) => creationFields.has(f),
        )
      )
        context.addIssue({ code: 'custom', message: 'invalid_page_field' });
      if (
        (page.kind !== 'version-list' && !page.lookupHandler) ||
        (page.kind === 'toggle-players' && !page.toggleField)
      )
        context.addIssue({ code: 'custom', message: 'invalid_page_contract' });
    }
    if (d.creation.agreement && !creationFields.has(d.creation.agreement.field))
      context.addIssue({ code: 'custom', message: 'invalid_agreement_field' });
    const forms = [d.creation, ...d.sections.flatMap((s) => s.forms)];
    for (const [index, form] of forms.entries()) {
      unique(
        form.fields.map((f) => f.id),
        ['forms', index],
      );
      const fields = new Set(form.fields.map((f) => f.id));
      for (const field of form.fields) {
        const dependencies = [
          ...field.when.map((c) => c.field),
          ...(field.type === 'choice' ? (field.source?.dependsOn ?? []) : []),
        ];
        if (dependencies.some((ref) => ref === field.id || !fields.has(ref)))
          context.addIssue({ code: 'custom', message: 'invalid_field_dependency' });
        if (
          (field.type === 'number' && field.min > field.max) ||
          ((field.type === 'text' || field.type === 'textarea') &&
            field.minLength > field.maxLength)
        )
          context.addIssue({ code: 'custom', message: 'invalid_field_bounds' });
        if (field.type === 'choice')
          unique(
            field.options.map((o) => o.value),
            ['forms', index, field.id],
          );
      }
    }
    for (const section of d.sections)
      unique(
        section.forms.map((f) => f.id),
        ['sections', section.id],
      );
    const walk = (v: unknown, field?: string): void => {
      if (typeof v === 'string' && field?.endsWith('Key') && !v.startsWith(`games.${d.gameId}.`))
        context.addIssue({ code: 'custom', message: 'invalid_translation_namespace' });
      else if (Array.isArray(v))
        v.forEach((item) => {
          walk(item);
        });
      else if (v && typeof v === 'object')
        Object.entries(v).forEach(([k, value]) => {
          walk(value, k);
        });
    };
    walk(d);
  });
export type GameUiDescriptor = z.infer<typeof gameUiDescriptorSchema>;

export function fieldVisible(field: UiField, values: UiValues): boolean {
  return field.when.every((c) => {
    const value = Object.hasOwn(values, c.field) ? values[c.field] : undefined;
    if (c.operator === 'present') return value !== undefined && value !== null && value !== '';
    if (c.operator === 'not-equals') return value !== undefined && value !== c.values[0];
    return c.values.some((expected) => expected === value);
  });
}
export function visibleFields(fields: readonly UiField[], values: UiValues): UiField[] {
  return fields.filter((field) => fieldVisible(field, values));
}
export interface UiFieldError {
  field: string;
  code: 'required' | 'invalid' | 'unavailable';
}
/** Choices are evidence-filtered server results, not locally invented runtime support. */
export function validateUiValues(
  fields: readonly UiField[],
  values: UiValues,
  choices: Readonly<Record<string, readonly UiOption[]>> = {},
): UiFieldError[] {
  const errors: UiFieldError[] = [];
  for (const field of visibleFields(fields, values)) {
    const value = Object.hasOwn(values, field.id) ? values[field.id] : undefined;
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && !value.length && field.type !== 'preview')
    ) {
      if (field.required) errors.push({ field: field.id, code: 'required' });
      continue;
    }
    let valid = true;
    const textValid = (text: unknown, maximum: number, format: string) =>
      typeof text === 'string' &&
      text.length <= maximum &&
      !text.includes('\0') &&
      (format !== 'player-name' || /^[A-Za-z0-9_]{3,16}$/.test(text)) &&
      (format !== 'world-name' || /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(text)) &&
      (format !== 'uuid' || z.uuid().safeParse(text).success);
    switch (field.type) {
      case 'text':
      case 'textarea':
        valid =
          textValid(value, field.maxLength, field.format) &&
          (value as string).length >= field.minLength;
        break;
      case 'multi-text':
        valid =
          Array.isArray(value) &&
          value.length <= field.maxItems &&
          value.every((v) => textValid(v, field.maxLength, field.format));
        break;
      case 'number':
        valid =
          typeof value === 'number' &&
          Number.isFinite(value) &&
          (!field.integer || Number.isSafeInteger(value)) &&
          value >= field.min &&
          value <= field.max;
        break;
      case 'boolean':
        valid = typeof value === 'boolean' && (!field.mustBeTrue || value);
        break;
      case 'choice': {
        const options = field.source ? choices[field.id] : field.options;
        if (!options?.some((o) => o.value === value && !o.disabled)) {
          errors.push({ field: field.id, code: 'unavailable' });
          continue;
        }
        break;
      }
      case 'preview':
        valid =
          Array.isArray(value) &&
          value.length <= field.maxItems &&
          value.every((v) => typeof v === 'string' && v.length <= 1024);
        break;
      case 'archive':
        valid = typeof value === 'string' && z.uuid().safeParse(value).success;
        break;
      case 'file':
        valid = typeof Blob !== 'undefined' && value instanceof Blob && value.size > 0;
        break;
    }
    if (!valid) errors.push({ field: field.id, code: 'invalid' });
  }
  return errors;
}
export interface UiAccessContext {
  /** Effective authority supplied by the authorized server API. Never inferred from capabilities. */
  permissions: readonly string[];
  capabilities: readonly string[];
  rolloutAllowed: boolean;
  runtimeVerified: boolean;
  providerConfigured: boolean;
  state: string;
}
export type UiAvailability =
  | { enabled: true }
  | { enabled: false; reason: 'forbidden' | 'unsupported' | 'unavailable' | 'requires-stopped' };
export function actionAvailability(
  action: Pick<UiAction, 'requiredPermissions' | 'requiredCapabilities'> & {
    requiresStopped?: boolean;
  },
  context: UiAccessContext,
): UiAvailability {
  if (!action.requiredPermissions.every((p) => context.permissions.includes(p)))
    return { enabled: false, reason: 'forbidden' };
  if (!action.requiredCapabilities.every((c) => context.capabilities.includes(c)))
    return { enabled: false, reason: 'unsupported' };
  if (!context.rolloutAllowed || !context.runtimeVerified || !context.providerConfigured)
    return { enabled: false, reason: 'unavailable' };
  if (action.requiresStopped && context.state !== 'offline')
    return { enabled: false, reason: 'requires-stopped' };
  return { enabled: true };
}
export interface GameUiClient {
  /** Same-origin application client owns cookies, CSRF, support context, errors and cancellation. */
  request(
    path: string,
    options?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; signal?: AbortSignal },
  ): Promise<unknown>;
  upload?(
    path: string,
    body: Blob,
    options: {
      bytes: number;
      signal?: AbortSignal;
      onProgress?: (sent: number, total: number) => void;
    },
  ): Promise<unknown>;
}
export interface GameUiContext {
  serverId?: string;
  signal?: AbortSignal;
  values: UiValues;
  idempotencyKey?: string;
}
export type GameUiHandler = (client: GameUiClient, context: GameUiContext) => Promise<unknown>;
export interface TrustedGameUiModule {
  descriptor: GameUiDescriptor;
  catalogs: { en: Readonly<Record<string, string>>; it: Readonly<Record<string, string>> };
  handlers: Readonly<Record<string, GameUiHandler>>;
  /** Bundled first-party assets only; never supplied by the API descriptor. */
  assets?: Readonly<Record<string, string>>;
  /** Trusted integration owns avatar provider and bundled fallback; never API-supplied URLs. */
  playerAppearance?: { fallback: string; avatarUrl(name: string): string };
}
/** Call only with imports compiled into the application. API JSON cannot register executable modules. */
export function defineTrustedGameUiModule(module: TrustedGameUiModule): TrustedGameUiModule {
  const descriptor = gameUiDescriptorSchema.parse(module.descriptor);
  if (descriptor.artwork && !module.assets?.[descriptor.artwork.assetId])
    throw new Error('game_ui_asset_missing');
  const handlerIds = [
    ...descriptor.creation.pages.flatMap((p) => (p.lookupHandler ? [p.lookupHandler] : [])),
    ...[descriptor.creation, ...descriptor.sections.flatMap((s) => s.forms)].flatMap((f) =>
      f.fields.flatMap((v) =>
        v.type === 'archive'
          ? [v.handler, ...(v.catalog ? Object.values(v.catalog) : [])]
          : v.type === 'preview'
            ? [v.handler]
            : [],
      ),
    ),
    ...[descriptor.creation, ...descriptor.sections.flatMap((s) => s.forms)].flatMap((f) =>
      f.fields.flatMap((v) =>
        (v.type === 'text' || v.type === 'textarea') && v.lookupHandler ? [v.lookupHandler] : [],
      ),
    ),
    descriptor.creation.choicesHandler,
    descriptor.creation.createHandler,
    ...(descriptor.creation.prepareHandler ? [descriptor.creation.prepareHandler] : []),
    ...descriptor.sections.flatMap((s) => [
      s.loader,
      ...s.forms.flatMap((f) => (f.action ? [f.action.handler] : [])),
    ]),
    ...[descriptor.creation, ...descriptor.sections.flatMap((s) => s.forms)].flatMap((f) =>
      f.fields.flatMap((v) => (v.type === 'choice' && v.source ? [v.source.handler] : [])),
    ),
  ];
  for (const handler of handlerIds)
    if (!Object.hasOwn(module.handlers, handler) || typeof module.handlers[handler] !== 'function')
      throw new Error('game_ui_handler_missing');
  const keys = new Set<string>();
  const walk = (value: unknown, name?: string): void => {
    if (typeof value === 'string' && name?.endsWith('Key')) keys.add(value);
    else if (Array.isArray(value))
      value.forEach((v) => {
        walk(v);
      });
    else if (value && typeof value === 'object')
      Object.entries(value).forEach(([k, v]) => {
        walk(v, k);
      });
  };
  walk(descriptor);
  for (const locale of ['en', 'it'] as const)
    for (const k of keys)
      if (!module.catalogs[locale][k]?.trim()) throw new Error('game_ui_translation_missing');
  return Object.freeze({
    descriptor: deepFreeze(descriptor),
    catalogs: deepFreeze({ en: { ...module.catalogs.en }, it: { ...module.catalogs.it } }),
    handlers: Object.freeze({ ...module.handlers }),
    assets: Object.freeze({ ...module.assets }),
    ...(module.playerAppearance
      ? { playerAppearance: Object.freeze({ ...module.playerAppearance }) }
      : {}),
  });
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}
export function createTrustedGameUiRegistry(modules: readonly TrustedGameUiModule[]) {
  const registry = new Map<string, TrustedGameUiModule>();
  for (const raw of modules) {
    const module = defineTrustedGameUiModule(raw);
    if (registry.has(module.descriptor.gameId)) throw new Error('game_ui_duplicate_module');
    registry.set(module.descriptor.gameId, module);
  }
  return Object.freeze({
    get: (gameId: string) => registry.get(gameId),
    list: () => [...registry.values()],
  });
}

export interface UiSectionData {
  values: UiValues;
  rows: Readonly<Record<string, unknown>>[];
  fieldChoices?: Readonly<Record<string, readonly UiOption[]>>;
  /** When supplied, only these field IDs may be edited (e.g. a verified game-property schema). */
  editableFields?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}
