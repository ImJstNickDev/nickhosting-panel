import { fileEditorAvailability } from '../../../../../../packages/core/src/file-content.js';
import type { ViewerId } from './registry.js';

/** Compiled document capabilities, not a grant of file-write permission. */
export interface DocumentViewDefinition {
  id: ViewerId;
  label: string;
  extensions: readonly string[];
  /** The independent viewer can still handle sources beyond the shared editor budget. */
  standalone?: boolean;
}
export const documentViewDefinitions: readonly DocumentViewDefinition[] = Object.freeze([
  Object.freeze({
    id: 'json' as const,
    label: 'viewer.name.json',
    extensions: ['json', 'jsonc', 'json5'],
    standalone: true,
  }),
  Object.freeze({ id: 'sqlite' as const, label: 'viewer.name.sqlite', extensions: ['csv', 'tsv'] }),
]);
export function documentViews(path: string): readonly DocumentViewDefinition[] {
  const extension = path.split('.').at(-1)?.toLowerCase();
  return documentViewDefinitions.filter((definition) =>
    definition.extensions.includes(extension ?? ''),
  );
}
export function isDocumentView(path: string, id: ViewerId | undefined) {
  return id === 'text' || documentViews(path).some((definition) => definition.id === id);
}

/** Share only sources that Scribe can open; keep standalone viewers available above this bound. */
export function canUseDocumentView(
  source: { name: string; size: number },
  id: ViewerId | undefined,
) {
  return (
    isDocumentView(source.name, id) &&
    fileEditorAvailability({ ...source, is_file: true }) === 'text'
  );
}
