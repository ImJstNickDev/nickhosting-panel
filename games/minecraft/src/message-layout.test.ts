import { describe, expect, it } from 'vitest';
import {
  alignMinecraftMotd,
  minecraftGlyphAdvance,
  minecraftMessageAlignment,
  minecraftMessageLines,
  setMinecraftMessageAlignment,
  stripMinecraftMessageAlignment,
} from './message-layout.js';
import { formattingToComponents } from './protocol-codecs.js';

const visible = (text: string) =>
  formattingToComponents(text)
    .extra.map((part) => part.text)
    .join('');
const widths = (text: string) =>
  minecraftMessageLines(
    formattingToComponents(text).extra.map((part) => ({
      text: part.text,
      style: { bold: part.bold },
    })),
    267,
    minecraftGlyphAdvance,
  );

describe('Minecraft MOTD alignment controls', () => {
  it('sets one canonical control, defaults left, and preserves template bytes otherwise', () => {
    const text = '§aHello\n{server}';
    expect(minecraftMessageAlignment(text)).toBe('left');
    expect(setMinecraftMessageAlignment(text, 'center')).toBe(`[align=center]${text}`);
    const mixed = `[ALIGN=RIGHT]${text}[align=center]`;
    expect(minecraftMessageAlignment(mixed)).toBe('center');
    expect(stripMinecraftMessageAlignment(mixed)).toBe(text);
    expect(setMinecraftMessageAlignment(mixed, 'right')).toBe(`[align=right]${text}`);
    expect(setMinecraftMessageAlignment(mixed, 'left')).toBe(text);
    expect(minecraftMessageAlignment('[align=left]')).toBe('left');
    expect(stripMinecraftMessageAlignment('[align=left]')).toBe('[align=left]');
  });
  it('uses measured English/Italian glyph advances, with explicit approximation elsewhere', () => {
    expect([...'Ai lIèìÀ’—Æ'].map(minecraftGlyphAdvance)).toEqual([
      6, 2, 4, 3, 4, 6, 3, 6, 3, 9, 10,
    ]);
    expect(minecraftGlyphAdvance('😀')).toBe(6);
    expect(minecraftGlyphAdvance('你')).toBe(6);
  });
  it('pads per wrapped line with neutral four-pixel spaces and leaves left alignment unchanged', () => {
    const left = '§a§lHello\n\nWorld';
    expect(alignMinecraftMotd(left, 'left')).toBe(left);
    expect(alignMinecraftMotd('AAA', 'center')).toBe(`§r${' '.repeat(31)}AAA`);
    expect(alignMinecraftMotd('AAA', 'right')).toBe(`§r${' '.repeat(62)}AAA`);
    const wrapped = alignMinecraftMotd('A'.repeat(45), 'right');
    expect(wrapped).toBe(`§r${'A'.repeat(44)}\n§r${' '.repeat(65)}A`);
    expect(widths(wrapped)).toHaveLength(2);
  });
  it('preserves color and decorations across wraps while keeping padding unbolded', () => {
    const aligned = alignMinecraftMotd(`§a§l${'A'.repeat(39)}\n§oB§rC`, 'right');
    expect(aligned).toBe(
      `§r§a§l${'A'.repeat(38)}\n§r${' '.repeat(65)}§a§lA\n§r${' '.repeat(63)}§a§l§oB§rC`,
    );
    expect(
      formattingToComponents(aligned)
        .extra.filter((part) => /^ +$/.test(part.text))
        .every((part) => !part.bold),
    ).toBe(true);
    expect(widths(aligned)).toHaveLength(3);
    expect(visible(alignMinecraftMotd('§lA\n\nB\n', 'center')).split('\n')).toHaveLength(4);
  });
  it('bounds expansion and padding without splitting supplementary Unicode characters', () => {
    const aligned = alignMinecraftMotd('😀\n'.repeat(600), 'right');
    expect(aligned.length).toBeLessThanOrEqual(1024);
    expect(aligned.isWellFormed()).toBe(true);
    expect(alignMinecraftMotd(`${'A'.repeat(1023)}😀`, 'left')).toBe('A'.repeat(1023));
    expect(alignMinecraftMotd('[align=right]', 'left')).toBe('[align=right]');
  });
});
