import { minecraftUiModule } from '@nickhosting/minecraft/ui';
import { useEffect, useRef, useState } from 'react';
import type { SkinViewer } from 'skinview3d';
import { acquirePlayerBody, playerWavePose } from './player-body-motion.js';
import './player-body.css';

/** Decorative: the surrounding card/link supplies the accessible player name. */
export function MinecraftPlayerBody({
  name,
  uuid,
  active = false,
  className = '',
}: {
  name: string;
  uuid?: string;
  active?: boolean;
  className?: string;
}) {
  const stage = useRef<HTMLSpanElement>(null);
  const [eligible, setEligible] = useState(false);
  const appearance = minecraftUiModule.playerAppearance;
  const identity =
    uuid && /^[\da-f]{8}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{12}$/i.test(uuid)
      ? uuid
      : undefined;
  const fallback = appearance?.bodyFallback ?? appearance?.fallback;
  const body = identity ? (appearance?.bodyUrl?.(identity) ?? fallback) : fallback;
  const skin = identity ? appearance?.skinUrl?.(identity) : undefined;
  const [failedBody, setFailedBody] = useState<string>();
  const [loadedBody, setLoadedBody] = useState<string>();

  useEffect(() => {
    const element = stage.current;
    if (!element || !active || !skin) {
      setEligible(false);
      return;
    }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    const update = () => setEligible(visible && !document.hidden && !motion.matches);
    const observer = new IntersectionObserver(([entry]) => {
      visible = !!entry?.isIntersecting;
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
  }, [active, skin]);

  useEffect(() => {
    const element = stage.current;
    if (!active || !eligible || !skin || !element) return;
    let stopped = false;
    let viewer: SkinViewer | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let resize: ResizeObserver | undefined;
    let objectUrl: string | undefined;
    const abort = new AbortController();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      abort.abort();
      resize?.disconnect();
      if (viewer) {
        // Upstream dispose stops RAF/textures/controls, but not model geometry or
        // composer targets. Explicitly free those and return the GPU context.
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
      canvas?.removeEventListener('webglcontextlost', stop);
      canvas?.remove();
      delete element.dataset.animated;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    const release = acquirePlayerBody(stop);
    void (async () => {
      try {
        const [library, response] = await Promise.all([
          import('skinview3d'),
          fetch(skin, { signal: abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }),
        ]);
        if (stopped) return;
        if (!response.ok) throw new Error('Skin unavailable');
        const blob = await response.blob();
        if (stopped) return;
        objectUrl = URL.createObjectURL(blob);
        const texture = new Image();
        texture.src = objectUrl;
        await texture.decode();
        if (stopped) return;
        if (texture.width !== 64 || ![32, 64].includes(texture.height))
          throw new Error('Unsupported skin dimensions');
        canvas = document.createElement('canvas');
        viewer = new library.SkinViewer({
          canvas,
          width: element.clientWidth,
          height: element.clientHeight,
          pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
          zoom: 0.8,
          enableControls: false,
          renderPaused: true,
        });
        // Pass a decoded image: no late image promise can mutate a disposed viewer.
        viewer.loadSkin(texture);
        viewer.playerObject.rotation.y = 0.2;
        viewer.animation = new library.FunctionAnimation((player, seconds) => {
          const pose = playerWavePose(seconds);
          player.skin.rightArm.rotation.x = pose.x;
          player.skin.rightArm.rotation.z = pose.z;
        });
        canvas.addEventListener('webglcontextlost', stop);
        resize = new ResizeObserver(() => {
          if (viewer && !stopped) viewer.setSize(element.clientWidth, element.clientHeight);
        });
        resize.observe(element);
        element.append(canvas);
        element.dataset.animated = 'true';
        viewer.renderPaused = false;
        URL.revokeObjectURL(objectUrl);
        objectUrl = undefined;
      } catch {
        // Decorative previews can fail (network, CORS, disabled WebGL): retain
        // the static body and never interrupt the player's management actions.
        stop();
      }
    })();
    return () => {
      stop();
      release();
    };
  }, [active, eligible, skin]);

  return (
    <span
      ref={stage}
      className={`minecraft-player-body ${className}`}
      aria-hidden="true"
      data-player={name}
    >
      <img
        src={fallback}
        alt=""
        style={{
          visibility:
            body !== fallback && loadedBody === body && failedBody !== body ? 'hidden' : undefined,
        }}
      />
      {body && body !== fallback && failedBody !== body && (
        <img
          key={body}
          src={body}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{ opacity: loadedBody === body ? 1 : 0 }}
          onLoad={() => setLoadedBody(body)}
          onError={() => setFailedBody(body)}
        />
      )}
    </span>
  );
}
