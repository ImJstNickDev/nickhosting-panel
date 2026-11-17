import type { GameViewerLogPage } from '@nickhosting/game-sdk/ui';

export const logPageSize = 200;
export const logWindowSize = 600;
/** Merge only adjacent pages from the same immutable snapshot, retaining a bounded DOM window. */
export function extendLogWindow(
  current: GameViewerLogPage,
  next: GameViewerLogPage,
  direction: 'before' | 'after',
): GameViewerLogPage {
  if (current.revision !== next.revision) return next;
  if (direction === 'before') {
    if (next.offset + next.rows.length !== current.offset) return next;
    return { ...next, rows: [...next.rows, ...current.rows].slice(0, logWindowSize) };
  }
  if (current.offset + current.rows.length !== next.offset) return next;
  const rows = [...current.rows, ...next.rows];
  const removed = Math.max(0, rows.length - logWindowSize);
  return { ...next, offset: current.offset + removed, rows: rows.slice(removed) };
}
