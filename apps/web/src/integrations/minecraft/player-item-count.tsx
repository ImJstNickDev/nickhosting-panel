import { useEffect, useRef } from 'react';
import { minecraftPlayerHudAsset } from './player-item-assets.js';

// Authored bitmap fallback when the optional local client font is unavailable.
const fallback = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
];
type Glyph = readonly number[];
const glyphs = new Map<string, Promise<Glyph>>();

/** Strip the XP fill from its outline; stack digits have only a lower-right shadow. */
export function stackGlyphFromXp(pixels: Uint8ClampedArray): number[] {
  if (pixels.length !== 7 * 9 * 4) throw new Error('invalid_bitmap_glyph');
  return Array.from({ length: 35 }, (_, index) => {
    const at = ((Math.floor(index / 5) + 1) * 7 + (index % 5) + 1) * 4;
    return pixels[at] === 128 && pixels[at + 1] === 255 && pixels[at + 2] === 32
      ? (pixels[at + 3] ?? 0)
      : 0;
  });
}

function glyph(digit: string): Promise<Glyph> {
  const existing = glyphs.get(digit);
  if (existing) return existing;
  const load = async (): Promise<Glyph> => {
    const source = minecraftPlayerHudAsset(`experience_digit_${digit}`);
    if (source) {
      try {
        const image = new Image();
        image.src = source;
        await image.decode();
        if (image.naturalWidth !== 7 || image.naturalHeight !== 9)
          throw new Error('invalid_bitmap_glyph');
        const canvas = document.createElement('canvas');
        canvas.width = 7;
        canvas.height = 9;
        const context = canvas.getContext('2d');
        if (context) {
          context.imageSmoothingEnabled = false;
          context.drawImage(image, 0, 0);
          return stackGlyphFromXp(context.getImageData(0, 0, 7, 9).data);
        }
      } catch {
        // Optional local artwork may be absent; keep the actual quantity legible.
      }
    }
    return (fallback[Number(digit)] ?? ['00000'])
      .join('')
      .split('')
      .map(Number)
      .map((v) => v * 255);
  };
  const result = load();
  glyphs.set(digit, result);
  return result;
}

export function MinecraftItemCount({ count }: { count: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const digits = String(count);
  useEffect(() => {
    let active = true;
    if (count <= 1) return;
    void Promise.all([...digits].map(glyph)).then((masks) => {
      const target = canvas.current;
      const context = target?.getContext('2d');
      if (!active || !target || !context) return;
      context.clearRect(0, 0, target.width, target.height);
      context.imageSmoothingEnabled = false;
      for (const [color, offset] of [
        ['#3f3f3f', 1],
        ['#ffffff', 0],
      ] as const) {
        context.fillStyle = color;
        for (const [index, mask] of masks.entries()) {
          for (let pixel = 0; pixel < mask.length; pixel++) {
            const alpha = mask[pixel] ?? 0;
            if (!alpha) continue;
            context.globalAlpha = alpha / 255;
            context.fillRect(
              index * 6 + (pixel % 5) + offset,
              Math.floor(pixel / 5) + offset,
              1,
              1,
            );
          }
        }
      }
      context.globalAlpha = 1;
    });
    return () => {
      active = false;
    };
  }, [count, digits]);
  if (count <= 1) return null;
  return (
    <canvas
      ref={canvas}
      className="minecraft-item-count"
      width={digits.length * 6}
      height={8}
      style={{ width: `calc(${digits.length * 6}px * var(--minecraft-inventory-pixel, 2))` }}
      aria-hidden="true"
      tabIndex={-1}
    />
  );
}
