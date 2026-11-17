import type { SaveHeader } from './save-header.js';

export const saveMetadataFields = [
  'sessionName',
  'saveName',
  'mapName',
  'savedAt',
  'playDurationSeconds',
  'buildVersion',
  'saveVersion',
] as const;
export type SaveMetadataField = (typeof saveMetadataFields)[number];
export const saveMetadataLabels: Record<SaveMetadataField, string> = {
  sessionName: 'session',
  saveName: 'save',
  mapName: 'map',
  savedAt: 'savedAt',
  playDurationSeconds: 'duration',
  buildVersion: 'build',
  saveVersion: 'format',
};
export function saveMetadataValue(header: SaveHeader, field: SaveMetadataField, filename: string) {
  return field === 'saveName' ? (header.saveName ?? filename) : header[field];
}
export function formatSaveMetadataValue(
  value: string | number,
  field: SaveMetadataField,
  locale: string | undefined,
) {
  if (field === 'savedAt')
    return new Date(String(value)).toLocaleString(locale === 'it' ? 'it-IT' : 'en-GB');
  if (field === 'playDurationSeconds') {
    const seconds = Number(value);
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return String(value);
}
