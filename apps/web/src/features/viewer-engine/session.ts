import { normalizeFilePath } from '../file-manager-model.js';
import type { ViewerId } from './core/registry.js';

export interface ViewerBookmark {
  path: string;
  viewerId: ViewerId;
  autoDecodeCompressed?: boolean;
}

/** Tab-local navigation metadata only: never content, credentials or signed URLs. */
export function readViewerBookmark(key: string | undefined): ViewerBookmark | undefined {
  if (!key) return;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw || raw.length > 4096) return;
    const value = JSON.parse(raw);
    if (
      typeof value?.path !== 'string' ||
      !value.path ||
      normalizeFilePath(value.path) === undefined ||
      typeof value.viewerId !== 'string' ||
      value.viewerId.length > 128 ||
      (value.autoDecodeCompressed !== undefined && typeof value.autoDecodeCompressed !== 'boolean')
    )
      return;
    return {
      path: value.path,
      viewerId: value.viewerId as ViewerId,
      ...(value.autoDecodeCompressed !== undefined
        ? { autoDecodeCompressed: value.autoDecodeCompressed }
        : {}),
    };
  } catch {
    // Optional browser storage must not prevent opening files.
  }
}

export function writeViewerBookmark(key: string | undefined, value?: ViewerBookmark) {
  if (!key) return;
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    // Navigation remains available when storage is disabled or full.
  }
}
