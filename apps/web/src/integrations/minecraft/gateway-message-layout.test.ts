import { describe, expect, it } from 'vitest';
import { messagePreview } from '../../features/gateway-message-preview.js';
import { minecraftDisconnectHeight, minecraftMessageLines } from './gateway-message-layout.js';

const advance = (character: string) => (character === ' ' ? 4 : character === 'i' ? 2 : 6);
const lines = (text: string, width: number, bold = false) =>
  minecraftMessageLines([{ text, style: { bold } }], width, advance);

describe('Vanilla 26.1 message layout guides', () => {
  it('fits exact advances and wraps before overflow, without ellipsis', () => {
    expect(lines('AAA', 18)).toEqual(['AAA']);
    expect(lines('AAA', 17)).toEqual(['AA', 'A']);
    expect(lines('A', 1)).toEqual(['A']);
    expect(lines('iiiiii', 12)).toEqual(['iiiiii']);
    expect(lines('AAA', 18, true)).toEqual(['AA', 'A']);
  });
  it('prefers ASCII spaces, consumes separators and preserves explicit empty lines', () => {
    expect(lines('AA AA', 25)).toEqual(['AA', 'AA']);
    expect(lines('AA\u00a0AA', 25)).toEqual(['AA\u00a0A', 'A']);
    expect(lines('A\n\nB\n', 267)).toEqual(['A', '', 'B', '']);
    expect(lines('', 267)).toEqual([]);
  });
  it('counts expanded variables and formatting advances, never formatting codes', () => {
    const channel = {
      id: 'motd',
      label: { en: 'MOTD', it: 'MOTD' },
      maxLength: 512,
      multiline: true,
      formatting: {
        tokens: [{ value: '§l', label: { en: 'Bold', it: 'Grassetto' }, style: { bold: true } }],
      },
    };
    expect(
      minecraftMessageLines(messagePreview('§l{server}', { server: 'AAA' }, channel), 18, advance),
    ).toEqual(['AA', 'A']);
    expect(lines('A\nB\nC', 267)).toHaveLength(3);
  });
  it('does not split Unicode codepoints or impose a disconnect line cap', () => {
    expect(lines('😀😀', 6)).toEqual(['😀', '😀']);
    expect(minecraftDisconnectHeight(50)).toBe(523);
  });
});
