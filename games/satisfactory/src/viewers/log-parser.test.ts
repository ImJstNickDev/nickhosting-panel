import { expect, it } from 'vitest';
import { filterLog, parseLog } from './log-parser.js';

const bytes = (value: string) => new TextEncoder().encode(value);
it('preserves multiline log text and classifies Unreal severity', () => {
  const rows = parseLog(
    bytes('LogInit: Display: Ready\r\nLogNet: Warning: Retry\nLogCore: Fatal: crash\n'),
  );
  expect(rows.map((x) => x.level)).toEqual(['info', 'warning', 'error']);
  expect(filterLog(rows, 'retry', 'warning')).toHaveLength(1);
  expect(filterLog(rows, 'retry', 'error')).toHaveLength(0);
});
it('drops only incomplete tail fragments and never interprets markup', () => {
  expect(parseLog(bytes('partial\n<script>text</script>\n'), true).map((x) => x.text)).toEqual([
    '<script>text</script>',
  ]);
  expect(parseLog(bytes('partial'), true)).toEqual([]);
  expect(parseLog(bytes(''))).toEqual([]);
});
it('bounds input and rejects binary logs', () => {
  expect(() => parseLog(new Uint8Array(65537))).toThrow('log_too_large');
  expect(() => parseLog(bytes('a\0b'))).toThrow('log_binary');
});
