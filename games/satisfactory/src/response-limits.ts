/** Save enumeration can contain many native headers; ordinary status replies remain small. */
export const satisfactoryEnumerationMaxBytes = 16 * 1024 * 1024;
export function satisfactoryResponseMaxBytes(operation?: string): number {
  return operation === 'EnumerateSessions' ? satisfactoryEnumerationMaxBytes : 64 * 1024;
}
