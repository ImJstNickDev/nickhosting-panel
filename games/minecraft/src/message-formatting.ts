import type { GatewayMessageDefinition } from '@nickhosting/game-sdk';

type FormattingToken = NonNullable<
  GatewayMessageDefinition['channels'][number]['formatting']
>['tokens'][number];
const colorTokens: Array<[string, string, string, string]> = [
  ['0', '#000000', 'Black', 'Nero'],
  ['1', '#0000aa', 'Dark blue', 'Blu scuro'],
  ['2', '#00aa00', 'Dark green', 'Verde scuro'],
  ['3', '#00aaaa', 'Dark cyan', 'Ciano scuro'],
  ['4', '#aa0000', 'Dark red', 'Rosso scuro'],
  ['5', '#aa00aa', 'Purple', 'Viola'],
  ['6', '#ffaa00', 'Gold', 'Oro'],
  ['7', '#aaaaaa', 'Gray', 'Grigio'],
  ['8', '#555555', 'Dark gray', 'Grigio scuro'],
  ['9', '#5555ff', 'Blue', 'Blu'],
  ['a', '#55ff55', 'Green', 'Verde'],
  ['b', '#55ffff', 'Cyan', 'Ciano'],
  ['c', '#ff5555', 'Red', 'Rosso'],
  ['d', '#ff55ff', 'Pink', 'Rosa'],
  ['e', '#ffff55', 'Yellow', 'Giallo'],
  ['f', '#ffffff', 'White', 'Bianco'],
];
export const minecraftFormattingTokens: FormattingToken[] = [
  ...colorTokens.map(([code, color, en, it]) => ({
    value: `§${code}`,
    label: { en, it },
    reset: true,
    style: { color },
  })),
  { value: '§k', label: { en: 'Obfuscated (game only)', it: 'Offuscato (solo nel gioco)' } },
  { value: '§l', label: { en: 'Bold', it: 'Grassetto' }, style: { bold: true } },
  { value: '§m', label: { en: 'Strikethrough', it: 'Barrato' }, style: { strike: true } },
  { value: '§n', label: { en: 'Underline', it: 'Sottolineato' }, style: { underline: true } },
  { value: '§o', label: { en: 'Italic', it: 'Corsivo' }, style: { italic: true } },
  { value: '§r', label: { en: 'Reset formatting', it: 'Reimposta formato' }, reset: true },
];
