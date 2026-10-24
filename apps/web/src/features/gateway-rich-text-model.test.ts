import { describe, expect, it } from 'vitest';
import type { MessageChannel } from './gateway-message-preview.js';
import {
  deleteRichMessage,
  insertRichMessageToken,
  replaceRichMessage,
  richMessageParts,
  richMessageSelection,
} from './gateway-rich-text-model.js';

const label = { en: 'Message', it: 'Messaggio' };
const channel: MessageChannel = {
  id: 'message',
  label,
  maxLength: 512,
  multiline: true,
  formatting: {
    caseInsensitive: true,
    tokens: [
      { value: '§c', label, reset: true, style: { color: '#ff5555' } },
      { value: '§a', label, reset: true, style: { color: '#55ff55' } },
      { value: '§l', label, style: { bold: true } },
      { value: '§r', label, reset: true },
    ],
  },
};
const variables = { server: 'My server', eta: '' };

describe('inline gateway message source model', () => {
  it('preserves exact source including case, unknown tokens and trailing formatting', () => {
    const source = '§CHello {server}\n§lÈ pronto 🚀 §x {unknown}§r';
    const parts = richMessageParts(source, channel, variables);
    expect(parts.map((part) => part.source).join('')).toBe(source);
    expect(
      parts
        .filter((part) => part.kind !== 'format')
        .map((part) => part.text)
        .join(''),
    ).toBe('Hello My server\nÈ pronto 🚀 §x {unknown}');
    expect(parts.find((part) => part.kind === 'variable')?.style).toEqual({ color: '#ff5555' });
    expect(parts.at(-2)?.style).toEqual({ color: '#ff5555', bold: true });
  });

  it('does not parse substituted variables as editable formatting or HTML', () => {
    const parts = richMessageParts('{server} {eta}', channel, { server: '<img src=x>§l', eta: '' });
    expect(parts[0]).toMatchObject({
      kind: 'variable',
      source: '{server}',
      text: '<img src=x>§l',
      style: {},
    });
    expect(parts.at(-1)).toMatchObject({ kind: 'variable', text: '{eta}' });
  });

  it('atomically replaces and deletes variables even from an interior source offset', () => {
    expect(replaceRichMessage('A{server}B', { start: 3, end: 5 }, 'X', channel, variables)).toEqual(
      { value: 'AXB', selection: { start: 2, end: 2 } },
    );
    expect(
      deleteRichMessage('A{server}B', { start: 9, end: 9 }, 'backward', channel, variables)?.value,
    ).toBe('AB');
    expect(
      deleteRichMessage('A{server}B', { start: 1, end: 1 }, 'forward', channel, variables)?.value,
    ).toBe('AB');
  });

  it('applies a selection style and restores the old style for following text', () => {
    const edit = insertRichMessageToken(
      '§aone two',
      { start: 2, end: 5 },
      '§c',
      channel,
      variables,
    );
    expect(edit).toEqual({ value: '§a§cone§r§a two', selection: { start: 4, end: 7 } });
    const text = richMessageParts(edit?.value ?? '', channel, variables).filter(
      (part) => part.kind === 'text',
    );
    expect(text.map((part) => [part.text, part.style.color])).toEqual([
      ['one', '#ff5555'],
      [' two', '#55ff55'],
    ]);
  });

  it('applies color across embedded colors without losing unrelated bold or affecting the suffix', () => {
    const source = '§lone §atwo§r three tail';
    const end = source.indexOf(' tail');
    const edit = insertRichMessageToken(source, { start: 2, end }, '§c', channel, variables);
    expect(edit).toBeDefined();
    const text = richMessageParts(edit?.value ?? '', channel, variables).filter(
      (part) => part.kind === 'text',
    );
    expect(text.map((part) => [part.text, part.style])).toEqual([
      ['one ', { color: '#ff5555', bold: true }],
      ['two', { color: '#ff5555' }],
      [' three', { color: '#ff5555' }],
      [' tail', {}],
    ]);
  });

  it('keeps a selected decoration after embedded resets and colors, and reset clears every selected run', () => {
    const source = 'one §atwo§r three tail';
    const end = source.indexOf(' tail');
    const bold = insertRichMessageToken(source, { start: 0, end }, '§l', channel, variables);
    const text = richMessageParts(bold?.value ?? '', channel, variables).filter(
      (part) => part.kind === 'text',
    );
    expect(text.map((part) => [part.text, part.style])).toEqual([
      ['one ', { bold: true }],
      ['two', { color: '#55ff55', bold: true }],
      [' three', { bold: true }],
      [' tail', {}],
    ]);
    const cleared = insertRichMessageToken(source, { start: 0, end }, '§r', channel, variables);
    expect(
      richMessageParts(cleared?.value ?? '', channel, variables)
        .filter((part) => part.kind === 'text')
        .every((part) => Object.keys(part.style).length === 0),
    ).toBe(true);
  });

  it('inserts a formatting token at the caret without selecting or changing existing text', () => {
    expect(insertRichMessageToken('hello', { start: 2, end: 2 }, '§l', channel, variables)).toEqual(
      { value: 'he§lllo', selection: { start: 4, end: 4 } },
    );
    expect(
      insertRichMessageToken('hello', { start: 0, end: 5 }, '{server}', channel, variables)?.value,
    ).toBe('{server}');
  });

  it('checks serialized length including hidden formatting and placeholders without truncation', () => {
    const bounded = { ...channel, maxLength: 10 };
    expect(
      replaceRichMessage('abcd', { start: 4, end: 4 }, '{server}', bounded, variables),
    ).toBeUndefined();
    expect(
      insertRichMessageToken('§aabcdef', { start: 2, end: 5 }, '§c', bounded, variables),
    ).toBeUndefined();
    expect(
      replaceRichMessage('0123456789', { start: 0, end: 2 }, 'a', bounded, variables)?.value,
    ).toBe('a23456789');
  });

  it('normalizes pasted line endings and strips control characters without interpreting HTML', () => {
    expect(
      replaceRichMessage('', { start: 0, end: 0 }, '<b>hi</b>\r\nthere\u0000', channel, {})?.value,
    ).toBe('<b>hi</b>\nthere');
    expect(
      replaceRichMessage(
        '',
        { start: 0, end: 0 },
        'one\r\ntwo',
        { ...channel, multiline: false },
        {},
      )?.value,
    ).toBe('one two');
  });

  it('deletes one grapheme, preserves surrogate pairs, and skips hidden format markers', () => {
    expect(deleteRichMessage('a👩‍💻', { start: 6, end: 6 }, 'backward', channel, {})?.value).toBe(
      'a',
    );
    expect(deleteRichMessage('a\u0300', { start: 0, end: 0 }, 'forward', channel, {})?.value).toBe(
      '',
    );
    expect(deleteRichMessage('a§l', { start: 3, end: 3 }, 'backward', channel, {})?.value).toBe('');
    expect(richMessageSelection('a🚀b', { start: 2, end: 2 }, channel, {})).toEqual({
      start: 1,
      end: 3,
    });
  });

  it('supports plain channels and arbitrary formatting tokens instead of hardcoded Minecraft rules', () => {
    const plain = { id: 'plain', label, maxLength: 100, multiline: true };
    expect(richMessageParts('§aHi', plain, {})[0]?.text).toBe('§aHi');
    const custom = {
      ...plain,
      formatting: {
        tokens: [
          { value: '[red]', label, style: { color: '#ff0000' } },
          { value: '[reset]', label, reset: true },
        ],
      },
    };
    expect(insertRichMessageToken('ab', { start: 0, end: 1 }, '[red]', custom, {})?.value).toBe(
      '[red]a[reset]b',
    );
  });
});
