/** Header layout: FGSaveManagerInterface version enum and satisfactory-file-parser
 * https://github.com/etothepii4/satisfactory-file-parser/blob/main/
 * src/parser/satisfactory/save/satisfactory-save-header.ts. Reads metadata only;
 * compressed world payloads are never decoded. */
export const saveHeaderReadLimit = 64 * 1024;
export interface SaveHeader {
  headerVersion: number;
  saveVersion: number;
  buildVersion: number;
  saveName?: string;
  mapName: string;
  sessionName: string;
  playDurationSeconds: number;
  savedAt: string;
}
export function parseSaveHeader(bytes: Uint8Array): SaveHeader {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const require = (count: number) => {
    if (count < 0 || offset + count > bytes.length || offset + count > saveHeaderReadLimit)
      throw new Error('invalid_save_header');
  };
  const int = () => {
    require(4);
    const value = view.getInt32(offset, true);
    offset += 4;
    return value;
  };
  const string = () => {
    const length = int();
    if (length === 0) return '';
    const count = Math.abs(length) * (length < 0 ? 2 : 1);
    require(count);
    const end = offset + count;
    const terminator = length < 0 ? view.getUint16(end - 2, true) : view.getUint8(end - 1);
    if (terminator !== 0) throw new Error('invalid_save_header');
    const value = new TextDecoder(length < 0 ? 'utf-16le' : 'utf-8', { fatal: true }).decode(
      bytes.subarray(offset, end - (length < 0 ? 2 : 1)),
    );
    offset = end;
    return value;
  };
  const headerVersion = int();
  if (headerVersion < 6 || headerVersion > 14) throw new Error('unsupported_save_header');
  const saveVersion = int(),
    buildVersion = int();
  if (saveVersion < 0 || buildVersion < 0) throw new Error('invalid_save_header');
  const saveName = headerVersion >= 14 ? string() : undefined;
  const mapName = string();
  string(); // Native map options are not exposed: they can contain connection data.
  const sessionName = string();
  const playDurationSeconds = int();
  require(9);
  const milliseconds = Number((view.getBigInt64(offset, true) - 621355968000000000n) / 10000n);
  offset += 9; // Timestamp and visibility.
  if (
    playDurationSeconds < 0 ||
    !Number.isSafeInteger(milliseconds) ||
    Math.abs(milliseconds) > 8640000000000000
  )
    throw new Error('invalid_save_header');
  return {
    headerVersion,
    saveVersion,
    buildVersion,
    ...(saveName ? { saveName } : {}),
    mapName,
    sessionName,
    playDurationSeconds,
    savedAt: new Date(milliseconds).toISOString(),
  };
}

const parsedHeaders = new WeakMap<Uint8Array, Readonly<SaveHeader>>();
/** Prefix cache owns the bounded lifetime; no second persistent metadata store. */
export function cachedParseSaveHeader(bytes: Uint8Array): Readonly<SaveHeader> {
  let header = parsedHeaders.get(bytes);
  if (!header) {
    header = Object.freeze(parseSaveHeader(bytes));
    parsedHeaders.set(bytes, header);
  }
  return header;
}
