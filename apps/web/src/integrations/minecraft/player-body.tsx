import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { useEffect, useRef, useState } from 'react';
import type { SkinViewer } from 'skinview3d';
import { playerBodyRenderers, playerWavePose } from './player-body-motion.js';
import './player-body.css';

type Renderer = typeof import('skinview3d');
type Variant = 'bust' | 'full';
const frames = { bust: { width: 144, height: 240 }, full: { width: 120, height: 180 } };
// Data URLs contain only a small rendered preview; bound the session cache.
const stills = new Map<string, string>();
function remember(key: string, image: string) {
  stills.delete(key);
  stills.set(key, image);
  if (stills.size > 64) stills.delete(stills.keys().next().value as string);
}
function dispose(viewer: SkinViewer) {
  viewer.scene.traverse((object) => {
    const mesh = object as typeof object & {
      geometry?: { dispose(): void };
      material?: { dispose(): void } | { dispose(): void }[];
    };
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material))
      mesh.material.forEach((material) => {
        material.dispose();
      });
    else mesh.material?.dispose();
  });
  viewer.composer.dispose();
  viewer.fxaaPass.material.dispose();
  viewer.dispose();
  viewer.renderer.forceContextLoss();
}
function createViewer(library: Renderer, texture: HTMLImageElement, variant: Variant) {
  const canvas = document.createElement('canvas');
  const viewer = new library.SkinViewer({
    canvas,
    ...frames[variant],
    pixelRatio: 2,
    zoom: 0.95,
    enableControls: false,
    renderPaused: true,
  });
  viewer.loadSkin(texture);
  // Let the CSS frame fit narrow inventory slots without changing the camera.
  canvas.style.removeProperty('width');
  canvas.style.removeProperty('height');
  // The same three-quarter camera and model pose are used for stills and animation.
  // Keep the viewing angle outside the animated player: assigning an animation
  // resets playerObject.rotation in skinview3d.
  viewer.playerWrapper.rotation.y = 0.48;
  viewer.camera.position.y = 3;
  viewer.camera.lookAt(0, 0, 0);
  return viewer;
}

/** Decorative: the surrounding card/link supplies the accessible player name. */
export function MinecraftPlayerBody({
  name,
  uuid,
  active = false,
  variant = 'full',
  className = '',
}: {
  name: string;
  uuid?: string;
  active?: boolean;
  variant?: Variant;
  className?: string;
}) {
  const stage = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  const [motionAllowed, setMotionAllowed] = useState(false);
  const [prepared, setPrepared] = useState<{
    skin: string;
    texture: HTMLImageElement;
    library: Renderer;
  }>();
  const [still, setStill] = useState<{ key: string; image: string }>();
  const appearance = minecraftUiModule.playerAppearance;
  const identity =
    uuid && /^[\da-f]{8}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{12}$/i.test(uuid)
      ? uuid
      : undefined;
  const fallback = appearance?.bodyFallback ?? appearance?.fallback;
  const skin = identity ? appearance?.skinUrl?.(identity) : undefined;
  const cacheKey = `${skin}:${variant}`;
  const image = still?.key === cacheKey ? still.image : stills.get(cacheKey);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let intersecting = false;
    const update = () => {
      setVisible(intersecting && !document.hidden);
      setMotionAllowed(!motion.matches);
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = !!entry?.isIntersecting;
      update();
    });
    observer.observe(element);
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  useEffect(() => {
    if (!visible || !skin) return;
    const abort = new AbortController();
    let objectUrl: string | undefined;
    void (async () => {
      try {
        const [library, response] = await Promise.all([
          import('skinview3d'),
          fetch(skin, { signal: abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }),
        ]);
        if (abort.signal.aborted) return;
        if (!response.ok) throw new Error('Skin unavailable');
        const blob = await response.blob();
        if (abort.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        const texture = new Image();
        texture.src = objectUrl;
        await texture.decode();
        if (abort.signal.aborted) return;
        if (texture.width !== 64 || ![32, 64].includes(texture.height))
          throw new Error('Unsupported skin dimensions');
        setPrepared({ skin, texture, library });
      } catch {
        // Retain the authored fallback when the skin or rendering cannot load.
      } finally {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = undefined;
      }
    })();
    return () => {
      abort.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [visible, skin]);

  useEffect(() => {
    if (!visible || !skin || prepared?.skin !== skin || image) return;
    return playerBodyRenderers.snapshot(() => {
      let viewer: SkinViewer | undefined;
      try {
        viewer = createViewer(prepared.library, prepared.texture, variant);
        viewer.render();
        const capture = viewer.canvas.toDataURL('image/png');
        remember(cacheKey, capture);
        setStill({ key: cacheKey, image: capture });
      } catch {
        // WebGL may be unavailable; the local body remains visible.
      } finally {
        if (viewer) dispose(viewer);
      }
    });
  }, [visible, skin, prepared, image, variant, cacheKey]);

  useEffect(() => {
    const element = stage.current;
    if (!active || !visible || !motionAllowed || !skin || prepared?.skin !== skin || !element)
      return;
    let stopped = false;
    let viewer: SkinViewer | undefined;
    let release = () => {};
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (viewer) {
        viewer.canvas.removeEventListener('webglcontextlost', stop);
        viewer.canvas.remove();
        dispose(viewer);
      }
      delete element.dataset.animated;
      release();
    };
    release = playerBodyRenderers.acquire(stop);
    try {
      viewer = createViewer(prepared.library, prepared.texture, variant);
      // Capture before the first wave frame, so exiting hover always restores
      // exactly the same projection instead of switching to a provider's render.
      viewer.render();
      const capture = viewer.canvas.toDataURL('image/png');
      remember(cacheKey, capture);
      setStill({ key: cacheKey, image: capture });
      viewer.animation = new prepared.library.FunctionAnimation((player, seconds) => {
        const pose = playerWavePose(seconds);
        player.skin.rightArm.rotation.x = pose.x;
        player.skin.rightArm.rotation.z = pose.z;
      });
      viewer.canvas.addEventListener('webglcontextlost', stop);
      element.append(viewer.canvas);
      element.dataset.animated = 'true';
      viewer.renderPaused = false;
    } catch {
      stop();
    }
    return stop;
  }, [active, visible, motionAllowed, skin, prepared, variant, cacheKey]);

  return (
    <span
      ref={stage}
      className={`minecraft-player-body minecraft-player-body--${variant} ${className}`}
      aria-hidden="true"
      data-player={name}
      data-ready={!!image}
    >
      <img src={image ?? fallback} alt="" />
    </span>
  );
}
