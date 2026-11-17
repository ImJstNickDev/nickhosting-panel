/** Source inspection only: never combines the Unreal configuration hierarchy. */
export const iniReadLimit = 65_536;
export type IniOperation = 'set' | 'append' | 'duplicate' | 'remove' | 'clear';
export type IniLine = {
  line: number;
  raw: string;
  section: string | null;
} & (
  | { kind: 'section'; name: string }
  | { kind: 'entry'; key: string; value: string; operator: string; operation: IniOperation }
  | { kind: 'comment' | 'blank' | 'unrecognized' }
);
const operations: Record<string, IniOperation> = {
  '+': 'append',
  '.': 'duplicate',
  '-': 'remove',
  '!': 'clear',
};

export function parseIni(bytes: Uint8Array): IniLine[] {
  if (bytes.byteLength >= iniReadLimit) throw new Error('ini_too_large');
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? 'utf-16le'
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? 'utf-16be'
        : 'utf-8';
  const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('ini_invalid_encoding');
  if (!text) return [];
  const lines = text.split(/\r\n|\n|\r/);
  // A terminal newline terminates the final line; it is not an extra blank record.
  if (lines.at(-1) === '') lines.pop();
  let section: string | null = null;
  return lines.map((raw, index): IniLine => {
    const trimmed = raw.trim();
    const base = { line: index + 1, raw, section };
    if (!trimmed) return { ...base, kind: 'blank' };
    if (trimmed.startsWith(';')) return { ...base, kind: 'comment' };
    const header = /^\[([^\]\r\n]+)\]$/.exec(trimmed);
    if (header?.[1]) {
      section = header[1];
      return { ...base, section, kind: 'section', name: section };
    }
    const equals = raw.indexOf('=');
    if (equals <= 0 || section === null) return { ...base, kind: 'unrecognized' };
    const fullKey = raw.slice(0, equals).trim();
    const prefix = fullKey[0] ?? '';
    const operator = Object.hasOwn(operations, prefix) ? prefix : '';
    const key = (operator ? fullKey.slice(1) : fullKey).trim();
    if (!key || key.startsWith('[')) return { ...base, kind: 'unrecognized' };
    return {
      ...base,
      kind: 'entry',
      key,
      // Preserve quoted strings, whitespace, structs, semicolons and further '='.
      value: raw.slice(equals + 1),
      operator,
      operation: operations[operator] ?? 'set',
    };
  });
}
