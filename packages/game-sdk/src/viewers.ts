import { z } from 'zod';

/** One source namespace shared by builtin and integration-owned viewers. */
export interface GameViewerSource {
  path: string;
  name: string;
  size: number;
  /** A member of the archive at path, never a physical server path. */
  entry?: string;
  /** Ordered archive members, relative to their containing archive. */
  archives?: string[];
  gameId?: string;
  fragment?: string;
}
export interface GameViewerArchiveEntry {
  name: string;
  path: string;
  directory: boolean;
  size: number;
}
export interface GameViewerHost {
  t(key: string, values?: Record<string, string | number>): string;
  /** Bounded reads of the currently selected container; authority stays with Fileman. */
  archive: {
    /** One metadata page. total may exceed entries.length; query narrows the indexed names. */
    list(
      directory: string,
      signal: AbortSignal,
      query?: string,
    ): Promise<{ entries: GameViewerArchiveEntry[]; total: number }>;
    read(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>>;
  };
  /** Only a compiled viewer available to this game can be selected. */
  openViewer(id: string): void;
}
export interface GameViewerProps {
  source: GameViewerSource;
  host: GameViewerHost;
}

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
  /** Suggestion only: explicit Open With choices and personal defaults take precedence. */
  matches?: (source: Readonly<GameViewerSource>) => boolean;
}

/** Called by statically imported first-party modules. Serialized API descriptors cannot load code. */
export function defineTrustedGameViewer<T>(
  descriptor: GameViewerDescriptor,
  load: () => Promise<T>,
  matches?: (source: Readonly<GameViewerSource>) => boolean,
): TrustedGameViewer<T> {
  if (typeof load !== 'function') throw new TypeError('A compiled viewer loader is required.');
  if (matches !== undefined && typeof matches !== 'function')
    throw new TypeError('A compiled viewer match function is required.');
  const parsed = gameViewerDescriptorSchema.parse(descriptor);
  return Object.freeze({
    descriptor: Object.freeze({
      ...parsed,
      extensions: Object.freeze([...new Set(parsed.extensions)]),
    }),
    load,
    ...(matches ? { matches } : {}),
  });
}
export function createTrustedViewerRegistry<T>(viewers: readonly TrustedGameViewer<T>[]) {
  const modules = new Map<string, TrustedGameViewer<T>>();
  for (const viewer of viewers) {
    const parsed = gameViewerDescriptorSchema.parse(viewer.descriptor);
    if (
      modules.has(parsed.id) ||
      typeof viewer.load !== 'function' ||
      (viewer.matches !== undefined && typeof viewer.matches !== 'function')
    )
      throw new TypeError('Duplicate or untrusted viewer module.');
    modules.set(parsed.id, viewer);
  }
  const forGame = (gameId: string | undefined) =>
    [...modules.values()].filter((viewer) => viewer.descriptor.gameId === gameId);
  return {
    all: () => [...modules.values()],
    forGame,
    forFile: (gameId: string | undefined, extension: string) =>
      forGame(gameId).filter((viewer) =>
        viewer.descriptor.extensions.includes(extension.toLowerCase()),
      ),
    get: (id: string) => modules.get(id),
  };
}
