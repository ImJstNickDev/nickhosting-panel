export const minecraftMotdWidth = 267;
export const minecraftMotdLines = 2;
export type MinecraftMessageAlignment = 'left' | 'center' | 'right';

const alignmentControl = /\[align=(center|right)\]/gi;

/** Integration controls belong to templates, never to expanded variable values. */
export function minecraftMessageAlignment(template: string): MinecraftMessageAlignment {
  let alignment: MinecraftMessageAlignment = 'left';
  for (const match of template.matchAll(alignmentControl))
    alignment = match[1]?.toLowerCase() === 'right' ? 'right' : 'center';
  return alignment;
}
export function stripMinecraftMessageAlignment(template: string): string {
  return template.replace(alignmentControl, '');
}
export function setMinecraftMessageAlignment(
  template: string,
  alignment: MinecraftMessageAlignment,
): string {
  const text = stripMinecraftMessageAlignment(template);
  return alignment === 'left' ? text : `[align=${alignment}]${text}`;
}

/** Scalar advance measurements from locally prepared Vanilla 26.1 bitmap providers:
 * client SHA-1 191771837687b766537a8c4607cb6fad79c533a1, optional preview WOFF SHA-256
 * 8f804f1b68a455f7f2dde765e961a4e13a0e81ce7b22fedf79e6c6c22577d89d. Measured hmtx
 * advances at 9 GUI pixels (900 font units/em). No glyph artwork/font is included.
 * ASCII/Latin-1 and common English/Italian punctuation have measured advances;
 * other glyphs deliberately use an approximate 6-pixel advance. Resource packs,
 * Unicode fallback fonts and older clients may differ from this reference. */
const advanceGroups: ReadonlyArray<readonly [number, string]> = [
  [2, "!',.:;i|¡¦·"],
  [3, '`l´ìí‘’'],
  [4, ' "()*I[]t{}¨\u00ad¹ÌÍÎÏîï'],
  [5, '<>fkª°²³º“”'],
  [
    6,
    '#$%&+-/0123456789=?ABCDEFGHJKLMNOPQRSTUVWXYZ\\^_abcdeghjmnopqrsuvwxyz¢£¥§¬¯±µ¿ÀÁÂÃÄÅÇÈÉÊËÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåçèéêëðñòóôõö÷øùúûüýþÿ',
  ],
  [7, '@~«¶»Ð–'],
  [8, '¤©®¼½¾…'],
  [9, '—'],
  [10, 'Ææ'],
];
const advances = new Map(
  advanceGroups.flatMap(([width, characters]) =>
    [...characters].map((character) => [character, width] as const),
  ),
);
export function minecraftGlyphAdvance(character: string): number {
  return advances.get(character) ?? 6;
}

type Glyph = { character: string; width: number };

/** Vanilla StringSplitter space/newline wrapping semantics, preserving glyph data
 * so callers can retain styling through both explicit and automatic line breaks. */
function wrappedGlyphs<T extends Glyph>(glyphs: T[], width: number): T[][] {
  if (!glyphs.length) return [];
  const limit = Math.max(1, width);
  const lines: T[][] = [];
  let start = 0;
  while (start < glyphs.length) {
    let end = start;
    let used = 0;
    let space = -1;
    let next = glyphs.length;
    for (; end < glyphs.length; end++) {
      const glyph = glyphs[end];
      if (!glyph) break;
      if (glyph.character === '\n') {
        next = end + 1;
        break;
      }
      if (glyph.character === ' ') space = end;
      if (used + glyph.width > limit && used > 0) {
        if (space >= start) {
          end = space;
          next = space + 1;
        } else next = end;
        break;
      }
      used += glyph.width;
    }
    lines.push(glyphs.slice(start, end));
    start = next;
  }
  if (glyphs.at(-1)?.character === '\n') lines.push([]);
  return lines;
}

/** Structural run input keeps this helper independent of the WebPanel and backend. */
export function minecraftMessageLines(
  runs: ReadonlyArray<{ text: string; style: { bold?: boolean } }>,
  width: number,
  advance: (character: string) => number,
): string[] {
  const glyphs = runs.flatMap((run) =>
    [...run.text].map((character) => ({
      character,
      width: character === '\n' ? 0 : advance(character) + (run.style.bold ? 1 : 0),
    })),
  );
  return wrappedGlyphs(glyphs, width).map((line) => line.map((glyph) => glyph.character).join(''));
}

/** Title/reason padding and the standard return button in DisconnectedScreen. */
export function minecraftDisconnectHeight(lines: number) {
  return 73 + 9 * lines;
}

export function boundedMinecraftMessage(text: string): string {
  const bounded = text.slice(0, 1024);
  const last = bounded.charCodeAt(bounded.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? bounded.slice(0, -1) : bounded;
}

/** Pads already-expanded MOTD text with neutral ASCII spaces. Does not interpret
 * template alignment controls. Left alignment preserves the historical bytes. */
export function alignMinecraftMotd(text: string, alignment: MinecraftMessageAlignment): string {
  const bounded = boundedMinecraftMessage(text);
  if (alignment === 'left') return bounded;
  const glyphs: Array<Glyph & { format: string }> = [];
  const characters = [...bounded];
  let color = '';
  const decorations = new Set<string>();
  for (let i = 0; i < characters.length; i++) {
    const character = characters[i] ?? '';
    const code = character === '§' ? characters[i + 1]?.toLowerCase() : undefined;
    if (code && /^[0-9a-fk-or]$/.test(code)) {
      i++;
      if (code === 'r' || /^[0-9a-f]$/.test(code)) {
        decorations.clear();
        color = code === 'r' ? '' : `§${code}`;
      } else decorations.add(code);
      continue;
    }
    glyphs.push({
      character,
      width:
        character === '\n' ? 0 : minecraftGlyphAdvance(character) + (decorations.has('l') ? 1 : 0),
      format: color + [...decorations].map((decoration) => `§${decoration}`).join(''),
    });
  }
  const lines = wrappedGlyphs(glyphs, minecraftMotdWidth);
  const result = lines
    .map((line) => {
      if (!line.length) return '';
      const width = line.reduce((sum, glyph) => sum + glyph.width, 0);
      const padding = Math.max(
        0,
        Math.floor((minecraftMotdWidth - width) / (alignment === 'center' ? 8 : 4)),
      );
      // Each physical line starts with neutral space metrics even after a bold line.
      let result = `§r${' '.repeat(padding)}`;
      let active = '';
      for (const glyph of line) {
        if (glyph.format !== active) {
          result += `${active ? '§r' : ''}${glyph.format}`;
          active = glyph.format;
        }
        result += glyph.character;
      }
      return result;
    })
    .join('\n');
  return boundedMinecraftMessage(result);
}
