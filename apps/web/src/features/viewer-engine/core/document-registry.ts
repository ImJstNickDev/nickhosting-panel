import type { ViewerId } from './registry.js';

/** Compiled document capabilities, not a grant of file-write permission. */
export interface DocumentViewDefinition {
  id: ViewerId;
  label: string;
  extensions: readonly string[];
}
export const documentViewDefinitions: readonly DocumentViewDefinition[] = Object.freeze([
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
