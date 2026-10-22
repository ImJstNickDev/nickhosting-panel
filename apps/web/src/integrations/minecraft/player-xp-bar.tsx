import { useEffect, useRef, useState } from 'react';

type XpTextures = {
  background?: HTMLImageElement | undefined;
  foreground?: HTMLImageElement | undefined;
};

async function loadTexture(source: string | undefined): Promise<HTMLImageElement | undefined> {
  if (!source) return undefined;
  const image = new Image();
  image.src = source;
  try {
    await image.decode();
    return image;
  } catch {
    return undefined;
  }
}

// Resample on the Minecraft pixel grid first, preserving each one-pixel endcap.
// Scaling this resulting bitmap keeps its pixels the same size as the XP digits.
function drawTexture(context: CanvasRenderingContext2D, image: HTMLImageElement, width: number) {
  if (width < 3 || image.naturalWidth < 3) {
    context.drawImage(image, 0, 0, width, 5);
    return;
  }
  context.drawImage(image, 0, 0, 1, image.naturalHeight, 0, 0, 1, 5);
  context.drawImage(image, 1, 0, image.naturalWidth - 2, image.naturalHeight, 1, 0, width - 2, 5);
  context.drawImage(image, image.naturalWidth - 1, 0, 1, image.naturalHeight, width - 1, 0, 1, 5);
}

export function PlayerXpBar({
  progress,
  background,
  foreground,
}: {
  progress: number;
  background?: string | undefined;
  foreground?: string | undefined;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [textures, setTextures] = useState<XpTextures>({});

  useEffect(() => {
    let active = true;
    setTextures({});
    void Promise.all([loadTexture(background), loadTexture(foreground)]).then(
      ([backgroundTexture, foregroundTexture]) => {
        if (active) setTextures({ background: backgroundTexture, foreground: foregroundTexture });
      },
    );
    return () => {
      active = false;
    };
  }, [background, foreground]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return;

    const draw = () => {
      const configuredUnit = Number.parseFloat(
        getComputedStyle(canvas).getPropertyValue('--minecraft-xp-pixel'),
      );
      const unit = Number.isFinite(configuredUnit) && configuredUnit > 0 ? configuredUnit : 2;
      const width = Math.max(1, Math.floor(parent.getBoundingClientRect().width / unit));
      canvas.width = width;
      canvas.height = 5;
      canvas.style.width = `${width * unit}px`;
      canvas.style.height = `${5 * unit}px`;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.imageSmoothingEnabled = false;

      if (textures.background) drawTexture(context, textures.background, width);
      else {
        context.fillStyle = '#08120c';
        context.fillRect(0, 0, width, 5);
        context.fillStyle = '#263a30';
        context.fillRect(1, 1, Math.max(0, width - 2), 3);
      }

      const fraction = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
      const filled = Math.floor(fraction * width);
      context.save();
      context.beginPath();
      context.rect(0, 0, filled, 5);
      context.clip();
      if (textures.foreground) drawTexture(context, textures.foreground, width);
      else {
        context.fillStyle = '#173b08';
        context.fillRect(0, 0, width, 5);
        context.fillStyle = '#80ff20';
        context.fillRect(1, 1, Math.max(0, width - 2), 3);
      }
      context.restore();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(parent);
    const container = parent.closest('.minecraft-players');
    if (container && container !== parent) observer.observe(container);
    return () => observer.disconnect();
  }, [progress, textures]);

  return (
    <canvas
      ref={canvasRef}
      className="minecraft-player-xp-track"
      aria-hidden="true"
      tabIndex={-1}
      width={182}
      height={5}
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
