import { z } from 'zod';

/** Stable presentation surfaces; changing a surface never grants a filesystem capability. */
export const filemanSlotSchema = z.enum([
  'toolbar',
  'breadcrumb',
  'search',
  'view-toggle',
  'selection',
  'listing',
  'entry.name',
  'entry.icon',
  'entry.metadata',
  'entry.actions',
  'context-menu',
  'viewer.content',
  'viewer.actions',
  'viewer.download',
]);
export type FilemanSlotName = z.infer<typeof filemanSlotSchema>;
export const filemanExtensionDescriptorSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/),
    gameId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .optional(),
    priority: z.number().int().min(-100).max(100).default(0),
  })
  .superRefine((value, context) => {
    if (!value.id.startsWith(`${value.gameId ?? 'builtin'}:`))
      context.addIssue({
        code: 'custom',
        message: 'Fileman extension namespace does not match its integration.',
      });
  });
export interface FilemanContext {
  readonly serverId: string;
  readonly gameId?: string;
  readonly path: string;
  readonly surface: 'directory' | 'viewer';
  readonly viewerId?: string;
  readonly readOnly: boolean;
  readonly entry?: { readonly name: string; readonly directory: boolean; readonly size: number };
}
export interface FilemanPatch<T> {
  readonly slot: FilemanSlotName;
  readonly mode: 'hide' | 'replace' | 'prepend' | 'append' | 'decorate';
  readonly when?: (context: Readonly<FilemanContext>) => boolean;
  /** Decorators receive the original presentation; do not issue I/O during rendering. */
  readonly render?: (context: Readonly<FilemanContext>, current: T | null) => T;
}
export interface TrustedFilemanExtension<T> {
  readonly descriptor: Readonly<z.output<typeof filemanExtensionDescriptorSchema>>;
  readonly patches: readonly FilemanPatch<T>[];
}
/** Executable contributions come only from statically imported, reviewed first-party modules. */
export function defineTrustedFilemanExtension<T>(
  descriptor: z.input<typeof filemanExtensionDescriptorSchema>,
  patches: readonly FilemanPatch<T>[],
): TrustedFilemanExtension<T> {
  const parsed = filemanExtensionDescriptorSchema.parse(descriptor);
  const modes = ['hide', 'replace', 'prepend', 'append', 'decorate'];
  for (const patch of patches) {
    filemanSlotSchema.parse(patch.slot);
    if (
      !modes.includes(patch.mode) ||
      (patch.mode !== 'hide' && typeof patch.render !== 'function') ||
      (patch.when !== undefined && typeof patch.when !== 'function')
    )
      throw new TypeError('A compiled Fileman contribution is required.');
  }
  return Object.freeze({
    descriptor: Object.freeze(parsed),
    patches: Object.freeze(patches.map((patch) => Object.freeze({ ...patch }))),
  });
}

export function createFilemanExtensionHost<T>(extensions: readonly TrustedFilemanExtension<T>[]) {
  const registered = extensions.map((extension) =>
    defineTrustedFilemanExtension(extension.descriptor, extension.patches),
  );
  const ids = new Set<string>();
  for (const extension of registered) {
    if (ids.has(extension.descriptor.id)) throw new TypeError('Duplicate Fileman extension.');
    ids.add(extension.descriptor.id);
  }
  registered.sort(
    (a, b) =>
      a.descriptor.priority - b.descriptor.priority ||
      a.descriptor.id.localeCompare(b.descriptor.id),
  );
  const bySlot = new Map<FilemanSlotName, { gameId?: string; patch: FilemanPatch<T> }[]>();
  for (const extension of registered)
    for (const patch of extension.patches) {
      const entries = bySlot.get(patch.slot) ?? [];
      entries.push({ gameId: extension.descriptor.gameId, patch });
      bySlot.set(patch.slot, entries);
    }
  return {
    render(
      slot: FilemanSlotName,
      context: Readonly<FilemanContext>,
      original: T | null,
      join: (parts: readonly (T | null)[]) => T,
    ): T | null {
      const candidates = bySlot.get(slot);
      if (!candidates) return original;
      const patches = candidates
        .filter(
          ({ gameId, patch }) =>
            (!gameId || gameId === context.gameId) && (!patch.when || patch.when(context)),
        )
        .map(({ patch }) => patch);
      const exclusive = patches.filter(
        (patch) => patch.mode === 'replace' || patch.mode === 'hide',
      );
      if (exclusive.length > 1)
        throw new TypeError(`Conflicting Fileman replacements for ${slot}.`);
      if (exclusive[0]?.mode === 'hide') return null;
      let current = exclusive[0]?.render ? exclusive[0].render(context, original) : original;
      for (const patch of patches) {
        if (patch.mode === 'replace' || patch.mode === 'hide' || !patch.render) continue;
        const rendered = patch.render(context, current);
        current =
          patch.mode === 'prepend'
            ? join([rendered, current])
            : patch.mode === 'append'
              ? join([current, rendered])
              : rendered;
      }
      return current;
    },
  };
}
