import { z } from 'zod';

export const gameViewerDescriptorSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,63}:[a-z][a-z0-9-]{0,63}$/),
    gameId: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
    labelKey: z.string().max(180),
    extensions: z
      .array(
        z
          .string()
          .regex(/^[a-z0-9]+(?:\.[a-z0-9]+)*$/)
          .max(32),
      )
      .min(1)
      .max(64),
    readOnly: z.boolean(),
  })
  .superRefine((value, context) => {
    if (
      !value.id.startsWith(`${value.gameId}:`) ||
      !value.labelKey.startsWith(`games.${value.gameId}.viewers.`)
    )
      context.addIssue({
        code: 'custom',
        message: 'Viewer identifiers and translations must belong to the integration.',
      });
  });
export type GameViewerDescriptor = z.infer<typeof gameViewerDescriptorSchema>;
export interface TrustedGameViewer<T> {
  descriptor: Readonly<Omit<GameViewerDescriptor, 'extensions'>> & {
    readonly extensions: readonly string[];
  };
  load: () => Promise<T>;
}

/** Called by statically imported first-party modules. Serialized API descriptors cannot load code. */
export function defineTrustedGameViewer<T>(
  descriptor: GameViewerDescriptor,
  load: () => Promise<T>,
): TrustedGameViewer<T> {
  if (typeof load !== 'function') throw new TypeError('A compiled viewer loader is required.');
  const parsed = gameViewerDescriptorSchema.parse(descriptor);
  return Object.freeze({
    descriptor: Object.freeze({
      ...parsed,
      extensions: Object.freeze([...new Set(parsed.extensions)]),
    }),
    load,
  });
}
export function createTrustedViewerRegistry<T>(viewers: readonly TrustedGameViewer<T>[]) {
  const modules = new Map<string, TrustedGameViewer<T>>();
  for (const viewer of viewers) {
    const parsed = gameViewerDescriptorSchema.parse(viewer.descriptor);
    if (modules.has(parsed.id) || typeof viewer.load !== 'function')
      throw new TypeError('Duplicate or untrusted viewer module.');
    modules.set(parsed.id, viewer);
  }
  return {
    forFile: (gameId: string | undefined, extension: string) =>
      [...modules.values()].filter(
        (viewer) =>
          viewer.descriptor.gameId === gameId &&
          viewer.descriptor.extensions.includes(extension.toLowerCase()),
      ),
    get: (id: string) => modules.get(id),
  };
}
