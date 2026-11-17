export const logReadLimit = 65536;
export type LogLevel = 'error' | 'warning' | 'info';
export interface LogLine {
  index: number;
  text: string;
  level: LogLevel;
}
export function parseLog(bytes: Uint8Array, truncated = false): LogLine[] {
  if (bytes.length > logReadLimit) throw new Error('log_too_large');
  let text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('\0')) throw new Error('log_binary');
  // A tail can begin inside a UTF-8 sequence or a line; omit that fragment.
  if (truncated) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : '';
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((text, index) => ({
    index,
    text,
    level: /\b(?:error|fatal)\b/i.test(text)
      ? 'error'
      : /\bwarning\b/i.test(text)
        ? 'warning'
        : 'info',
  }));
}
export function filterLog(lines: LogLine[], query: string, level: string) {
  const needle = query.toLocaleLowerCase();
  return lines.filter(
    (line) =>
      (level === 'all' || line.level === level) && line.text.toLocaleLowerCase().includes(needle),
  );
}
